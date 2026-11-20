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
  'storage-and-filesystems': 'Storage',
  'dns-ports-and-packets': 'Network',
  'tls-and-certificates': 'TLS',
  'http-proxies-load-balancers': 'HTTP',
  'containers-and-kubernetes': 'Kubernetes',
  'cloud-aws-google-cloud-azure': 'Cloud',
  'app-runtimes-jvm-nodejs-python-go': 'Runtimes',
  postgresql: 'PostgreSQL',
  'mysql-and-mariadb': 'MySQL',
  sqlite: 'SQLite',
  'sql-server': 'SQL Server',
  redis: 'Redis',
  mongodb: 'MongoDB',
  'message-queues': 'Queues',
  'elasticsearch-and-opensearch': 'Search',
};

// What the offline cache holds, relative to the app's folder. sw.js itself is cached by the browser.
export const CACHED = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];

const FENCES = { sh: 'cmd', sql: 'cmd', js: 'cmd', text: 'err' };

// Tags, the words after a fence's language: what a command risks, the distribution it needs, the oldest version it
// runs on (pg16+). Untagged means it only reads, on any Linux, at the section's baseline.
export const RISK = { changes: 'Changes state', danger: 'Can lose data' };
export const DISTRO = { deb: 'Debian, Ubuntu', rhel: 'RHEL family' };
export const ENGINES = {
  pg: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mssql: 'SQL Server', sqlite: 'SQLite', redis: 'Redis',
  valkey: 'Valkey', mongo: 'MongoDB', es: 'Elasticsearch', opensearch: 'OpenSearch', kafka: 'Kafka',
  rabbitmq: 'RabbitMQ', k8s: 'Kubernetes', kernel: 'Linux', systemd: 'systemd', openssl: 'OpenSSL', java: 'Java',
  node: 'Node.js', python: 'Python',
};
const VERSION = new RegExp(`^(${Object.keys(ENGINES).join('|')})([0-9]+(?:[.][0-9]+)*)[+]$`);

// The words in capitals a reader fills in, with the hint the Setup panel shows. None is an SQL keyword, so a query
// never has a keyword turned into a blank.
export const PLACEHOLDERS = {
  HOST: 'host name or IP', IP: 'IP address', PORT: 'port', NAME: 'DNS name', RESOLVER: 'DNS server', PID: 'process ID',
  APP: 'unit, deployment or app', SVC: 'Kubernetes service', POD: 'pod', CTR: 'container', NS: 'namespace',
  SA: 'service account', NODE: 'node', ID: 'thread, job or query ID', DISK: 'block device, such as sda',
  IFACE: 'network interface', MNT: 'mount point', DB: 'database', TABLENAME: 'table', DBUSER: 'database user',
  KEYNAME: 'Redis key', QUEUE: 'queue', TOPIC: 'topic', GROUPNAME: 'consumer group', INDEXNAME: 'index',
  BROKER: 'broker host:port', REGION: 'cloud region', INSTANCE: 'instance ID', FILE: 'file path',
  VGNAME: 'LVM volume group', LVNAME: 'LVM logical volume', ZONE: 'cloud zone', ARN: 'AWS resource ARN',
  SGID: 'security group ID', ENCODED: 'encoded AWS failure message', BACKEND: 'backend name', RGNAME: 'Azure resource group',
  GATEWAY: 'Azure application gateway', NSGNAME: 'Azure network security group', NICNAME: 'Azure network interface',
  SLOTNAME: 'replication slot', SUBNAME: 'subscription', LSN: 'WAL position, such as 0/3000060', GID: 'prepared transaction ID',
  REPLICASET: "the replica's GTID set", SOURCESET: "the source's GTID set", GTIDVALUE: 'one GTID, UUID:N',
  PVCNAME: 'PersistentVolumeClaim', INGNAME: 'Ingress', POLNAME: 'NetworkPolicy', IMAGE: 'image reference',
  SRVNAME: 'server in a backend', COLLECTION: 'MongoDB collection', REPLSET: 'replica set name', PGCLUSTER: 'Patroni cluster name', DATADIR: 'data directory', STANZA: 'pgBackRest stanza',
  REPO: 'snapshot repository', SNAPNAME: 'snapshot name',
};
const BLANK = new RegExp(`\\b(${Object.keys(PLACEHOLDERS).join('|')})\\b`, 'g');

// A character the screen hides or reorders: a control (but tab and newline), a format or bidi mark, a space that is not
// the plain one, a default-ignorable, the Braille blank. A copied command would differ from the one you read.
// src/app.js holds the same class as IN_CODE, and a test checks they match.
export const HIDDEN = /(?![\t\n])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]|(?! )\p{Zs}/u;

// Both halves of a switch in one block copy as one paste that undoes itself (the balancer stopped, then started).
const TOGGLES = [[/stopBalancer/, /startBalancer/], [/REPLICAOF NO ONE/, /REPLICAOF (?!NO ONE)/], [/pg_wal_replay_pause/, /pg_wal_replay_resume/], [/patronictl pause/, /patronictl resume/]];

// The ids render() gives the page's own parts: a section slug may not take one.
export const FIXED_IDS = ['main', 'q', 'install', 'none', 'status', 'toast', 'setup', 'setup-btn', 'setup-on', 'pinned',
  'pinned-list', 'mine', 'mine-list', 'mine-form', 'add-entry', 'export', 'import', 'wipe', 'data-sum', 'f-read',
  'f-distro', 'store-note', 'setup-h', 'pinned-h', 'mine-h', 'mine-form-h', 'code-name'];

// An entry's anchor: its section and the first bytes of its code's hash, so a link holds while the command does.
export const entryId = (section, code) => `${section}-${createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 6)}`;

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
  lines.forEach((l, n) => { if (HIDDEN.test(l)) fail(n + 1, 'a hidden character (a control, a format or bidi mark, an unusual space): type it out or remove it'); });
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
      const [lang = '', ...words] = m[1].trim().split(/\s+/);
      if (!Object.hasOwn(FENCES, lang)) fail(n, `a code block must be sh, sql, js or text, not "${lang}"`);
      const tags = [];
      const kinds = new Set();
      for (const w of words) {
        const v = VERSION.exec(w);
        const kind = Object.hasOwn(RISK, w) ? 'risk' : Object.hasOwn(DISTRO, w) ? 'distro' : v ? v[1] : '';
        if (!kind) fail(n, `an unknown tag "${w}": use changes, danger, deb, rhel or a version such as pg16+`);
        if (kind === 'risk' && lang === 'text') fail(n, `a ${w} tag on a text block: only a command changes state`);
        if (kinds.has(kind)) fail(n, `two ${ENGINES[kind] ? `${ENGINES[kind]} version` : kind} tags`);
        kinds.add(kind);
        tags.push(w);
      }
      const code = [];
      for (i++; i < lines.length && lines[i].trimEnd() !== '```'; i++) code.push(lines[i]);
      if (i >= lines.length) fail(n, 'a code block that is never closed');
      if (!code.join('').trim()) fail(n, 'an empty code block');
      if (TOGGLES.some(([a, b]) => code.some((l) => a.test(l)) && code.some((l) => b.test(l)))) fail(n, 'both halves of a switch in one block: one paste would undo itself, so give each its own');
      // A keyword spelled like a blank (CLIENT KILL ID ID) would take your value too: write the keyword in lower case.
      const twice = lang !== 'text' && code.map((l) => /\b([A-Z][A-Z0-9]*) \1\b/.exec(l)?.[1]).find((w) => Object.hasOwn(PLACEHOLDERS, w));
      if (twice) fail(n, `"${twice} ${twice}": a keyword that the blank ${twice} would fill too; write the keyword in lower case`);
      for (i++; i < lines.length && !lines[i].trim(); i++);
      const text = paragraph();
      if (!text) fail(n, 'an entry needs one paragraph right after its code block');
      into('rows', n).push({ kind: FENCES[lang], lang, tags, code: code.join('\n'), text, line: n });
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
  const ids = new Map(); // one id space for the page: a section and an entry elsewhere may not share one
  for (const s of doc.sections) {
    if (seen.has(s.slug)) throw new Error(`CHEATSHEET.md: two sections are called "${s.title}"`);
    seen.add(s.slug);
    if (ids.has(s.slug)) throw new Error(`CHEATSHEET.md: section "${s.title}" takes the id of the entry at line ${ids.get(s.slug)}`);
    ids.set(s.slug, `"${s.title}"`);
    if (!s.groups.length) throw new Error(`CHEATSHEET.md: section "${s.title}" has no entries`);
    for (const g of s.groups) if (!g.items.length) throw new Error(`CHEATSHEET.md: group "${g.title}" in "${s.title}" has no entries`);
    for (const it of s.groups.filter((g) => g.kind === 'rows').flatMap((g) => g.items)) {
      it.id = entryId(s.slug, it.code);
      if (ids.has(it.id)) throw new Error(`CHEATSHEET.md:${it.line}: the same code as line ${ids.get(it.id)}, in "${s.title}"`);
      ids.set(it.id, it.line);
    }
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
  // A row: its anchor, its tags as data and as badges, its blanks marked. An error copies as a command does, for grep.
  const rows = g.items.map((it) => {
    const code = it.kind === 'cmd' ? esc(it.code).replace(BLANK, '<var data-p="$1">$1</var>') : esc(it.code);
    const tags = it.tags ?? [];
    const badges = tags.map((t) => {
      const v = VERSION.exec(t);
      return v ? `<span class="tag">${esc(ENGINES[v[1]])} ${v[2]}+</span>` : `<span class="tag t-${t}">${RISK[t] ?? DISTRO[t]}</span>`;
    }).join('');
    const attrs = `${it.id ? ` id="${it.id}"` : ''} data-in="${where}"${tags.length ? ` data-tags="${tags.join(' ')}"` : ''}`;
    return `<div class="r${it.kind === 'cmd' ? '' : ' x'}"${attrs}><code class="k">${code}</code><div class="m"><p>${inline(it.text)}</p>${badges ? `<p class="tags">${badges}</p>` : ''}</div></div>`;
  });
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
  // The Setup panel offers a field for each blank the sheet uses and a version box for each engine its tags name.
  const rows = doc.sections.flatMap((s) => s.groups).filter((g) => g.kind === 'rows').flatMap((g) => g.items);
  const used = new Set(rows.filter((it) => it.kind === 'cmd').flatMap((it) => [...it.code.matchAll(BLANK)].map((m) => m[1])));
  const engines = new Set(rows.flatMap((it) => (it.tags ?? []).map((t) => VERSION.exec(t)?.[1]).filter(Boolean)));
  const field = (label, input) => `<label class="f"><span class="f-name">${label}</span>${input}</label>`;
  const blanks = Object.keys(PLACEHOLDERS).filter((p) => used.has(p))
    .map((p) => field(`<code>${p}</code>`, `<input data-p="${p}" placeholder="${esc(PLACEHOLDERS[p])}" maxlength="200" autocomplete="off" autocapitalize="off" spellcheck="false">`))
    .join('\n          ');
  const versions = Object.keys(ENGINES).filter((e) => engines.has(e))
    .map((e) => field(esc(ENGINES[e]), `<input data-engine="${e}" placeholder="any" inputmode="decimal" maxlength="12" autocomplete="off">`))
    .join('\n          ');
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
  <p class="hint">Click a command or an error to copy it. Press / to search; every word must match, and the arrow keys walk the results.</p>
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
    <div class="find">
      <input id="q" type="search" placeholder="Search: 502, refused, postgresql lock" autocomplete="off" spellcheck="false">
      <button id="setup-btn" class="btn" type="button" popovertarget="setup" hidden>Setup<span id="setup-on" class="on" hidden></span></button>
    </div>
    <nav class="toc" aria-label="Sections">
      <a href="#pinned" data-own="pinned" hidden>Pinned</a>
      <a href="#mine" data-own="mine" hidden>Yours</a>
      ${toc}
    </nav>
  </div>
</div>

<div id="setup" class="setup" popover aria-labelledby="setup-h">
  <div class="setup-in">
    <div class="setup-head">
      <h2 id="setup-h">Setup</h2>
      <button class="btn" type="button" popovertarget="setup" popovertargetaction="hide">Done</button>
    </div>
    <div class="tg">
      <h3>Your values</h3>
      <p class="note-line">Fill a blank once and every command on the sheet shows your value. Kept on this device.</p>
      <div class="fields">
          ${blanks}
      </div>
    </div>
    <div class="tg">
      <h3>Show</h3>
      <label class="check"><input type="checkbox" id="f-read"> Hide commands that change state</label>
      ${field('Distribution', '<select id="f-distro"><option value="">Any Linux</option><option value="deb">Debian and Ubuntu</option><option value="rhel">RHEL family</option></select>')}
      ${versions ? `<p class="note-line">Hide entries that need a newer version than yours:</p>
      <div class="fields">
          ${versions}
      </div>` : ''}
    </div>
    <div class="tg">
      <h3>Your data</h3>
      <p id="data-sum" class="note-line">Nothing saved yet.</p>
      <p id="store-note" class="note-line warn" hidden>This browser refuses to keep data for this page, so your changes last until you close it.</p>
      <div class="btns">
        <button class="btn" type="button" id="add-entry">Add an entry</button>
        <button class="btn" type="button" id="export">Export</button>
        <label class="btn" for="import">Import</label><input class="sr" type="file" id="import" accept=".json,application/json">
        <button class="btn danger" type="button" id="wipe">Delete my data</button>
      </div>
    </div>
  </div>
</div>

<main id="main" class="wrap">
<section id="pinned" class="own" aria-labelledby="pinned-h" hidden>
<h2 id="pinned-h">Pinned</h2>
<p class="lede">Your shortlist for this incident, kept on this device. The same button unpins.</p>
<div class="grp"><div class="t" id="pinned-list"></div></div>
</section>

<section id="mine" class="own" aria-labelledby="mine-h" hidden>
<h2 id="mine-h">Your entries</h2>
<p class="lede">Commands and errors you added. They stay on this device; Setup exports them.</p>
<div class="grp"><div class="t" id="mine-list"></div></div>
<form id="mine-form" class="mine-form" aria-labelledby="mine-form-h" hidden>
  <h3 id="mine-form-h">Add an entry</h3>
  <fieldset class="kind">
    <legend class="sr">Kind</legend>
    <label class="check"><input type="radio" name="kind" value="cmd" checked> Command</label>
    <label class="check"><input type="radio" name="kind" value="err"> Error or state</label>
  </fieldset>
  <label class="f"><span class="f-name" id="code-name">Command</span><textarea name="code" rows="3" maxlength="4000" required autocapitalize="off" spellcheck="false"></textarea></label>
  <label class="f"><span class="f-name">What it tells you</span><textarea name="text" rows="3" maxlength="4000"></textarea></label>
  <p class="note-line">Blanks such as HOST fill in from Your values, as they do on the sheet.</p>
  <div class="btns"><button class="btn primary" type="submit">Save entry</button><button class="btn" type="button" data-act="cancel">Cancel</button></div>
</form>
</section>

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
