// The neighbour check against sites served here: one worker that clears only its own caches, one that clears every
// cache but its own, a page with no worker, and one that redirects to another origin. Skipped where no Chrome or
// Edge is installed, unless REQUIRE_BROWSER is set (CI sets it).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { findBrowser, launch } from '../tools/browser.mjs';
import { probe } from '../tools/neighbours.mjs';

if (!findBrowser() && process.env.REQUIRE_BROWSER) throw new Error('REQUIRE_BROWSER is set and no Chrome or Edge was found: set BROWSER_BIN');
const skip = findBrowser() ? false : 'no Chrome or Edge here (set BROWSER_BIN to one)';

const page = (worker) => `<!doctype html><title>t</title>${worker ? "<script>navigator.serviceWorker.register('sw.js')</script>" : ''}`;
const worker = (name, clear) => `self.addEventListener('install', (e) => e.waitUntil(caches.open('${name}').then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ${clear}).map((k) => caches.delete(k))))));`;

test('a worker that clears caches it does not own is caught, and only that one', { skip, timeout: 90_000 }, async () => {
  let port;
  const routes = {
    '/good/': ['text/html', page(true)],
    '/good/sw.js': ['text/javascript', worker('good-2', "k.startsWith('good-') && k !== 'good-2'")],
    '/bad/': ['text/html', page(true)],
    '/bad/sw.js': ['text/javascript', worker('bad-2', "k !== 'bad-2'")],
    '/plain/': ['text/html', page(false)],
  };
  const server = createServer((req, res) => {
    if (req.url === '/away/') return res.writeHead(302, { location: `http://localhost:${port}/plain/` }).end();
    const hit = routes[req.url];
    res.writeHead(hit ? 200 : 404, { 'content-type': hit?.[0] ?? 'text/plain' }).end(hit?.[1] ?? 'not found');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const browser = await launch();
  try {
    const out = await probe(browser, origin, ['good', 'bad', 'plain', 'away'].map((s) => `${origin}/${s}/`));
    assert.deepEqual(out.map((r) => r.verdict), ['kept', 'deleted', 'no worker', 'elsewhere']);
  } finally {
    await browser.close();
    server.close();
  }
});
