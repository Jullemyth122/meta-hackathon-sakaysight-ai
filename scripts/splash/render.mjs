// Bakes the loading screen's scenery into images, one tile per layer, with
// headless Chrome: node scripts/splash/render.mjs <layers.html> <layers.json>
// As vectors, every piece of a layer that scrolled into view was drawn again
// from scratch, which took the machine from the app it was there to wait for.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Twice the size it is shown: sharp on high-density screens. */
const SCALE = 2;
const QUALITY = 88;
const PORT = 9338;
const CHROME =
  process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const [page, list] = process.argv.slice(2);
const layers = JSON.parse(readFileSync(list, 'utf8'));
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/splash');
mkdirSync(out, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'splash-render-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  target = await fetch(`http://127.0.0.1:${PORT}/json`)
    .then((r) => r.json())
    .then((l) => l.find((t) => t.type === 'page'))
    .catch(() => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) waiting.get(m.id)?.(m.result);
};
const send = (method, params = {}) =>
  new Promise((r) => {
    waiting.set(++id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
await send('Emulation.setDeviceMetricsOverride', {
  width: Math.max(...layers.map((l) => l.width)),
  height: layers.reduce((sum, l) => sum + l.height, 0),
  deviceScaleFactor: SCALE,
  mobile: false,
});
await send('Page.navigate', { url: pathToFileURL(resolve(page)).href });
await sleep(1500);
// Shop signs and the billboard are in the same type as everything else.
await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
await sleep(500);

let y = 0;
for (const { name, width, height } of layers) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'webp',
    quality: QUALITY,
    captureBeyondViewport: true,
    clip: { x: 0, y, width, height, scale: 1 },
  });
  const bytes = Buffer.from(data, 'base64');
  writeFileSync(join(out, `${name}.webp`), bytes);
  console.log(`${name}.webp ${(bytes.length / 1024).toFixed(0)} KB`);
  y += height;
}
ws.close();
chrome.kill();
// Windows may hold the profile a little longer: it is only a temp folder.
await sleep(800);
try {
  rmSync(profile, { recursive: true, force: true });
} catch {}
process.exit(0);
