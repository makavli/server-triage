// Checks on the repository itself: the version, the release text, links, file types, and that no machine left a trace.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { notes } from '../tools/release-notes.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const text = (p) => readFileSync(join(root, p), 'utf8');

// What would ship: git's list (tracked, and new files it does not ignore), or every file outside a git checkout.
function walk(dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (['.git', 'node_modules'].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(relative(root, path).split('\\').join('/'));
  }
  return out;
}
function files() {
  try {
    return execFileSync('git', ['ls-files', '-coz', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter((f) => f && existsSync(join(root, f)));
  } catch {
    return walk();
  }
}
const all = files();

test('the list of what ships is not empty, so the scans below look at something', () => {
  for (const f of ['index.html', 'CHEATSHEET.md', 'tools/build.mjs', '.github/workflows/test.yml']) assert.ok(all.includes(f), `${f} is not in the list`);
});

test('the version has its changelog entry, newest first', () => {
  const { version } = JSON.parse(text('package.json'));
  const log = text('CHANGELOG.md');
  assert.ok(log.indexOf(`## ${version} `) >= 0 && log.indexOf(`## ${version} `) < 20, `CHANGELOG.md does not open with ${version}`);
  const heads = log.match(/^## \S+/gm);
  assert.equal(new Set(heads).size, heads.length, 'a version has two changelog headings');
  assert.doesNotMatch(log, /^- *$/m, 'an empty changelog bullet');
});

test('the release text is the changelog entry of this version, and only that one', () => {
  const out = notes();
  assert.ok(out.length > 80, out);
  assert.doesNotMatch(out, /^## /m);
  assert.equal(notes('9.9.9', '# Changelog\n\n## 9.9.9 (2030-01-01)\n\n- New.\n\n## 9.9.8 (2029-01-01)\n\n- Old.\n').split('\n')[0], '- New.');
  assert.throws(() => notes('0.0.0'), /no entry/);
});

test('relative links and images resolve', () => {
  for (const file of all.filter((f) => f.endsWith('.md'))) {
    const body = text(file).replace(/```[\s\S]*?```/g, '');
    const targets = [...body.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g), ...body.matchAll(/(?:src|srcset|href)="([^"#]+)(#[^"]*)?"/g)].map((m) => m[1]);
    for (const target of targets) {
      if (/^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(join(root, dirname(file), target)), `${file} links to ${target}`);
    }
  }
});

// The sheet's examples use loopback, private and documentation addresses only (RFC 1918, 5737); anything else is
// someone's real host.
const exampleAddress = (ip) => {
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
};

test('no machine left a trace: no home folders, public addresses, e-mails or keys', () => {
  const traces = new RegExp([
    String.raw`[a-z]:[\\/](users|documents and settings)[\\/]`, String.raw`\\\\[\w.-]+\\`, String.raw`/(home|users)/[a-z]`, String.raw`appdata[\\/]`, String.raw`onedrive[\\/ -]`,
    String.raw`[\w.+-]+@[\w-]+\.[a-z]{2,}`, // e-mail
    String.raw`gh[pousr]_[a-z0-9]{20,}`, 'github_pat_', String.raw`\bakia[0-9a-z]{16}`, String.raw`\bxox[abprs]-`, String.raw`\bsk-[\w-]{20,}`, String.raw`\baiza[\w-]{30,}`,
    String.raw`BEGIN [a-z ]*PRIVATE KEY`,
  ].join('|'), 'i');
  for (const file of all.filter((f) => !f.endsWith('.png') && f !== 'tests/repo.test.mjs')) { // this file holds the pattern itself
    for (const line of text(file).split('\n')) {
      assert.ok(!traces.test(line), `${file}: ${line.trim().slice(0, 120)}`);
      assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(line.replace(/\r$/, '')), `${file}: a hidden character (control, zero-width or bidi) in ${line.trim().slice(0, 60)}`);
      for (const [ip] of line.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) assert.ok(exampleAddress(ip), `${file}: a public address ${ip}`);
    }
  }
});

test('only the app and its sources ship: text, and PNGs of image data only', () => {
  const image = ['IHDR', 'PLTE', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'tRNS', 'sBIT', 'bKGD', 'acTL', 'fcTL', 'fdAT']; // the last three: an animated PNG's frames
  for (const file of all) {
    const size = statSync(join(root, file)).size;
    if (file.endsWith('.png')) {
      assert.match(file, /^(icons|docs)\//, `a picture outside icons/ and docs/: ${file}`);
      assert.ok(size < 400_000, `${file} is ${size} bytes`);
      // Only image chunks: anything else (tIME, iCCP, tEXt, an editor's private chunk) could carry data.
      const b = readFileSync(join(root, file));
      assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is not a PNG`);
      const types = [];
      let i = 8;
      while (i < b.length) { types.push(b.toString('latin1', i + 4, i + 8)); i += 12 + b.readUInt32BE(i); }
      assert.equal(i, b.length, `${file} has bytes past its last chunk`);
      assert.deepEqual(types.filter((t) => !image.includes(t)), [], `${file} carries a chunk that is not image data`);
    } else {
      assert.match(file, /\.(md|mjs|js|css|html|json|webmanifest|ya?ml|svg)$|^(LICENSE|\.gitignore|\.gitattributes)$/, `unexpected file type: ${file}`);
      // The sheet and the page built from it grow with the content; any other big text file is a stray blob.
      assert.ok(size < (['CHEATSHEET.md', 'index.html'].includes(file) ? 900_000 : 300_000), `${file} is ${size} bytes`);
    }
  }
});
