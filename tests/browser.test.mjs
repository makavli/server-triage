// The app in a real browser, headless: opened from disk it searches and copies with no error; served over http it
// is installable, caches itself and still opens with the server gone. Skipped where no Chrome or Edge is installed,
// unless REQUIRE_BROWSER is set (CI sets it).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CACHED } from '../tools/build.mjs';
import { findBrowser, launch } from '../tools/browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!findBrowser() && process.env.REQUIRE_BROWSER) throw new Error('REQUIRE_BROWSER is set and no Chrome or Edge was found: set BROWSER_BIN');
const skip = findBrowser() ? false : 'no Chrome or Edge here (set BROWSER_BIN to one)';
const timeout = 90_000;

let browser;
before(async () => { if (!skip) browser = await launch(); });
after(async () => { await browser?.close(); });

async function until(page, expression, what) {
  for (let i = 0; i < 100; i++, await delay(50)) if (await page.evaluate(expression)) return;
  assert.fail(`timed out waiting for ${what}`);
}

const SHOWN = "[...document.querySelectorAll('[data-in]')].filter((e) => !e.closest('[hidden]'))";

test('opened from disk, it searches and copies, with no error', { skip, timeout }, async () => {
  const page = await browser.page();
  assert.ok(await page.goto(pathToFileURL(join(root, 'index.html')).href), 'the page script never ran');
  const total = await page.evaluate("document.querySelectorAll('[data-in]').length");

  await page.click('#q');
  await page.type('postgresql lock');
  const hits = await page.evaluate(`${SHOWN}.map((e) => (e.dataset.in + ' ' + e.textContent).toLowerCase())`);
  assert.ok(hits.length > 0 && hits.length < total, `${hits.length} of ${total} shown`);
  for (const h of hits) assert.ok(h.includes('postgresql') && h.includes('lock'), h.slice(0, 80));
  assert.equal(await page.evaluate("document.querySelector('#status').textContent"), `${hits.length} entries match`);

  await page.key('Escape', 'Escape', 27);
  assert.equal(await page.evaluate(`${SHOWN}.length`), total, 'Escape shows every entry again');
  await page.type('zzqx nothing');
  assert.equal(await page.evaluate("document.querySelector('#none').hidden"), false, 'no match says so');
  await page.key('Escape', 'Escape', 27);

  await page.evaluate('document.activeElement.blur()');
  await page.key('/', 'Slash', 191);
  assert.deepEqual(await page.evaluate("[document.activeElement.id, document.querySelector('#q').value]"), ['q', ''], '/ moves to the search box');

  // A stand-in clipboard: the test never touches the real one.
  await page.evaluate("window.copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.copied.push(t); } } }); true");
  const [first, second, third] = await page.evaluate("[...document.querySelectorAll('code.k')].slice(0, 3).map((k) => k.textContent)");
  await page.click('code.k');
  await until(page, "document.querySelector('#toast').textContent === 'Copied'", 'the toast');
  await page.evaluate("document.querySelectorAll('code.k')[1].focus()");
  await page.key('Enter', 'Enter', 13);
  await until(page, 'window.copied.length === 2', 'the copy by keyboard');
  assert.deepEqual(await page.evaluate('window.copied'), [first, second]);

  await page.evaluate("navigator.clipboard.writeText = async () => { throw new Error('denied'); }; document.querySelector('#toast').textContent = ''; true");
  await page.click('code.k', 2);
  await until(page, "document.querySelector('#toast').textContent.startsWith('Selected')", 'the fallback');
  assert.equal(await page.evaluate('String(getSelection())'), third, 'a refused clipboard selects the command instead');

  assert.deepEqual(page.errors, []);

  // The request path and the section bar scroll sideways on purpose: what sits inside them is left out.
  const phone = await browser.page({ width: 390, height: 844 });
  assert.ok(await phone.goto(pathToFileURL(join(root, 'index.html')).href), 'at phone width, the page script never ran');
  const wide = await phone.evaluate("[...document.querySelectorAll('header *:not(.path *), footer *, main *, .bar *:not(.toc *)')].filter((e) => { const r = e.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map((e) => e.outerHTML.slice(0, 80))");
  assert.deepEqual(wide, [], 'at phone width nothing runs past the screen');
  assert.deepEqual(phone.errors, []);

  // Paper is white: a dark system theme darkens the screen, never the print.
  const ink = async (media) => {
    await phone.send('Emulation.setEmulatedMedia', { media, features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    return phone.evaluate("[getComputedStyle(document.body).color, getComputedStyle(document.querySelector('code.k')).backgroundColor]");
  };
  assert.deepEqual(await ink('screen'), ['rgb(227, 230, 233)', 'rgb(29, 34, 40)'], 'the dark palette on screen');
  assert.deepEqual(await ink('print'), ['rgb(28, 33, 39)', 'rgb(233, 236, 230)'], 'the light palette in print');
});

test('served over http, it installs, caches itself and opens offline', { skip, timeout }, async () => {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const served = new Set([...CACHED.filter((f) => f !== './'), 'sw.js']);
  const base = '/server-triage/'; // where GitHub Pages serves it
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = path === base ? 'index.html' : path.startsWith(base) ? path.slice(base.length) : '';
    if (!served.has(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(file)] }).end(readFileSync(join(root, file)));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await browser.page();
    assert.ok(await page.goto(origin + base), 'the page script never ran');
    await page.evaluate('navigator.serviceWorker.ready.then(() => true)');
    await until(page, 'navigator.serviceWorker.controller !== null', 'the worker to take the page');
    const cached = await page.evaluate("caches.keys().then((k) => caches.open(k.find((n) => n.startsWith('triage-')))).then((c) => c.keys()).then((r) => r.map((q) => new URL(q.url).pathname).sort())");
    assert.deepEqual(cached, CACHED.map((f) => base + (f === './' ? '' : f)).sort());
    assert.deepEqual((await page.send('Page.getInstallabilityErrors')).installabilityErrors, []);
    assert.deepEqual((await page.send('Page.getAppManifest')).errors, []);
    const total = await page.evaluate("document.querySelectorAll('[data-in]').length");

    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    assert.ok(await page.reload(), 'offline, the page script never ran');
    assert.equal(await page.evaluate("document.querySelectorAll('[data-in]').length"), total, 'offline, the whole sheet opens');
    // The page may not fetch (its policy has no connect-src), so the icons are loaded as images and the manifest is
    // read by the browser.
    const icons = CACHED.filter((f) => f.startsWith('icons/'));
    assert.deepEqual(await page.evaluate(`Promise.all(${JSON.stringify(icons)}.map((f) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(true); i.onerror = () => ok(f); i.src = f; })))`), icons.map(() => true));
    const manifest = await page.send('Page.getAppManifest');
    assert.deepEqual(manifest.errors, []);
    assert.match(manifest.data ?? '', /"name": "Server Triage Sheet"/, 'offline, the manifest comes from the cache');
    assert.deepEqual(page.errors, []);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
