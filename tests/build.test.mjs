// The build: the sheet's strict format, the escaping of its Markdown, and that the page, the worker and the icons
// on disk are what the generators make.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { CACHED, HIDDEN, HOPS, PLACEHOLDERS, SHORT, build, entryId, inline, parse, render, slug, worker } from '../tools/build.mjs';
import { ICONS, png, svg } from '../tools/icons.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const text = (p) => readFileSync(join(root, p), 'utf8');
const doc = parse(text('CHEATSHEET.md'));
const index = text('index.html');

test('the sheet reads into sections of entries', () => {
  assert.ok(doc.sections.length >= 10, `${doc.sections.length} sections`);
  const rows = doc.sections.flatMap((s) => s.groups).filter((g) => g.kind === 'rows').flatMap((g) => g.items);
  assert.ok(rows.length >= 150, `${rows.length} entries`);
  assert.equal(index.split('<div class="r').length - 1, rows.length, 'every entry is in the page, readable without its script');
});

test('a mistake in the sheet fails the build with its line', () => {
  const head = '# T\n\nIntro.\n\n## A\n\n'; // the next line is line 7
  const cases = [
    ['```bash\nls\n```\n\nLists.\n', /:7: a code block must be sh, sql, js or text, not "bash"/],
    ['```sh\nls\n', /:7: a code block that is never closed/],
    ['```sh\n\n```\n\nNothing.\n', /:7: an empty code block/],
    ['```sh\nls\n```\n', /:7: an entry needs one paragraph/],
    ['```sh\nls\n```\n\nLists.\n\nAnd more.\n', /:13: a paragraph that belongs to no entry/],
    ['```sh\nls\n```\n\nLists.\n- A rule.\n', /:12: a rules entry among rows entries/],
    ['1. No title here.\n', /:7: a step reads/],
    ['```sh\nls\n```\n\nLists.\n\n## A\n\n```sh\nls\n```\n\nLists.\n', /two sections are called "A"/],
    ['```sh\nls\n```\n\nLists.\n\n## B\n\n', /section "B" has no entries/],
    ['### G\n\n### H\n\n```sh\nls\n```\n\nLists.\n', /group "G" in "A" has no entries/],
    ['# U\n', /:7: a second # title/],
    ['```constructor\nls\n```\n\nLists.\n', /:7: a code block must be sh, sql, js or text, not "constructor"/],
    ['## ?!\n', /:7: a section title needs a letter or a digit/],
    ['## Status\n', /:7: a section may not be called "status"/],
    // A bare marker once looped forever: each one fails at its line.
    ...['# ', '## ', '### ', '- ', '1. ', '##   ', '-   '].map((m) => [`${m}\n`, /:7: a heading, step or rule marker with no text/]),
  ];
  for (const [body, error] of cases) assert.throws(() => parse(head + body), error, body);
  assert.throws(() => parse('Intro.\n'), /no # title/);
  assert.throws(() => parse('# T\n\n## A\n\n```sh\nls\n```\n\nLists.\n'), /no intro paragraph/);
  assert.throws(() => parse('# T\n\nIntro.\n\n```sh\nls\n```\n\nLists.\n'), /:5: an entry before the first ## section/);
  assert.throws(() => parse('# T\n\nIntro.\n\n### G\n'), /:5: a ### group before the first ## section/);
});

test('the sheet must hold the sections the request path and the section bar point at', () => {
  const entry = '```sh\nls\n```\n\nLists.\n';
  assert.throws(() => parse('# T\n\nIntro.\n'), /hop DNS points at a missing section "dns-ports-and-packets"/);
  const hops = [...new Set(HOPS.map((h) => h.section).filter(Boolean))].map((s) => `## ${s}\n\n${entry}`).join('\n');
  assert.throws(() => parse(`# T\n\nIntro.\n\n${hops}`), /SHORT names a missing section "the-loop"/);
  // Past every check of the body: a closing fence with a trailing space still closes it.
  assert.throws(() => parse('# T\n\nIntro.\n\n## A\n\n```sh\nls\n``` \n\nLists.\n'), /hop DNS points at a missing section/);
});

test('the Markdown of a paragraph is escaped, and only https links are made', () => {
  assert.equal(inline('a <b> & "c"'), 'a &lt;b&gt; &amp; &quot;c&quot;');
  assert.equal(inline('run `<cmd> **x**` now'), 'run <code>&lt;cmd&gt; **x**</code> now');
  assert.equal(inline('**bold** [docs](https://example.com/a)'), '<b>bold</b> <a href="https://example.com/a">docs</a>');
  assert.equal(inline('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(inline('[x](http://example.com)'), '[x](http://example.com)');
  assert.doesNotMatch(inline('[x](https://e.com/"onclick="a)'), /"onclick/);
  assert.throws(() => inline('an `open code'), /unclosed/);
  // Bold reaches a link's text, never its URL; a link broken by a backtick fails instead of showing as plain text.
  assert.equal(inline('[**t**](https://a/**x**) **b**'), '<a href="https://a/**x**"><b>t</b></a> <b>b</b>');
  assert.throws(() => inline('[run `x`](https://a/)'), /a link that cannot render/);
  assert.throws(() => inline('**a [x](https://y/) b**'), /a \*\* that does not close/);
  assert.throws(() => inline('an **open bold'), /a \*\* that does not close/);
});

// Every part of the page that shows the sheet's text, fed text that would break out of each: an element, an
// attribute, a code block.
test('a hostile sheet is escaped in every part of the page', () => {
  const doc = {
    title: 'T <q1> & "q"',
    intro: ['I <q2> & "q". Second.', 'F <q3>'],
    sections: [{
      title: 'S <q4> "b"', slug: 's-q4-b', lede: ['L <q5>'],
      groups: [{
        title: 'G <q6> "h"', kind: 'rows', items: [
          { kind: 'cmd', lang: 'sh', code: 'echo "<q7>" & x', text: 'P <q8>' },
          { kind: 'err', lang: 'text', code: '</code><q9>', text: 'E' },
        ],
      }],
    }],
  };
  const page = render(doc, { version: '1<2"', style: 'b{}', script: 'void 0' });
  assert.doesNotMatch(page, /<q\d/, 'a tag from the sheet reached the page');
  for (const part of [
    '<title>T &lt;q1&gt; &amp; &quot;q&quot;</title>',
    '<h1>T &lt;q1&gt; &amp; &quot;q&quot;</h1>',
    '<meta name="description" content="I &lt;q2&gt; &amp; &quot;q&quot;.">',
    '<p>F &lt;q3&gt;</p>',
    '<a href="#s-q4-b">S &lt;q4&gt; &quot;b&quot;</a>',
    '<h2>S &lt;q4&gt; &quot;b&quot;</h2>',
    '<p class="lede">L &lt;q5&gt;</p>',
    '<h3>G &lt;q6&gt; &quot;h&quot;</h3>',
    'data-in="S &lt;q4&gt; &quot;b&quot; G &lt;q6&gt; &quot;h&quot;"',
    '<code class="k">echo &quot;&lt;q7&gt;&quot; &amp; x</code><div class="m"><p>P &lt;q8&gt;</p></div>',
    '<code class="k">&lt;/code&gt;&lt;q9&gt;</code>',
    'Version 1&lt;2&quot;,',
  ]) assert.ok(page.includes(part), part);
});

// A small sheet: the body starts at line 7, and the sections the request path and the section bar need follow it.
const needed = [...new Set([...HOPS.map((h) => h.section).filter(Boolean), ...Object.keys(SHORT)])]
  .map((s) => `## ${s}\n\n\`\`\`sh\nls\n\`\`\`\n\nLists.\n`).join('\n');
const sheet = (body) => parse(`# T\n\nIntro.\n\n## A\n\n${body}\n${needed}`);
const first = (d) => d.sections[0].groups[0].items[0];

test('tags name a risk, a distribution and versions, and a wrong one fails at its line', () => {
  assert.deepEqual(first(sheet('```sql changes pg16+ mysql8.0.18+\nKILL 1;\n```\n\nKills.\n')).tags, ['changes', 'pg16+', 'mysql8.0.18+']);
  assert.deepEqual(first(sheet('```sh danger rhel k8s1.30+\nrm x\n```\n\nRemoves.\n')).tags, ['danger', 'rhel', 'k8s1.30+']);
  const cases = [
    ['```sh risky\nls\n```\n\nLists.\n', /:7: an unknown tag "risky"/],
    ['```sh pg+\nls\n```\n\nLists.\n', /:7: an unknown tag "pg\+"/],
    ['```sh pg16\nls\n```\n\nLists.\n', /:7: an unknown tag "pg16"/],
    ['```sh oracle19+\nls\n```\n\nLists.\n', /:7: an unknown tag "oracle19\+"/],
    ['```sh constructor\nls\n```\n\nLists.\n', /:7: an unknown tag "constructor"/],
    ['```text changes\nOops\n```\n\nAn error.\n', /:7: a changes tag on a text block/],
    ['```sh changes danger\nls\n```\n\nLists.\n', /:7: two risk tags/],
    ['```sh deb rhel\nls\n```\n\nLists.\n', /:7: two distro tags/],
    ['```sh pg14+ pg16+\nls\n```\n\nLists.\n', /:7: two PostgreSQL version tags/],
  ];
  for (const [body, error] of cases) assert.throws(() => sheet(body), error, body);
});

test('every entry has an anchor from its section and its code, and the same code twice in a section fails', () => {
  const d = sheet('```sh\nls -l\n```\n\nLists.\n\n```text\nOops\n```\n\nAn error.\n');
  assert.deepEqual(d.sections[0].groups[0].items.map((it) => it.id), [entryId('a', 'ls -l'), entryId('a', 'Oops')]);
  assert.match(entryId('a', 'ls -l'), /^a-[0-9a-f]{6}$/);
  assert.equal(entryId('a', 'ls -l'), entryId('a', 'ls -l'), 'the same code keeps its anchor');
  assert.throws(() => sheet('```sh\nls\n```\n\nLists.\n\n```sh\nls\n```\n\nAgain.\n'), /:13: the same code as line 7, in "A"/);
  assert.throws(() => sheet('```sh\nls \u202e~ fr- mr\n```\n\nLists.\n'), /:8: a hidden character/);
  assert.throws(() => sheet(`\`\`\`sh\nls\n\`\`\`\n\nLists.\n\n## ${entryId('a', 'ls')}\n\n\`\`\`sh\npwd\n\`\`\`\n\nWhere.\n`), /takes the id of the entry at line 7/);
  const ids = doc.sections.flatMap((s) => s.groups).filter((g) => g.kind === 'rows').flatMap((g) => g.items).map((it) => it.id);
  assert.equal(new Set(ids).size, ids.length, 'two entries share an anchor');
  for (const id of ids) assert.ok(index.includes(` id="${id}" `), `${id} is not in the page`);
});

test('one hidden-character class, in the build and the page: unusual spaces, format marks and ignorables too', () => {
  assert.ok(text('src/app.js').includes(`const IN_CODE = /${HIDDEN.source}/gu;`), 'src/app.js IN_CODE differs from build.mjs HIDDEN');
  // NBSP, soft hyphen, CGJ, Arabic letter mark, Mongolian vowel separator, en quad, zero-width space, RLO, narrow NBSP,
  // LRI, inhibit symmetric swapping, Braille blank, ideographic space, Hangul filler, variation selector 16, a tag letter.
  for (const c of [0xa0, 0xad, 0x34f, 0x61c, 0x180e, 0x2000, 0x200b, 0x202e, 0x202f, 0x2066, 0x206a, 0x2800, 0x3000, 0x3164, 0xfe0f, 0xe0041, 0x7f]) {
    assert.ok(HIDDEN.test(`a${String.fromCodePoint(c)}b`), `U+${c.toString(16)} passes`);
    assert.throws(() => sheet(`\`\`\`sh\nls${String.fromCodePoint(c)}\n\`\`\`\n\nLists.\n`), /:8: a hidden character/, `U+${c.toString(16)}`);
  }
  for (const s of ['a b', 'a\tb', 'a\nb', 'café', 'İstanbul', 'λ']) assert.ok(!HIDDEN.test(s), JSON.stringify(s));
});

test('a block that undoes itself, or a keyword spelled like a blank, fails at its line', () => {
  assert.throws(() => sheet('```js changes\nsh.stopBalancer()\nsh.startBalancer()\n```\n\nStops, then starts.\n'), /:7: both halves of a switch/);
  assert.throws(() => sheet('```sh danger\nredis-cli REPLICAOF NO ONE\nredis-cli -h HOST REPLICAOF IP PORT\n```\n\nPromotes.\n'), /:7: both halves of a switch/);
  assert.throws(() => sheet('```sh changes\nredis-cli CLIENT KILL ID ID\n```\n\nCloses.\n'), /:7: "ID ID": a keyword/);
  assert.throws(() => sheet('```sh changes\necho NOT NOT then KILL ID ID\n```\n\nCloses.\n'), /:7: "ID ID": a keyword/, 'every pair on a line is checked');
  assert.doesNotThrow(() => sheet('```sh changes\nredis-cli CLIENT KILL id ID\n```\n\nCloses.\n\n```sh danger\nredis-cli -h HOST REPLICAOF NO ONE\n```\n\nPromotes.\n'));
});

test('a row carries its tags as data and as badges, and its blanks as fields', () => {
  const page = render(sheet('```sh changes deb pg16+\nssh HOST -p PORT HOSTNAME $FILE_X\n```\n\nConnects.\n\n### E\n\n```text\nHOST down\n```\n\nNot a blank.\n'),
    { version: '1', style: '', script: '' });
  assert.ok(page.includes(' data-tags="changes deb pg16+"'));
  assert.ok(page.includes('<p class="tags"><span class="tag t-changes">Changes state</span><span class="tag t-deb">Debian, Ubuntu</span><span class="tag">PostgreSQL 16+</span></p>'));
  assert.ok(page.includes('<code class="k">ssh <var data-p="HOST">HOST</var> -p <var data-p="PORT">PORT</var> HOSTNAME $FILE_X</code>'), 'a blank inside a longer word stays text');
  assert.ok(page.includes('<code class="k">HOST down</code>'), 'an error keeps its capitals');
  // Setup offers a field for each blank the sheet uses, and a version box for each engine its tags name.
  assert.deepEqual([...page.matchAll(/<input data-p="([A-Z]+)"/g)].map((m) => m[1]), ['HOST', 'PORT']);
  assert.deepEqual([...page.matchAll(/<input data-engine="([a-z0-9]+)"/g)].map((m) => m[1]), ['pg']);
  for (const p of Object.keys(PLACEHOLDERS)) assert.match(p, /^[A-Z]{2,}$/);
});

test('sections are anchored as GitHub anchors their headings', () => {
  assert.equal(slug('HTTP, proxies, load balancers'), 'http-proxies-load-balancers');
  assert.equal(slug('CPU, memory, disk, files'), 'cpu-memory-disk-files');
  assert.equal(slug('MySQL and MariaDB'), 'mysql-and-mariadb');
});

test('index.html and sw.js are what the sheet builds', () => {
  const out = build();
  assert.equal(index, out['index.html'], 'index.html is stale: run npm run build');
  assert.equal(text('sw.js'), out['sw.js'], 'sw.js is stale: run npm run build');
  assert.doesNotMatch(out['sw.js'], /__VERSION__|__FILES__/);
});

test('the worker\'s cache is named after everything it serves, its own code included', () => {
  const version = (src) => /triage-([0-9a-f]{12})/.exec(worker('page', src))[1];
  const src = text('src/sw.js');
  assert.notEqual(version(src), version(`${src}\n// changed`));
  assert.notEqual(version(src), /triage-([0-9a-f]{12})/.exec(worker('other page', src))[1]);
  assert.throws(() => worker('page', src.replace('__FILES__', '[]')), /src\/sw\.js has no __FILES__/);
});

// The page's code outside <style> and <script>: there, every < of the sheet is escaped, so each < opens a real tag.
const markup = index.replace(/<(style|script)>[\s\S]*?<\/\1>/g, '');
const tags = [...markup.matchAll(/<[a-z][^>]*>/gi)].map((m) => m[0]);

test('the security policy is the whole policy, with the hash of the one style and the one script', () => {
  const styles = [...index.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  const scripts = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(styles.length, 1);
  assert.equal(scripts.length, 1);
  assert.equal(index.split('<script').length, 2, 'a second script tag');
  const policies = [...index.matchAll(/http-equiv="Content-Security-Policy" content="([^"]+)"/g)];
  assert.equal(policies.length, 1);
  const sha = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
  assert.equal(policies[0][1], [
    "default-src 'none'",
    `script-src 'sha256-${sha(scripts[0][1])}'`,
    `style-src 'sha256-${sha(styles[0][1])}'`,
    "img-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types triage',
  ].join('; '));
  assert.ok(tags.length > 500, `${tags.length} tags`);
  for (const tag of tags) assert.doesNotMatch(tag, /\s(style|on[a-z]+)\s*=/i, `an inline style or handler the policy would block: ${tag}`);
});

test('the page loads nothing from elsewhere, and every link inside it lands', () => {
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'two elements share an id');
  let links = 0;
  for (const tag of tags) {
    const m = /^<(\w+)[^>]*?\s(src|href)\s*=\s*(["']?)([^"'\s>]*)\3/i.exec(tag);
    if (!m) continue;
    const [, name, attr, , url] = m;
    links++;
    if (url.startsWith('#')) assert.ok(ids.includes(url.slice(1)), `a link to a missing #${url.slice(1)}`);
    else if (name === 'a') assert.match(url, /^https:\/\//, `a link to ${url}`);
    else assert.ok(!/^[a-z]+:|^\/\//i.test(url) && existsSync(join(root, url)), `<${name} ${attr}="${url}"> is not a file of the app`);
  }
  assert.ok(links >= HOPS.length + doc.sections.length + 3, `${links} links`);
});

const pngSize = (b) => [b.readUInt32BE(16), b.readUInt32BE(20)];
function chunks(b) {
  const out = [];
  for (let i = 8; i < b.length; i += 12 + b.readUInt32BE(i)) out.push([b.toString('latin1', i + 4, i + 8), b.subarray(i + 8, i + 8 + b.readUInt32BE(i))]);
  return out;
}

test('the manifest names icons that exist at their stated sizes', () => {
  const manifest = JSON.parse(text('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    assert.ok(existsSync(join(root, icon.src)), icon.src);
    if (icon.type === 'image/png') assert.equal(pngSize(readFileSync(join(root, icon.src))).join('x'), icon.sizes, icon.src);
  }
});

// The pixels are compared, not the bytes: another zlib may compress the same image differently.
test('the icons are what tools/icons.mjs draws', () => {
  assert.equal(text('icons/icon.svg'), svg(), 'icons/icon.svg is stale: run npm run icons');
  const cached = CACHED.filter((f) => f.endsWith('.png'));
  assert.deepEqual(cached.sort(), Object.keys(ICONS).map((n) => `icons/${n}`).sort(), 'the worker caches the PNGs tools/icons.mjs draws, and only those');
  for (const file of cached) {
    const [size, full] = ICONS[file.slice('icons/'.length)];
    const parts = chunks(readFileSync(join(root, file)));
    const want = chunks(png(size, full));
    assert.deepEqual(parts.map(([t]) => t), ['IHDR', 'IDAT', 'IEND'], file);
    assert.ok(parts[0][1].equals(want[0][1]), `${file}: its header is stale: run npm run icons`);
    assert.ok(inflateSync(parts[1][1]).equals(inflateSync(want[1][1])), `${file} is stale: run npm run icons`);
  }
});

test('the worker caches files that exist', () => {
  for (const f of CACHED) if (f !== './') assert.ok(existsSync(join(root, f)), f);
});
