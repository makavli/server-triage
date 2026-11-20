#!/usr/bin/env node
// Sets a new version, opens its changelog entry and rebuilds the page, whose footer names the version.
// Every merge into main is a release, so every pull request starts with this.
//
//   node tools/bump.mjs 1.2.3
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const next = process.argv[2] ?? '';
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('usage: node tools/bump.mjs <major.minor.patch>');
  process.exit(1);
}
build(); // a sheet that does not build fails here, before any file is written
const pkgFile = join(root, 'package.json');
const pkg = readFileSync(pkgFile, 'utf8');
const old = JSON.parse(pkg).version;
const bumped = pkg.replace(`"version": "${old}"`, `"version": "${next}"`);
if (bumped === pkg && old !== next) throw new Error(`package.json: no "version": "${old}" to replace`);
writeFileSync(pkgFile, bumped);
const changelog = join(root, 'CHANGELOG.md');
const today = new Date().toISOString().slice(0, 10);
const log = readFileSync(changelog, 'utf8');
// An entry already written for this version is kept, never opened twice.
if (!log.includes(`## ${next} `)) writeFileSync(changelog, log.replace(/^# Changelog\r?\n\r?\n/, `# Changelog\n\n## ${next} (${today})\n\n- \n\n`));
for (const [file, body] of Object.entries(build())) writeFileSync(join(root, file), body);
console.log(`${old} -> ${next}, page rebuilt. Now write the entry in CHANGELOG.md.`);
