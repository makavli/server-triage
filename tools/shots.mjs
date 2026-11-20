#!/usr/bin/env node
// Takes the README's pictures of the built page in a headless browser (no window opens): the desktop page light and
// dark, a phone, and docs/demo.png, an animated PNG of a search and a copy. The animation needs ffmpeg (on PATH, or
// set FFMPEG); without it the still pictures are still taken.
//
//   node tools/shots.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const url = pathToFileURL(join(root, 'index.html')).href;
const docs = (name) => join(root, 'docs', name);
const scheme = (page, value) => page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
const painted = (page) => page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');

const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const hasFfmpeg = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0;
const wrote = [];
const browser = await launch();
const frames = mkdtempSync(join(tmpdir(), 'triage-frames-'));
try {
  const desk = await browser.page({ width: 1280, height: 860 });
  for (const value of ['light', 'dark']) {
    await scheme(desk, value);
    await desk.goto(url);
    writeFileSync(docs(`screenshot-${value}.png`), await desk.screenshot());
    wrote.push(`screenshot-${value}.png`);
  }

  const phone = await browser.page({ width: 390, height: 780 });
  await scheme(phone, 'dark');
  await phone.goto(url);
  writeFileSync(docs('screenshot-phone.png'), await phone.screenshot());
  wrote.push('screenshot-phone.png');

  if (hasFfmpeg) {
    // At 8 frames a second: hold the page, type a search one letter a frame, hold the matches, copy the first one.
    const demo = await browser.page({ width: 960, height: 840 });
    await scheme(demo, 'light');
    await demo.goto(url);
    await demo.evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }); true");
    let n = 0;
    const shoot = async (times = 1) => {
      await painted(demo);
      const png = await demo.screenshot();
      for (let k = 0; k < times; k++) writeFileSync(join(frames, `${String(n++).padStart(4, '0')}.png`), png);
    };
    await shoot(10);
    await demo.key('/', 'Slash', 191);
    await shoot(3);
    for (const letter of 'postgresql lock') { await demo.type(letter); await shoot(); }
    await shoot(14);
    const first = await demo.evaluate("[...document.querySelectorAll('code.k')].findIndex((k) => k.checkVisibility())");
    await demo.click('code.k', first);
    await shoot(14);
    const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', '8', '-i', join(frames, '%04d.png'), '-vf', 'split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none', '-plays', '0', '-pred', 'mixed', '-f', 'apng', docs('demo.png')], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr || r.error?.message}`);
    wrote.push('demo.png');
  }
  console.log(`Wrote docs/${wrote.join(', docs/')} with ${browser.name}.${hasFfmpeg ? '' : ' No ffmpeg: the animation was not retaken.'}`);
} finally {
  await browser.close();
  rmSync(frames, { recursive: true, force: true });
}
