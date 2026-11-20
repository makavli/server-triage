#!/usr/bin/env node
// Takes the README's screenshots of the built page, light and dark, in a headless browser (no window opens).
//
//   node tools/shots.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const browser = await launch();
try {
  const page = await browser.page({ width: 1280, height: 860 });
  for (const scheme of ['light', 'dark']) {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await page.goto(pathToFileURL(join(root, 'index.html')).href);
    writeFileSync(join(root, 'docs', `screenshot-${scheme}.png`), await page.screenshot());
  }
  console.log(`Wrote docs/screenshot-light.png and docs/screenshot-dark.png with ${browser.name}.`);
} finally {
  await browser.close();
}
