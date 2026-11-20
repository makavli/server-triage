// The app in a real browser, headless: opened from disk it searches and copies with no error; served over http it
// is installable, caches itself and still opens with the server gone. Skipped where no Chrome or Edge is installed,
// unless REQUIRE_BROWSER is set (CI sets it).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CACHED } from '../tools/build.mjs';
import { findBrowser, launch } from '../tools/browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!findBrowser() && process.env.REQUIRE_BROWSER) throw new Error('REQUIRE_BROWSER is set and no Chrome or Edge was found: set BROWSER_BIN');
const skip = findBrowser() ? false : 'no Chrome or Edge here (set BROWSER_BIN to one)';
const timeout = 90_000;

// A browser and a profile per test: nothing one test stores (or an open tab writes later) reaches the next.
let browser;
beforeEach(async () => { if (!skip) browser = await launch(); });
afterEach(async () => { await browser?.close(); });

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
  // The same message twice is said twice: the live region empties, then fills again.
  await page.evaluate("window.said = []; new MutationObserver(() => window.said.push(document.querySelector('#status').textContent)).observe(document.querySelector('#status'), { childList: true, characterData: true, subtree: true }); true");
  await page.evaluate("document.querySelectorAll('code.k')[1].focus()");
  await page.key('Enter', 'Enter', 13);
  await until(page, 'window.copied.length === 2', 'the copy by keyboard');
  await until(page, "window.said.join('|') === '|Copied'", 'the repeated message said again');
  assert.deepEqual(await page.evaluate('window.copied'), [first, second]);
  // A held Enter copies once; a copy that keeps a blank unfilled names it.
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', autoRepeat: true });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await delay(150);
  assert.equal(await page.evaluate('window.copied.length'), 2, 'a held Enter does not copy again');
  await page.evaluate("document.querySelector('main .r > code:has(var[data-p=HOST])').click(); true");
  await until(page, "document.querySelector('#toast').textContent.startsWith('Copied with')", 'the toast for a blank left to fill');
  assert.match(await page.evaluate("document.querySelector('#toast').textContent"), /^Copied with ([A-Z]+, )*HOST(, [A-Z]+)* still to fill$/);

  await page.evaluate("navigator.clipboard.writeText = async () => { throw new Error('denied'); }; document.querySelector('#toast').textContent = ''; true");
  await page.click('code.k', 2);
  await until(page, "document.querySelector('#toast').textContent.startsWith('Selected')", 'the fallback');
  assert.equal(await page.evaluate('String(getSelection())'), third, 'a refused clipboard selects the command instead');

  // Over an open Setup panel: the toast still shows (raised last in the top layer), a refused value says so in words
  // and goes back to the last good one when you leave the field, and the Import label shows the keyboard focus.
  const field = "document.querySelector('input[data-p=HOST]')";
  await page.evaluate(`document.querySelector('#setup').showPopover(); ${field}.value = 'a b'; ${field}.dispatchEvent(new Event('input')); true`);
  assert.deepEqual(await page.evaluate("['#setup', '#toast'].map((s) => document.querySelector(s).matches(':popover-open'))"), [true, true]);
  assert.equal(await page.evaluate(`getComputedStyle(${field}.closest('.f').querySelector('.f-name'), '::after').content`), '" (not valid)"');
  await page.evaluate(`${field}.dispatchEvent(new Event('change', { bubbles: true })); true`);
  assert.deepEqual(await page.evaluate(`[${field}.value, ${field}.hasAttribute('aria-invalid')]`), ['', false]);
  await page.evaluate("document.querySelector('#export').focus(); true");
  await page.key('Tab', 'Tab', 9);
  assert.deepEqual(await page.evaluate("[document.activeElement.id, getComputedStyle(document.querySelector('label[for=import]')).outlineStyle]"), ['import', 'solid']);
  await page.evaluate("document.querySelector('#setup').hidePopover(); true");

  assert.deepEqual(page.errors, []);

  // The request path and the section bar scroll sideways on purpose: what sits inside them is left out.
  const phone = await browser.page({ width: 390, height: 844 });
  assert.ok(await phone.goto(pathToFileURL(join(root, 'index.html')).href), 'at phone width, the page script never ran');
  const wide = await phone.evaluate("[...document.querySelectorAll('header *:not(.path *), footer *, main *, .bar *:not(.toc *)')].filter((e) => { const r = e.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map((e) => e.outerHTML.slice(0, 80))");
  assert.deepEqual(wide, [], 'at phone width nothing runs past the screen');
  const panel = await phone.evaluate("(() => { const s = document.querySelector('#setup'); s.showPopover(); const r = s.getBoundingClientRect(); const out = [r.left >= 0, r.right <= innerWidth, r.top >= 0, r.bottom <= innerHeight, s.scrollHeight > s.clientHeight || r.height > 0]; s.hidePopover(); return out; })()");
  assert.deepEqual(panel, [true, true, true, true, true], 'at phone width the Setup panel fits the screen and scrolls inside');
  assert.deepEqual(phone.errors, []);

  // Paper is white: a dark system theme darkens the screen, never the print.
  const ink = async (media) => {
    await phone.send('Emulation.setEmulatedMedia', { media, features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    return phone.evaluate("[getComputedStyle(document.body).color, getComputedStyle(document.querySelector('code.k')).backgroundColor]");
  };
  assert.deepEqual(await ink('screen'), ['rgb(227, 230, 233)', 'rgb(29, 34, 40)'], 'the dark palette on screen');
  assert.deepEqual(await ink('print'), ['rgb(28, 33, 39)', 'rgb(233, 236, 230)'], 'the light palette in print');
});

test('your values, pins, notes, entries and filters work, survive a reload, and go out and back in as a file', { skip, timeout }, async () => {
  const page = await browser.page();
  const url = pathToFileURL(join(root, 'index.html')).href;
  assert.ok(await page.goto(url), 'the page script never ran');
  const js = (expression) => page.evaluate(`(() => { ${expression} })()`);
  await js("window.copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.copied.push(t); } } }); return true;");
  const rows = "[...document.querySelectorAll('main section:not(.own) .r[id]')]";
  const hostRow = await js(`return ${rows}.find((r) => r.querySelector('var[data-p=HOST]')).id;`);
  const [pinned, other] = await js(`return ${rows}.slice(4, 6).map((r) => r.id);`);

  // Your values fill every blank of that name, and a copy carries them; search still knows the blank by its name.
  await js("const i = document.querySelector('input[data-p=HOST]'); i.value = ' db-1 '; i.dispatchEvent(new Event('input')); return true;");
  assert.deepEqual(await js("return [...new Set([...document.querySelectorAll('var[data-p=HOST]')].map((v) => v.textContent))];"), ['db-1']);
  await page.click(`[id="${hostRow}"] > code`);
  await until(page, 'window.copied.length === 1', 'the copy');
  assert.match(await js('return window.copied[0];'), /db-1/);
  assert.doesNotMatch(await js('return window.copied[0];'), /\bHOST\b/);
  // A value that a shell or SQL would read as more than a value is marked, and the last good one holds.
  for (const bad of ['db-1; reboot', '$(id)', '-oProxyCommand=x', "x' OR '1", 'a b', 'db-1--x']) {
    assert.equal(await js(`const i = document.querySelector('input[data-p=HOST]'); i.value = ${JSON.stringify(bad)}; i.dispatchEvent(new Event('input')); return i.hasAttribute('aria-invalid');`), true, bad);
  }
  assert.deepEqual(await js("return [...new Set([...document.querySelectorAll('var[data-p=HOST]')].map((v) => v.textContent))];"), ['db-1']);
  assert.equal(await js("const i = document.querySelector('input[data-p=HOST]'); i.value = 'db-1'; i.dispatchEvent(new Event('input')); return i.hasAttribute('aria-invalid');"), false);
  // A file or a data directory is never the root and never climbs out with ..; a mount point may be the root.
  const paths = [['FILE', '/', true], ['FILE', '/.', true], ['FILE', '/./', true], ['FILE', '../etc/shadow', true], ['FILE', '/var/log/../x', true],
    ['FILE', '/var/log/syslog', false], ['FILE', './app.log', false], ['DATADIR', '//', true], ['DATADIR', '.', true],
    ['DATADIR', '/var/lib/postgresql/16/main', false], ['MNT', '/', false]];
  for (const [p, v, bad] of paths) {
    assert.equal(await js(`const i = document.querySelector('input[data-p=${p}]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); return i.hasAttribute('aria-invalid');`), bad, `${p} = ${v}`);
  }
  await js("for (const p of ['FILE', 'DATADIR', 'MNT']) { const i = document.querySelector(`input[data-p=${p}]`); i.value = ''; i.dispatchEvent(new Event('input')); } return true;");

  // A pin puts a copy of the row at the top; a note shows on both; the link names the entry's anchor.
  await page.click(`[id="${pinned}"] [data-act=pin]`);
  await until(page, "document.querySelectorAll('#pinned-list .r').length === 1", 'the pinned copy');
  assert.equal(await js(`return document.querySelector('#pinned-list .r').dataset.ref;`), pinned);
  assert.equal(await js(`return document.querySelector('[id="${pinned}"] [data-act=pin]').getAttribute('aria-pressed');`), 'true');
  assert.equal(await js("return document.querySelector('#pinned').hidden;"), false);
  await page.click(`[id="${pinned}"] [data-act=note]`);
  await page.type('Seen on db-1 <b>at 02:00</b>');
  await page.click(`[id="${pinned}"] .note-edit .btn.primary`);
  await until(page, "document.querySelectorAll('.note').length === 2", 'the note on the row and on its pinned copy');
  assert.deepEqual(await js("return [...document.querySelectorAll('.note span')].map((s) => s.textContent);"), ['Seen on db-1 <b>at 02:00</b>', 'Seen on db-1 <b>at 02:00</b>']);
  assert.equal(await js("return document.querySelectorAll('.note b b, .note span b').length;"), 0, 'a note is text, never markup');
  await page.click(`[id="${other}"] [data-act=link]`);
  await until(page, 'window.copied.length === 2', 'the link');
  assert.equal(await js('return window.copied[1];'), `https://makavli.github.io/server-triage/#${other}`, 'from disk, a link points at the public copy');

  // A pinned copy counts as its original in the match count.
  const word = await js(`const c = document.querySelector('[id="${pinned}"] > code'); return [...c.childNodes].map((n) => (n.nodeName === 'VAR' ? n.dataset.p : n.textContent)).join('').split(/\\s+/).sort((a, b) => b.length - a.length)[0];`);
  await page.click('#q');
  await page.type(word);
  assert.equal(await js("return document.querySelector('#pinned-list .r').hidden;"), false, `the pinned copy matches ${word}`);
  const [said, originals] = await js(`return [document.querySelector('#status').textContent, ${SHOWN}.filter((e) => !e.dataset.ref).length];`);
  assert.equal(said, `${originals} ${originals === 1 ? 'entry matches' : 'entries match'}`, 'the pinned copy is not counted twice');
  await page.key('Escape', 'Escape', 27);
  // Unpinned from its copy while a search hides the original, the focus goes to the search box.
  await page.type('pinned');
  assert.equal(await js(`return document.querySelector('[id="${pinned}"]').closest('[hidden]') !== null;`), true, 'the search hides the original');
  await page.click('#pinned-list [data-act=pin]');
  await until(page, "document.querySelectorAll('#pinned-list .r').length === 0", 'the unpin');
  assert.equal(await js('return document.activeElement.id;'), 'q');
  await page.key('Escape', 'Escape', 27);
  await page.click(`[id="${pinned}"] [data-act=pin]`);
  await until(page, "document.querySelectorAll('#pinned-list .r').length === 1", 'the pin again');

  // A redraw because another tab saved keeps an open note editor and the Setup field you are typing in. A note drops
  // the characters a screen hides.
  await page.click('#pinned-list [data-act=note]');
  await js("document.querySelector('#pinned-list .note-edit textarea').value = 'draft zq'; document.querySelector('#setup').showPopover(); const i = document.querySelector('input[data-p=HOST]'); i.focus(); i.value = 'db-1 half'; document.querySelector('#data-sum').textContent = 'stale'; new BroadcastChannel('server-triage').postMessage('changed'); return true;");
  await until(page, "document.querySelector('#data-sum').textContent !== 'stale'", 'the redraw');
  assert.deepEqual(await js("return [document.querySelector('#pinned-list .note-edit textarea')?.value, document.querySelector('input[data-p=HOST]').value];"), ['draft zq', 'db-1 half']);
  await js("const i = document.querySelector('input[data-p=HOST]'); i.value = 'db-1'; i.blur(); document.querySelector('#setup').hidePopover(); document.querySelector('#pinned-list .note-edit textarea').value = 'Seen on db-1 <b>at 02:00</b>' + String.fromCodePoint(0x202e); document.querySelector('#pinned-list .note-edit').requestSubmit(); return true;");
  await until(page, "!document.querySelector('.note-edit')", 'the saved note');
  assert.deepEqual(await js("return [...document.querySelectorAll('.note span')].map((s) => s.textContent);"), ['Seen on db-1 <b>at 02:00</b>', 'Seen on db-1 <b>at 02:00</b>']);

  // Your own entry: blanks fill, it copies, it is searched with the rest.
  await js("document.querySelector('#add-entry').click(); return true;");
  await until(page, "!document.querySelector('#mine-form').hidden && document.activeElement.name === 'code'", 'the entry form');
  // A command of blanks only is refused out loud; a draft survives one Escape and a second Add an entry.
  await js("const f = document.querySelector('#mine-form'); f.elements.code.value = '   '; f.requestSubmit(); return true;");
  assert.deepEqual(await js("return [document.querySelector('#toast').textContent, document.querySelector('#mine-form').elements.code.hasAttribute('aria-invalid')];"), ['Type a command first', true]);
  await js("document.querySelector('#mine-form').elements.code.value = ''; return true;");
  await page.type('ssh HOST tail -f /srv/app/zqx.log');
  assert.equal(await js("return document.querySelector('#mine-form').elements.code.hasAttribute('aria-invalid');"), false, 'typing clears the mark');
  await page.key('Escape', 'Escape', 27);
  assert.deepEqual(await js("return [document.querySelector('#mine-form').hidden, document.querySelector('#toast').textContent];"), [false, 'Press Escape again to drop your draft']);
  await js("document.querySelector('#add-entry').click(); return true;");
  assert.deepEqual(await js("return [document.querySelector('#mine-form').elements.code.value, document.querySelector('#toast').textContent];"), ['ssh HOST tail -f /srv/app/zqx.log', 'Save or cancel the entry you are writing first']);
  await js("const f = document.querySelector('#mine-form'); f.elements.text.value = 'The zqx' + String.fromCodePoint(0x200b) + ' log.'; f.requestSubmit(); return true;");
  await until(page, "document.querySelectorAll('#mine-list .r').length === 1", 'your entry');
  assert.match(await js("return document.querySelector('#mine-list .r').id;"), /^mine-[0-9a-f]{16}$/);
  assert.equal(await js("return document.querySelector('#mine-list code').textContent;"), 'ssh db-1 tail -f /srv/app/zqx.log');
  assert.equal(await js("return document.querySelector('#mine-list .m p').textContent;"), 'The zqx log.', 'a hidden character typed in the meaning is dropped');
  await page.click('#q');
  await page.type('zqx');
  assert.deepEqual(await page.evaluate(`${SHOWN}.map((e) => e.closest('section').id)`), ['mine']);
  await page.key('Escape', 'Escape', 27);

  // Filters, on tags set here so the test does not depend on the sheet's content.
  await js(`const r = ${rows}; r[0].dataset.tags = 'changes'; r[1].dataset.tags = 'rhel'; r[2].dataset.tags = 'pg16+'; return true;`);
  const hidden = () => js(`return ${rows}.slice(0, 3).map((r) => r.hidden);`);
  await js("document.querySelector('#f-read').click(); return true;");
  assert.deepEqual(await hidden(), [true, false, false]);
  await js("const s = document.querySelector('#f-distro'); s.value = 'deb'; s.dispatchEvent(new Event('change')); return true;");
  assert.deepEqual(await hidden(), [true, true, false]);
  const pg = (v) => js(`const i = document.querySelector('input[data-engine=pg]'); i.value = '${v}'; i.dispatchEvent(new Event('input')); return i.hasAttribute('aria-invalid');`);
  assert.equal(await pg('15'), false);
  assert.deepEqual(await hidden(), [true, true, true], 'PostgreSQL 15 hides what needs 16');
  assert.equal(await js("return document.querySelector('#setup-on').textContent;"), '3 filters on');
  assert.equal(await pg('16'), false);
  assert.deepEqual(await hidden(), [true, true, false]);
  assert.equal(await pg('1x'), true, 'a version that is not one is marked');
  assert.deepEqual(await hidden(), [true, true, false], 'and the last good one holds');
  assert.equal(await pg(''), false);
  assert.equal(await js("return document.querySelector('#setup-on').textContent;"), '2 filters on');

  // All of it is still there after a reload. Saves land in the background, and a reload aborts one in flight: a read
  // of the same store waits for every write queued before it.
  const settle = () => page.evaluate("new Promise((ok) => { const o = indexedDB.open('server-triage'); o.onsuccess = () => { const t = o.result.transaction('prefs'); t.oncomplete = () => { o.result.close(); ok(true); }; t.objectStore('prefs').get('filters'); }; })");
  await settle();
  assert.ok(await page.reload(), 'after a reload, the page script never ran');
  await js("window.copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.copied.push(t); } } }); return true;");
  assert.equal(await js("return document.querySelector('input[data-p=HOST]').value;"), 'db-1');
  assert.equal(await js("return document.querySelector('var[data-p=HOST]').textContent;"), 'db-1');
  assert.equal(await js("return document.querySelector('#pinned-list .r')?.dataset.ref;"), pinned);
  assert.equal(await js("return document.querySelectorAll('.note').length;"), 2);
  assert.equal(await js("return document.querySelectorAll('#mine-list .r').length;"), 1);
  assert.deepEqual(await js("return [document.querySelector('#f-read').checked, document.querySelector('#f-distro').value];"), [true, 'deb']);
  assert.equal(await js("return document.querySelector('#data-sum').textContent;"), '1 pin, 1 note, 1 entry and 1 value, kept on this device.');

  // Export, wipe, import: the file brings everything back.
  await js("window.exported = null; URL.createObjectURL = (b) => { window.exported = b; return 'blob:test'; }; HTMLAnchorElement.prototype.click = function () { window.saved = this.download; }; document.querySelector('#export').click(); return true;");
  await until(page, 'window.exported !== null', 'the export');
  const file = JSON.parse(await js('return window.exported.text();'));
  assert.match(await js('return window.saved;'), /^server-triage-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(file.app, 'server-triage');
  assert.deepEqual(file.pins.map((p) => p.id), [pinned]);
  assert.deepEqual(file.notes, [{ id: pinned, text: 'Seen on db-1 <b>at 02:00</b>' }]);
  assert.deepEqual(file.values, { HOST: 'db-1' });
  assert.equal(file.entries[0].code, 'ssh HOST tail -f /srv/app/zqx.log');
  assert.deepEqual(file.filters, { read: true, distro: 'deb', versions: {} });

  await js("document.querySelector('#wipe').click(); return true;");
  assert.equal(await js("return document.querySelectorAll('#pinned-list .r').length;"), 1, 'one click arms, it does not delete');
  // A double-click, a quick second click and a held Enter are not a yes; a plain Enter after a pause is.
  await js("const w = document.querySelector('#wipe'); w.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); w.click(); return true;");
  await delay(700);
  await js("document.querySelector('#setup').showPopover(); document.querySelector('#wipe').focus(); return document.activeElement.id === 'wipe';");
  const enter = async (autoRepeat) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', autoRepeat });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  await enter(true);
  assert.equal(await js("return document.querySelectorAll('#pinned-list .r').length;"), 1, 'a double-click, a quick second click or a held Enter does not delete');
  await enter(false);
  await until(page,"document.querySelectorAll('#pinned-list .r, #mine-list .r, .note').length === 0", 'the wipe');
  assert.equal(await js("return document.querySelector('var[data-p=HOST]').textContent;"), 'HOST');
  assert.equal(await js("return document.querySelector('#data-sum').textContent;"), 'Nothing saved yet.');
  assert.equal(await js("return document.querySelector('#wipe').textContent;"), 'Delete my data', 'the button reads as before once it has acted');
  // The wipe reached the database: a reload brings nothing back.
  await settle();
  assert.ok(await page.reload(), 'after the wipe and a reload, the page script never ran');
  assert.deepEqual(await js("return [document.querySelector('#data-sum').textContent, document.querySelectorAll('#pinned-list .r, #mine-list .r, .note').length];"), ['Nothing saved yet.', 0]);

  const dir = mkdtempSync(join(tmpdir(), 'triage-import-'));
  try {
    const put = async (name, body) => {
      const path = join(dir, name);
      writeFileSync(path, body);
      const { result } = await page.send('Runtime.evaluate', { expression: "document.querySelector('#import')" });
      await page.send('DOM.setFileInputFiles', { files: [path], objectId: result.objectId });
    };
    await put('not-ours.json', JSON.stringify({ app: 'other', pins: [{ id: pinned }] }));
    await until(page, "document.querySelector('#toast').textContent === 'That file is not a Server Triage export'", 'the refusal');
    await put('broken.json', '{"app": "server-triage", ');
    await until(page, "document.querySelector('#status').textContent === 'That file is not a Server Triage export'", 'the refusal of a broken file');
    await put('big.json', Buffer.alloc(64_000_001, 32));
    await until(page, "document.querySelector('#toast').textContent === 'That file is over 64 MB, more than an export can be'", 'the refusal of a file too big');
    assert.equal(await js("return document.querySelectorAll('#pinned-list .r').length;"), 0, 'a refused file changes nothing');

    // A hostile file: markup stays text, unknown ids, fields and blanks are dropped, and the good parts land.
    const hostile = {
      ...file,
      pins: [...file.pins, { id: '"><img src=x>' }, { id: 'x'.repeat(500) }],
      notes: [...file.notes, { id: 'ok-id', text: 42 }],
      entries: [...file.entries, { id: 'mine-0123456789abcdef', kind: 'cmd', code: '<img src=x onerror="window.pwned=1">', text: '<script>window.pwned=1</script>' }, { id: '../x', kind: 'cmd', code: 'ls', text: '' },
        { id: 'mine-00000000000000ff', kind: 'cmd', code: 'ls \u202e~ fr- mr', text: 'reads as something else' }],
      values: { ...file.values, PORT: '5432\u001b[2K', NAME: '$(reboot)', IP: '-oProxyCommand=x', NOTABLANK: 'x', ['__proto__']: { polluted: true } },
      filters: { read: 'yes', distro: 'arch', versions: { pg: '16', oracle: '19', mysql: '8;drop' } },
    };
    // More entries than the page keeps: refused whole.
    const many = Array.from({ length: 1001 }, (_, i) => ({ id: `mine-${i.toString(16).padStart(16, '0')}`, kind: 'cmd', code: `echo ${i}`, text: '' }));
    await put('many.json', JSON.stringify({ app: 'server-triage', format: 1, entries: many }));
    await until(page, "document.querySelector('#toast').textContent === 'That file would take you past 1000 entries'", 'the cap');
    // Values that would go into every command are asked about first; a no imports nothing.
    await js('window.confirm = (m) => { window.asked = m; return false; }; return true;');
    await put('refused.json', JSON.stringify(hostile));
    await until(page, "document.querySelector('#toast').textContent === 'Nothing imported'", 'the refused import');
    assert.match(await js('return window.asked;'), /HOST = db-1/);
    assert.doesNotMatch(await js('return window.asked;'), /PORT/, 'a value with hidden characters is dropped before the question');
    assert.doesNotMatch(await js('return window.asked;'), /reboot|ProxyCommand/, 'a value a shell would run or read as an option is dropped');
    // The one question lists everything the file brings: entries with their code, notes and pins.
    assert.match(await js('return window.asked;'), /Entries: 2 added, 0 of yours replaced[^]*ssh HOST tail -f[^]*Notes: 1 added, 0 of yours replaced[^]*1 pin added/);
    // The notes show whole, the filters the file brings are named, and what the file holds that is left out is counted:
    // 2 pins, 1 note, 2 entries and 5 values.
    assert.match(await js('return window.asked;'), /Notes: 1 added, 0 of yours replaced:\n\n {2}Seen on db-1 <b>at 02:00<\/b>\n/);
    assert.match(await js('return window.asked;'), /Your filters become the file's: every command shown, any Linux, PostgreSQL 16\./);
    assert.match(await js('return window.asked;'), /10 items in the file left out: hidden characters, a wrong shape, or past what this page keeps\.$/);
    // Never a cut line: every line of a listed entry shows whole, a long run of blanks is counted, and what does not
    // fit is named.
    const long = { app: 'server-triage', format: 1, entries: [
      { id: 'mine-00000000000000a1', kind: 'cmd', code: `echo 1\necho 2\necho 3\necho 4 zqlast\n${'x'.repeat(130)} zqtail\nls${' '.repeat(40)}zqhid\n${'\n'.repeat(50)}zqafter`, text: '' },
      { id: 'mine-00000000000000a2', kind: 'cmd', code: `echo ${'y'.repeat(2000)}`, text: '' },
      { id: 'mine-00000000000000a3', kind: 'cmd', code: `echo ${'z'.repeat(2000)}`, text: '' }] };
    await js('window.asked = null; return true;');
    await put('long.json', JSON.stringify(long));
    await until(page, 'window.asked !== null', 'the question on a long file');
    const asked = await js('return window.asked;');
    for (const part of ['zqlast', `${'x'.repeat(130)} zqtail`, 'ls [40 blanks] zqhid', '  [50 empty lines]\n  zqafter', '1 more entry does not fit here']) assert.ok(asked.includes(part), part);
    assert.equal(await js("return document.querySelectorAll('#mine-list .r').length;"), 0, 'a refused import changes nothing');
    await js('window.confirm = (m) => { window.asked = m; return true; }; return true;');
    await put('export.json', JSON.stringify(hostile));
    await until(page, "document.querySelectorAll('#pinned-list .r').length === 1 && document.querySelectorAll('#mine-list .r').length === 2", 'the import');
    assert.equal(await js("return document.querySelector('#toast').textContent;"), 'Imported 1 pin, 1 note and 2 entries; 10 items left out');
    assert.equal(await js("return document.querySelectorAll('#mine-list img, #mine-list script').length;"), 0, 'imported markup is text');
    assert.equal(await js('return window.pwned ?? null;'), null);
    assert.equal(await js('return ({}).polluted ?? null;'), null);
    assert.equal(await js("return document.querySelector('var[data-p=HOST]').textContent;"), 'db-1');
    assert.equal(await js("return document.querySelector('var[data-p=PORT]').textContent;"), 'PORT');
    assert.equal(await js("return document.querySelectorAll('.note').length;"), 2);
    assert.deepEqual(await js("return [document.querySelector('#f-read').checked, document.querySelector('#f-distro').value, document.querySelector('input[data-engine=pg]').value];"), [false, '', '16']);
    await put('again.json', JSON.stringify(hostile));
    await until(page, "document.querySelector('#toast').textContent.startsWith('Nothing new in that file; 10 items')", 'the same file a second time');
    // The import reached the database: after a reload it is all still there.
    await settle();
    assert.ok(await page.reload(), 'after the import and a reload, the page script never ran');
    assert.deepEqual(await js("return [document.querySelectorAll('#pinned-list .r').length, document.querySelectorAll('#mine-list .r').length, document.querySelectorAll('.note').length, document.querySelector('var[data-p=HOST]').textContent, document.querySelector('input[data-engine=pg]').value];"), [1, 2, 2, 'db-1', '16']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(page.errors, []);
});

test('search knows synonyms and highlights, the keyboard walks the results, and links land on their entry', { skip, timeout }, async () => {
  const page = await browser.page();
  const url = pathToFileURL(join(root, 'index.html')).href;
  assert.ok(await page.goto(url), 'the page script never ran');
  // An entry of your own that says "out of memory" and never "oom", so the synonym is what finds it.
  await page.evaluate("(() => { document.querySelector('#add-entry').click(); const f = document.querySelector('#mine-form'); f.elements.code.value = 'zqy-job --run'; f.elements.text.value = 'Out of memory in the batch.'; f.requestSubmit(); return true; })()");
  await page.click('#q');
  await page.type('oom');
  const hits = await page.evaluate(`${SHOWN}.map((e) => (e.dataset.in + ' ' + e.textContent).toLowerCase())`);
  for (const h of hits) assert.ok(['oom', 'out of memory', 'killed process'].some((w) => h.includes(w)), h.slice(0, 80));
  assert.ok(hits.some((h) => h.includes('zqy-job')), '"oom" also finds "out of memory"');
  assert.ok(await page.evaluate("CSS.highlights.get('hit').size") > 0, 'the matches are highlighted');

  // The keyboard: down into the results, j and k between them, up out of them, Escape back to the box.
  await page.key('ArrowDown', 'ArrowDown', 40);
  const order = await page.evaluate("[...document.querySelectorAll('main .r > code')].filter((c) => !c.closest('[hidden]')).map((c) => c.textContent)");
  const focused = () => page.evaluate('document.activeElement.textContent');
  assert.equal(await focused(), order[0]);
  await page.key('j', 'KeyJ', 74);
  assert.equal(await focused(), order[1]);
  await page.key('k', 'KeyK', 75);
  assert.equal(await focused(), order[0]);
  await page.key('ArrowUp', 'ArrowUp', 38);
  assert.equal(await page.evaluate('document.activeElement.id'), 'q');

  // A link lands on its entry, clearing a search that hides it; a link to an entry that changed lands on its section.
  const id = await page.evaluate("[...document.querySelectorAll('#postgresql .r[id]')].at(-1).id");
  await page.evaluate(`location.hash = '${id}'; true`);
  await until(page, `document.activeElement?.closest('.r')?.id === '${id}'`, 'the linked entry');
  assert.equal(await page.evaluate("document.querySelector('#q').value"), '', 'the search that hid it is cleared');
  assert.equal(await page.evaluate("document.querySelector(':target').id"), id);
  await page.evaluate("location.hash = 'postgresql-000000'; true");
  await until(page, "location.hash === '#postgresql'", 'the fallback to the section');
  // A link to a part of the page that is no place on the sheet leaves your search alone; so does a link to an entry
  // your filters hide, which says so.
  await page.evaluate("(() => { const q = document.querySelector('#q'); q.value = 'zqzq'; q.dispatchEvent(new Event('input')); location.hash = 'toast'; return true; })()");
  await delay(200);
  assert.equal(await page.evaluate("document.querySelector('#q').value"), 'zqzq', 'a link to the toast leaves the search alone');
  const tagged = await page.evaluate("(() => { const r = document.querySelector('#postgresql .r[id]'); r.dataset.tags = 'changes'; document.querySelector('#f-read').click(); return r.id; })()");
  await page.evaluate(`location.hash = '${tagged}'; true`);
  await until(page, "document.querySelector('#toast').textContent === 'Your filters in Setup hide that entry'", 'the message for a filtered entry');
  assert.equal(await page.evaluate("document.querySelector('#q').value"), 'zqzq', 'the search is kept when a filter hides the entry anyway');
  await page.evaluate("(() => { document.querySelector('#f-read').click(); const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input')); return true; })()");

  // Escape drops a draft only when pressed twice.
  await page.evaluate("(() => { document.querySelector('#add-entry').click(); document.querySelector('#mine-form').elements.code.value = 'zqdraft'; return true; })()");
  await page.key('Escape', 'Escape', 27);
  assert.equal(await page.evaluate("document.querySelector('#mine-form').hidden"), false, 'one Escape keeps the draft');
  await page.key('Escape', 'Escape', 27);
  assert.equal(await page.evaluate("document.querySelector('#mine-form').hidden"), true, 'a second Escape drops it');

  // A letter whose lower case is longer (U+0130) shifts the offsets of a match after it: the search must not throw.
  await page.evaluate("(() => { document.querySelector('#add-entry').click(); const f = document.querySelector('#mine-form'); f.elements.code.value = 'zqv-run'; f.elements.text.value = 'İİİ zqv'; f.requestSubmit(); return true; })()");
  await page.click('#q');
  await page.type('zqv');
  assert.ok((await page.evaluate(`${SHOWN}.map((e) => e.textContent)`)).some((t) => t.includes('zqv-run')), 'the entry with U+0130 is found');
  assert.deepEqual(page.errors, []);
});

test('after a failed load, a change never overwrites what is stored', { skip, timeout }, async () => {
  const page = await browser.page();
  assert.ok(await page.goto(pathToFileURL(join(root, 'index.html')).href), 'the page script never ran');
  const js = (expression) => page.evaluate(`(() => { ${expression} })()`);
  const set = (p, v) => js(`const i = document.querySelector('input[data-p=${p}]'); i.value = '${v}'; i.dispatchEvent(new Event('input')); return true;`);
  const settled = () => page.evaluate("new Promise((ok) => { const o = indexedDB.open('server-triage'); o.onsuccess = () => { const t = o.result.transaction('prefs'); t.oncomplete = () => { o.result.close(); ok(true); }; t.objectStore('prefs').get('values'); }; })");
  await set('HOST', 'db-2');
  await set('PORT', '6379');
  await settled();
  // The next load fails (a database that cannot be read), and a value is typed: it must not replace the stored ones.
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "IDBObjectStore.prototype.getAll = function () { throw new Error('test: no load'); };" });
  assert.ok(await page.reload(), 'after a reload, the page script never ran');
  assert.equal(await js("return document.querySelector('#store-note').hidden;"), false, 'Setup says nothing is kept');
  await set('HOST', 'db-3');
  await settled();
  await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  assert.ok(await page.reload(), 'after a reload, the page script never ran');
  assert.deepEqual(await js("return ['HOST', 'PORT'].map((p) => document.querySelector(`input[data-p=${p}]`).value);"), ['db-2', '6379']);

  // A write the browser refuses says so after the toast that said done, and Setup says nothing is kept; the next
  // write that lands takes that back.
  const first = await js("return document.querySelector('main section:not(.own) .r[id]').id;");
  await js("window.realPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new Error('test: no write'); }; return true;");
  await page.click(`[id="${first}"] [data-act=pin]`);
  await until(page, "document.querySelector('#toast').textContent === 'Not saved: this browser refused to keep that change'", 'the refused write');
  assert.equal(await js("return document.querySelector('#store-note').hidden;"), false);
  await js("new BroadcastChannel('server-triage').postMessage('changed'); return true;");
  await delay(300);
  assert.equal(await js(`return document.querySelector('#pinned-list [data-ref="${first}"]') !== null;`), true, 'work kept only in memory survives another tab saving');
  await js('IDBObjectStore.prototype.put = window.realPut; return true;');
  await page.click(`[id="${first}"] [data-act=pin]`);
  await until(page, "document.querySelector('#store-note').hidden", 'storage that works again');

  // A database that fails to open once is opened afresh by the next write, not refused for the page's life.
  const { identifier: once } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: '{ const open = indexedDB.open.bind(indexedDB); let first = true; indexedDB.open = (...a) => { if (!first) return open(...a); first = false; const r = {}; setTimeout(() => r.onerror?.()); return r; }; }' });
  assert.ok(await page.reload(), 'after a reload, the page script never ran');
  await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: once });
  assert.equal(await js("return document.querySelector('#store-note').hidden;"), false, 'the load failed');
  await page.click(`[id="${first}"] [data-act=pin]`);
  await until(page, `new Promise((ok) => { const o = indexedDB.open('server-triage'); o.onsuccess = () => { const g = o.result.transaction('pins').objectStore('pins').get('${first}'); g.onsuccess = () => { o.result.close(); ok(Boolean(g.result)); }; }; })`, 'the pin saved after a failed open');
  assert.deepEqual(page.errors, []);
});

test('what the database holds is checked too: the entry cap, hidden characters, and pins and notes whose entry changed', { skip, timeout }, async () => {
  const page = await browser.page();
  assert.ok(await page.goto(pathToFileURL(join(root, 'index.html')).href), 'the page script never ran');
  const js = (expression) => page.evaluate(`(() => { ${expression} })()`);
  // Written straight into the database, as an older copy of the page or a tampered profile could: 1002 entries (the
  // first with a trailing newline, the second with a hidden character), a pin and a note on an entry that changed,
  // and a note with a hidden character.
  await page.evaluate(`new Promise((ok, no) => { const o = indexedDB.open('server-triage'); o.onsuccess = () => {
    const t = o.result.transaction(['pins', 'notes', 'entries', 'prefs'], 'readwrite');
    for (const s of ['pins', 'notes', 'entries', 'prefs']) t.objectStore(s).clear();
    for (let i = 0; i < 1002; i++) t.objectStore('entries').put({ id: 'mine-' + i.toString(16).padStart(16, '0'), kind: 'cmd', code: 'echo ' + i + (i === 0 ? String.fromCharCode(10) : ''), text: i === 1 ? 'x' + String.fromCodePoint(0x200b) : '', at: i });
    t.objectStore('pins').put({ id: 'postgresql-000000', at: 1 });
    t.objectStore('notes').put({ id: 'postgresql-000000', text: 'zq old note' });
    t.objectStore('notes').put({ id: 'redis-000000', text: 'hidden' + String.fromCodePoint(0x200b) });
    t.oncomplete = () => { o.result.close(); ok(true); }; t.onerror = () => no(t.error); }; })`);
  assert.ok(await page.reload(), 'after a reload, the page script never ran');
  assert.deepEqual(await js("return [document.querySelectorAll('#mine-list .r').length, document.querySelector('[id=mine-0000000000000000] code').textContent, document.getElementById('mine-0000000000000001')];"), [1000, 'echo 0', null]);
  assert.deepEqual(await js("return [document.querySelector('#lost').hidden, [...document.querySelectorAll('#lost-list li')].map((l) => l.textContent)];"), [false, ['postgresql-000000: zq old note']]);
  await js("document.querySelector('#setup').showPopover(); document.querySelector('#lost-del').click(); return true;");
  // Another tab adds a lost note while the button is armed: the list changed, so the button asks again.
  await page.evaluate("new Promise((ok) => { const o = indexedDB.open('server-triage'); o.onsuccess = () => { const t = o.result.transaction('notes', 'readwrite'); t.objectStore('notes').put({ id: 'redis-000001', text: 'zq second' }); t.oncomplete = () => { o.result.close(); new BroadcastChannel('server-triage').postMessage('changed'); ok(true); }; }; })");
  await until(page, "document.querySelectorAll('#lost-list li').length === 2", 'the list from the other tab');
  assert.equal(await js("return document.querySelector('#lost-del').hasAttribute('data-armed');"), false, 'a changed list disarms Delete these');
  await js("document.querySelector('#lost-del').click(); return true;");
  await delay(700);
  await js("document.querySelector('#lost-del').click(); return true;");
  await until(page, "document.querySelector('#lost').hidden", 'the lost pin and note deleted');
  assert.ok(await page.reload(), 'after a reload, the page script never ran');
  assert.equal(await js("return document.querySelector('#lost').hidden;"), true, 'and deleted in the database');
  await js("document.querySelector('#setup').showPopover(); document.querySelector('#wipe').click(); return true;");
  await delay(700);
  await js("document.querySelector('#wipe').click(); return true;");
  await until(page, "document.querySelectorAll('#mine-list .r').length === 0", 'the wipe that leaves the profile clean');
  assert.deepEqual(page.errors, []);
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
