#!/usr/bin/env node
// Every GitHub Pages site of one owner is served from one origin (OWNER.github.io), and an origin has one
// CacheStorage: a service worker that deletes caches it does not own wipes every other site's offline copy. This
// opens each of the owner's Pages sites in a fresh headless browser, after planting a cache no site owns, and fails
// when a site's worker deletes it, or when a site cannot be checked. neighbours.yml runs it every day.
//
//   node tools/neighbours.mjs OWNER      (or with GITHUB_REPOSITORY_OWNER set; GITHUB_TOKEN raises the API limit)
import { pathToFileURL } from 'node:url';
import { launch } from './browser.mjs';

const PROBE = 'neighbours-probe';
const PLANT = `caches.open('${PROBE}').then((c) => c.put('/${PROBE}', new Response('probe'))).then(() => true)`;

// Waits up to 5 s for the page to register a worker, then up to 20 s for it to settle. The state turns 'activated'
// once the activate handler's waitUntil work, where workers clear old caches, is done.
const SETTLE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let reg;
  for (let i = 0; i < 50 && !(reg = await navigator.serviceWorker?.getRegistration()); i++) await sleep(100);
  if (!reg) return false;
  for (let i = 0; i < 200; i++, await sleep(100)) {
    if (!reg.installing && !reg.waiting && reg.active?.state !== 'activating') { await sleep(500); return Boolean(reg.active); }
  }
  throw new Error('its worker never finished activating');
})()`;

// One site, on its own page: kept, deleted, no worker, or elsewhere (it redirects to another origin, a custom
// domain, whose CacheStorage is its own).
async function check(page, origin, site) {
  await page.goto(site, false);
  if ((await page.evaluate('location.origin')) !== origin) return 'elsewhere';
  const worker = await page.evaluate(SETTLE);
  if (!(await page.evaluate(`caches.has('${PROBE}')`))) {
    await page.evaluate(PLANT); // for the sites after this one
    return 'deleted';
  }
  return worker ? 'kept' : 'no worker';
}

// What each site did to a cache it does not own, or the error that stopped its check. Each site gets a fresh page
// and at most 40 s, so a page that hangs (a dialog, a busy loop) costs only its own verdict.
// shortcut: a page's own script could fake caches.has; fine for the owner's sites, an isolated world if that changes.
export async function probe(browser, origin, sites) {
  const first = await browser.page();
  await first.goto(`${origin}/${PROBE}/`, false); // no site lives here, so no worker runs while the probe goes in
  await first.evaluate(PLANT);
  const out = [];
  for (const site of sites) {
    let timer;
    try {
      const page = await browser.page();
      const limit = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('timed out after 40 s')), 40_000); });
      out.push({ site, verdict: await Promise.race([check(page, origin, site), limit]) });
    } catch (e) {
      out.push({ site, verdict: `error: ${e.message.split('\n')[0]}` });
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

// The owner's public repositories that publish a Pages site, as URLs on the shared origin.
async function sitesOf(owner) {
  const headers = { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN && { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }) };
  const repos = [];
  for (let n = 1; ; n++) {
    const res = await fetch(`https://api.github.com/users/${owner}/repos?per_page=100&page=${n}`, { headers });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for the repositories of ${owner}`);
    const list = await res.json();
    repos.push(...list);
    if (list.length < 100) break;
  }
  const host = `${owner.toLowerCase()}.github.io`;
  const origin = `https://${host}`;
  return { origin, sites: repos.filter((r) => r.has_pages).map((r) => (r.name.toLowerCase() === host ? `${origin}/` : `${origin}/${r.name}/`)) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const owner = process.argv[2] ?? process.env.GITHUB_REPOSITORY_OWNER ?? '';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    console.error('Usage: node tools/neighbours.mjs OWNER (a GitHub user or organisation name)');
    process.exit(2);
  }
  const { origin, sites } = await sitesOf(owner);
  const browser = await launch();
  let out;
  try {
    out = await probe(browser, origin, sites);
  } finally {
    await browser.close();
  }
  for (const { site, verdict } of out) console.log(`${verdict.padEnd(10)} ${site}`);
  const bad = out.filter((r) => r.verdict !== 'kept' && r.verdict !== 'no worker' && r.verdict !== 'elsewhere');
  console.log(`${sites.length} Pages sites on ${origin}: ${bad.length ? `${bad.length} to fix` : 'none deletes a cache it does not own'}.`);
  if (bad.some((r) => r.verdict === 'deleted')) console.log(`A worker that deletes every cache but its own wipes the other sites' offline copies: make it delete only the names that start with its own prefix.`);
  process.exit(bad.length ? 1 : 0);
}
