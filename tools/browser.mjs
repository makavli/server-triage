// A headless Chrome or Edge driven over the DevTools protocol, with no dependency: the browser test and the
// screenshots use it. Set BROWSER_BIN to pick the browser; otherwise the usual install paths are tried.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const cap = (ms) => delay(ms, undefined, { ref: false }); // a time limit that never keeps the process alive

export function findBrowser() {
  if (process.env.BROWSER_BIN) return process.env.BROWSER_BIN;
  const win = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
    .flatMap((p) => [join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')]);
  const mac = ['Google Chrome', 'Microsoft Edge', 'Chromium'].map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`);
  const linux = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].map((n) => `/usr/bin/${n}`);
  const list = process.platform === 'win32' ? win : process.platform === 'darwin' ? mac : linux;
  return list.find((p) => existsSync(p)) ?? null;
}

// Removes a profile folder; Windows holds its files a moment after the browser exits.
async function remove(profile) {
  for (let i = 0; i < 20; i++) {
    try { rmSync(profile, { recursive: true, force: true }); return; } catch { await delay(250); }
  }
}

// Starts the browser on a fresh profile that is deleted on close. The DevTools protocol runs over a pipe (fds 3 and
// 4, one JSON message per NUL), not a port: no other user of the machine can drive it. Each page it opens collects
// the errors its console, its scripts and its security policy report.
export async function launch() {
  const bin = findBrowser();
  if (!bin) throw new Error('No Chrome or Edge found: set BROWSER_BIN to one.');
  if (!existsSync(bin)) throw new Error(`No browser at ${bin}: fix BROWSER_BIN.`);
  const profile = mkdtempSync(join(tmpdir(), 'triage-browser-'));
  const args = ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', 'about:blank'];
  if (process.platform === 'linux' && process.env.GITHUB_ACTIONS) args.push('--no-sandbox'); // GitHub's Linux runners block the sandbox's user namespaces
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/TOKEN|SECRET|PASSWORD/i.test(k))); // a page it opens never meets a credential
  const proc = spawn(bin, args, { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  const [input, output] = [proc.stdio[3], proc.stdio[4]];
  let log = ''; // the browser's own last words, for a start that fails
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => { log = (log + chunk).slice(-3000); });

  let id = 0;
  let gone = null;
  const pending = new Map();
  const listeners = new Set();
  const end = (err) => {
    gone ??= err;
    for (const p of pending.values()) p.fail(gone);
    pending.clear();
  };
  proc.once('error', (e) => end(new Error(`cannot start ${bin}: ${e.message}`)));
  proc.once('exit', (code) => end(new Error(`the browser exited (${code})`)));
  input.on('error', () => {}); // a write after the browser is gone: `end` reports it
  output.setEncoding('utf8');
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk;
    for (let k; (k = buffer.indexOf('\0')) >= 0; buffer = buffer.slice(k + 1)) {
      const msg = JSON.parse(buffer.slice(0, k));
      if (msg.id) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p?.fail(new Error(`${p.method}: ${msg.error.message}`));
        else p?.ok(msg.result);
      } else for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    if (gone) return fail(gone);
    pending.set(++id, { ok, fail, method });
    input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
  });

  try {
    // A cold CI machine can take long over a first start.
    await Promise.race([send('Browser.getVersion'), cap(60000).then(() => { throw new Error('timed out waiting for the browser to start'); })]);
  } catch (e) {
    proc.kill();
    if (proc.exitCode === null && !gone) await Promise.race([new Promise((ok) => proc.once('exit', ok)), cap(5000)]);
    await remove(profile);
    throw new Error(`${e.message} (${bin})${log.trim() ? `\nIts stderr ends with:\n${log.trim()}` : ''}`);
  }

  async function page({ width = 1280, height = 860 } = {}) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (method, params) => send(method, params, sessionId);
    const errors = [];
    const waiters = new Set();
    const on = (msg) => {
      if (msg.sessionId !== sessionId) return;
      const p = msg.params;
      if (msg.method === 'Runtime.exceptionThrown') errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') errors.push(p.args.map((a) => a.value ?? a.description).join(' '));
      if (msg.method === 'Log.entryAdded' && p.entry.level === 'error') errors.push(`${p.entry.source}: ${p.entry.text} ${p.entry.url ?? ''}`.trim());
      for (const w of waiters) if (w.method === msg.method) { waiters.delete(w); w.ok(p); }
    };
    listeners.add(on);
    const next = (method, ms = 20000) => new Promise((ok, fail) => {
      const w = { method, ok };
      waiters.add(w);
      setTimeout(() => { if (waiters.delete(w)) fail(new Error(`timed out waiting for ${method}`)); }, ms).unref();
    });
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Log.enable');
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await s('Emulation.setFocusEmulationEnabled', { enabled: true });

    async function evaluate(expression) {
      const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    }
    async function load(start, ready = true) {
      const loaded = next('Page.loadEventFired');
      await start();
      await loaded;
      if (!ready) return true; // another site's page: it sets no ready flag
      for (let i = 0; i < 100; i++, await delay(50)) if (await evaluate("document.documentElement.dataset.ready === '1'")) return true;
      return false; // the script never ran
    }
    return {
      send: s,
      errors,
      evaluate,
      goto: (url, ready) => load(() => s('Page.navigate', { url }), ready),
      reload: () => load(() => s('Page.reload', { ignoreCache: false })),
      async click(selector, n = 0) { // a real mouse click on the nth match
        const box = await evaluate(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${n}]; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        for (const type of ['mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 });
      },
      async key(key, code = key, keyCode = 0) {
        for (const type of ['keyDown', 'keyUp']) await s('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, text: type === 'keyDown' && key.length === 1 ? key : undefined });
      },
      type: (text) => s('Input.insertText', { text }),
      screenshot: async () => Buffer.from((await s('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
    };
  }

  async function close() {
    try { await Promise.race([send('Browser.close'), cap(3000)]); } catch { /* already gone */ }
    if (proc.exitCode === null) await Promise.race([new Promise((ok) => proc.once('exit', ok)), cap(5000)]);
    if (proc.exitCode === null) proc.kill();
    await remove(profile);
  }
  return { page, close, name: bin };
}
