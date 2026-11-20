#!/usr/bin/env node
// Builds the app from CHEATSHEET.md, the one source of the content:
//   index.html  the page, with its CSS and script inlined and a Content-Security-Policy that names their hashes,
//   sw.js       the offline cache, versioned by the bytes it caches.
// With --check it writes nothing and fails when either file is stale.
//
//   node tools/build.mjs [--check]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

// The request path drawn at the top of the page: each hop, the tools that test it, and the section that covers it.
export const HOPS = [
  { name: 'Client', tools: 'curl -v' },
  { name: 'DNS', tools: 'getent, dig', section: 'dns-ports-and-packets' },
  { name: 'Network', tools: 'ss, nc, mtr', section: 'dns-ports-and-packets' },
  { name: 'TLS', tools: 's_client', section: 'tls-and-certificates' },
  { name: 'Load balancer', tools: 'curl -w', section: 'http-proxies-load-balancers' },
  { name: 'Proxy', tools: 'nginx -T', section: 'http-proxies-load-balancers' },
  { name: 'App', tools: 'journalctl', section: 'services-and-logs' },
  { name: 'Database', tools: 'psql, redis-cli', section: 'postgresql' },
];

// Labels for the section bar. A section missing here shows its full title.
export const SHORT = {
  'the-loop': 'Loop',
  'first-minute-on-a-host': 'First minute',
  'error-decoder': 'Errors',
  'services-and-logs': 'Services',
  'cpu-memory-disk-files': 'Resources',
  'dns-ports-and-packets': 'Network',
  'tls-and-certificates': 'TLS',
  'http-proxies-load-balancers': 'HTTP',
  'containers-and-kubernetes': 'Kubernetes',
  postgresql: 'PostgreSQL',
  'mysql-and-mariadb': 'MySQL',
  redis: 'Redis',
};

// What the offline cache holds, relative to the app's folder. sw.js itself is cached by the browser.
export const CACHED = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];

const FENCES = { sh: 'cmd', sql: 'cmd', text: 'err' };

// The ids render() gives the page's own parts: a section slug may not take one.
export const FIXED_IDS = ['main', 'q', 'install', 'none', 'status', 'toast'];

// The anchor GitHub gives a heading, so links into CHEATSHEET.md and into the app are the same.
export function slug(title) {
  return title.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/ /g, '-');
}

export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The Markdown the sheet uses inside a paragraph: `code`, **bold** and [text](https://...) links. Nothing else is
// interpreted, and everything is escaped first, so a paragraph can never inject markup.
const LINK = /\[([^\]]+)\]\((https:\/\/[^)\s"]+)\)/;
const bold = (t) => t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
export function inline(s) {
  const parts = s.split('`');
  if (parts.length % 2 === 0) throw new Error(`an unclosed \` in: ${s}`);
  return parts.map((p, k) => {
    if (k % 2) return `<code>${esc(p)}</code>`;
    // Split on links first, so bold never reaches a URL: [text, label, url, text, ...].
    const seg = esc(p).split(new RegExp(LINK.source, 'g'));
    let out = '';
    for (let j = 0; j < seg.length; j += 3) {
      if (/\]\(https:\/\//.test(seg[j])) throw new Error(`a link that cannot render (a \` in its text, or a space in its URL) in: ${s}`);
      const [text, label] = [bold(seg[j]), j + 1 < seg.length ? bold(seg[j + 1]) : ''];
      if (`${text}${label}`.includes('**')) throw new Error(`a ** that does not close before a link or the end, in: ${s}`);
      out += text + (j + 1 < seg.length ? `<a href="${seg[j + 2]}">${label}</a>` : '');
    }
    return out;
  }).join('');
}

// CHEATSHEET.md, read into sections, groups and entries. The format is strict so a mistake fails the build with its
// line number instead of rendering wrong:
//   # Title, then intro paragraphs; ## a section, then its lede paragraphs; ### a group inside a section;
//   an entry is a ```sh, ```sql or ```text block (text: an error or a state, not a command) and one paragraph;
//   "1. **Title.** text" lines make steps, "- text" lines make rules.
export function parse(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const doc = { title: '', intro: [], sections: [] };
  let section = null;
  let group = null;
  let i = 0;
  const fail = (n, msg) => { throw new Error(`CHEATSHEET.md:${n}: ${msg}`); };
  const block = /^(#{1,3} |```|\d+\. |- )/;
  const paragraph = () => {
    const out = [];
    while (i < lines.length && lines[i].trim() && !block.test(lines[i])) out.push(lines[i++].trim());
    return out.join(' ');
  };
  const into = (kind, n) => {
    if (!section) fail(n, 'an entry before the first ## section');
    if (!group) section.groups.push((group = { title: '', kind, items: [] }));
    if (group.kind && group.kind !== kind) fail(n, `a ${kind} entry among ${group.kind} entries: start a ### group for it`);
    group.kind = kind;
    return group.items;
  };
  while (i < lines.length) {
    const line = lines[i];
    const n = i + 1;
    let m;
    if (!line.trim()) {
      i++;
    } else if ((m = /^# (.*\S.*)$/.exec(line))) {
      if (doc.title || section) fail(n, 'a second # title');
      doc.title = m[1].trim();
      i++;
    } else if ((m = /^## (.*\S.*)$/.exec(line))) {
      section = { title: m[1].trim(), slug: slug(m[1]), lede: [], groups: [] };
      if (!section.slug) fail(n, 'a section title needs a letter or a digit');
      if (FIXED_IDS.includes(section.slug)) fail(n, `a section may not be called "${section.slug}": the page uses that id`);
      doc.sections.push(section);
      group = null;
      i++;
    } else if ((m = /^### (.*\S.*)$/.exec(line))) {
      if (!section) fail(n, 'a ### group before the first ## section');
      section.groups.push((group = { title: m[1].trim(), kind: '', items: [] }));
      i++;
    } else if ((m = /^```(.*)$/.exec(line))) {
      const lang = m[1].trim();
      if (!Object.hasOwn(FENCES, lang)) fail(n, `a code block must be sh, sql or text, not "${lang}"`);
      const code = [];
      for (i++; i < lines.length && lines[i].trimEnd() !== '```'; i++) code.push(lines[i]);
      if (i >= lines.length) fail(n, 'a code block that is never closed');
      if (!code.join('').trim()) fail(n, 'an empty code block');
      for (i++; i < lines.length && !lines[i].trim(); i++);
      const text = paragraph();
      if (!text) fail(n, 'an entry needs one paragraph right after its code block');
      into('rows', n).push({ kind: FENCES[lang], lang, code: code.join('\n'), text });
    } else if ((m = /^\d+\. (.+)$/.exec(line))) {
      const step = /^\*\*(.+?)\*\* (.+)$/.exec(m[1]);
      if (!step) fail(n, 'a step reads "1. **Title.** text"');
      into('steps', n).push({ title: step[1], text: step[2] });
      i++;
    } else if ((m = /^- (.*\S.*)$/.exec(line))) {
      into('rules', n).push({ text: m[1] });
      i++;
    } else {
      const text = paragraph();
      if (!text) fail(n, 'a heading, step or rule marker with no text after it'); // paragraph() did not move: stop here
      if (!section) doc.intro.push(text);
      else if (!section.groups.length) section.lede.push(text);
      else fail(n, 'a paragraph that belongs to no entry: put it right after a code block, or before the first entry');
    }
  }
  if (!doc.title) fail(1, 'no # title');
  if (!doc.intro.length) fail(1, 'no intro paragraph under the title');
  const seen = new Set();
  for (const s of doc.sections) {
    if (seen.has(s.slug)) throw new Error(`CHEATSHEET.md: two sections are called "${s.title}"`);
    seen.add(s.slug);
    if (!s.groups.length) throw new Error(`CHEATSHEET.md: section "${s.title}" has no entries`);
    for (const g of s.groups) if (!g.items.length) throw new Error(`CHEATSHEET.md: group "${g.title}" in "${s.title}" has no entries`);
  }
  for (const h of HOPS) if (h.section && !seen.has(h.section)) throw new Error(`tools/build.mjs: hop ${h.name} points at a missing section "${h.section}"`);
  for (const key of Object.keys(SHORT)) if (!seen.has(key)) throw new Error(`tools/build.mjs: SHORT names a missing section "${key}"`);
  return doc;
}

export const hash = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
const plain = (s) => s.replace(/`|\*\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

function group(g, s) {
  const title = g.title ? `<h3>${inline(g.title)}</h3>` : '';
  const where = esc(plain(`${s.title} ${g.title}`).trim());
  if (g.kind === 'steps') {
    return `<div class="grp">${title}<ol class="loop">${g.items.map((it) => `<li data-in="${where}"><b>${inline(it.title)}</b><p>${inline(it.text)}</p></li>`).join('')}</ol></div>`;
  }
  if (g.kind === 'rules') {
    return `<div class="grp rules">${title}<ul>${g.items.map((it) => `<li data-in="${where}">${inline(it.text)}</li>`).join('')}</ul></div>`;
  }
  const rows = g.items.map((it) => (it.kind === 'cmd'
    ? `<div class="r" data-in="${where}"><code class="k">${esc(it.code)}</code><p>${inline(it.text)}</p></div>`
    : `<div class="r x" data-in="${where}"><code>${esc(it.code)}</code><p>${inline(it.text)}</p></div>`));
  return `<div class="grp">${title}<div class="t">\n${rows.join('\n')}\n</div></div>`;
}

// The page. Only the first intro paragraph sits under the title; the others close the page, in the footer.
export function render(doc, { version, style, script }) {
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${hash(script)}'`,
    `style-src 'sha256-${hash(style)}'`,
    "img-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types triage', // the one policy app.js makes, for the worker's URL
  ].join('; ');
  const hops = HOPS.map((h) => {
    const inner = `<b>${esc(h.name)}</b><span>${esc(h.tools)}</span>`;
    return h.section ? `<li><a class="hop" href="#${h.section}">${inner}</a></li>` : `<li><span class="hop start">${inner}</span></li>`;
  }).join('\n      ');
  const toc = doc.sections.map((s) => `<a href="#${s.slug}">${esc(Object.hasOwn(SHORT, s.slug) ? SHORT[s.slug] : plain(s.title))}</a>`).join('\n      ');
  const sections = doc.sections.map((s) => `<section id="${s.slug}">
<h2>${inline(s.title)}</h2>
${s.lede.map((p) => `<p class="lede">${inline(p)}</p>`).join('\n')}
${s.groups.map((g) => group(g, s)).join('\n')}
</section>`).join('\n\n');
  const description = plain(doc.intro[0]).split(/(?<=\.) /)[0];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${esc(plain(doc.title))}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f3f4f1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111418" media="(prefers-color-scheme: dark)">
<link rel="icon" href="icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icons/icon-192.png">
<style>${style}</style>
</head>
<body>
<a class="skip" href="#main">Skip to the sheet</a>
<header class="top wrap">
  <div class="head">
    <h1>${esc(plain(doc.title))}</h1>
    <button id="install" class="install" type="button" hidden>Install app</button>
  </div>
  <p class="sub">${inline(doc.intro[0])}</p>
  <p class="hint">Click a command to copy it. Press / to search; every word must match.</p>
  <nav class="path" aria-label="The request path">
    <ol>
      ${hops}
    </ol>
  </nav>
  <p class="path-note">A request crosses these hops from left to right. Test them in that order and dig where the first one fails.</p>
</header>

<div class="bar">
  <div class="wrap bar-in">
    <label for="q" class="sr">Search commands and errors</label>
    <input id="q" type="search" placeholder="Search: 502, refused, postgresql lock" autocomplete="off" spellcheck="false">
    <nav class="toc" aria-label="Sections">
      ${toc}
    </nav>
  </div>
</div>

<main id="main" class="wrap">
${sections}

<p id="none" class="none" hidden>Nothing matches. Try fewer words, an errno name or a status code.</p>
<p id="status" class="sr" role="status" aria-live="polite"></p>
</main>

<footer>
  <div class="wrap">
${doc.intro.slice(1).map((p) => `    <p>${inline(p)}</p>`).join('\n')}
    <p>Version ${esc(version)}, free under the MIT licence. Source, issues and the Markdown copy: <a href="https://github.com/makavli/server-triage">github.com/makavli/server-triage</a>.</p>
  </div>
</footer>

<div id="toast" class="toast" aria-hidden="true"></div>
<script>${script}</script>
</body>
</html>
`;
}

// The service worker, with the list it caches and a version taken from those bytes: any change to the page, the
// manifest, an icon, the list or the worker itself makes a new cache, and the old one is dropped.
export function worker(index, src = read('src/sw.js')) {
  for (const p of ['__VERSION__', '__FILES__']) if (!src.includes(p)) throw new Error(`src/sw.js has no ${p} to fill`);
  const h = createHash('sha256').update(index).update(src).update(JSON.stringify(CACHED));
  for (const f of CACHED.filter((f) => f !== './' && f !== 'index.html')) h.update(readFileSync(join(root, f)));
  return src.replace('__VERSION__', h.digest('hex').slice(0, 12)).replace('__FILES__', JSON.stringify(CACHED));
}

export function build() {
  const { version } = JSON.parse(read('package.json'));
  const index = render(parse(read('CHEATSHEET.md')), { version, style: read('src/style.css'), script: read('src/app.js') });
  return { 'index.html': index, 'sw.js': worker(index) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = build();
  if (process.argv.includes('--check')) {
    const stale = Object.entries(out).filter(([f, body]) => { try { return read(f) !== body; } catch { return true; } }).map(([f]) => f);
    if (stale.length) {
      console.error(`Stale: ${stale.join(', ')}. Run: npm run build`);
      process.exit(1);
    }
    console.log('index.html and sw.js are current.');
  } else {
    for (const [f, body] of Object.entries(out)) writeFileSync(join(root, f), body);
    console.log('Wrote index.html and sw.js.');
  }
}
