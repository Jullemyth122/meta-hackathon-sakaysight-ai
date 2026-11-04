/**
 * How much of Metro Manila's road map the network's routes actually use, from
 * the map's own vector tiles: by road class, and the longest named roads with
 * no route on them. Reads the tiles once and keeps them in <cache-file>.
 *
 *   node scripts/road-coverage.mjs <cache-file>
 *
 * Tiles by OpenFreeMap; © OpenMapTiles, © OpenStreetMap contributors.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { createServer } from 'vite';

const FILE = process.env.NETFILE ?? 'public/data/metro-manila-network.json';
const TILEJSON = 'https://tiles.openfreemap.org/planet';
const ZOOM = 14;
/** Metro Manila, from Navotas to Muntinlupa, Valenzuela to Marikina. */
const BOX = { west: 120.92, east: 121.13, south: 14.39, north: 14.78 };
/** A road sample is used if a route runs within this (metres): a road's width. */
const NEAR_M = 30;
const SAMPLE_M = 25;
const AT_ONCE = 6;
/** The classes a public vehicle would use. */
const MAIN = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];

const cacheFile = process.argv[2];
if (!cacheFile) {
  console.error('usage: node scripts/road-coverage.mjs <cache-file>');
  process.exit(1);
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
const net = await server.ssrLoadModule('/src/core/network/network.ts');
const { defaultRoute } = await server.ssrLoadModule('/src/core/geo/routes.ts');
const tiles = await server.ssrLoadModule('/src/core/map/tiles.ts');
const style = await server.ssrLoadModule('/src/core/map/style.ts');
const projection = defaultRoute().projection;
const data = JSON.parse(readFileSync(FILE, 'utf8'));

/** Every road piece in the box: [class, name, one-way, [[x, z], …]]. */
async function readRoads() {
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  const template = (await (await fetch(TILEJSON)).json()).tiles[0];
  const a = tiles.lngLatToTile({ lat: BOX.north, lng: BOX.west }, ZOOM);
  const b = tiles.lngLatToTile({ lat: BOX.south, lng: BOX.east }, ZOOM);
  const queue = [];
  for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++)
    for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) queue.push({ z: ZOOM, x, y });
  console.log(`${queue.length} tiles`);
  const roads = [];
  let done = 0;
  await Promise.all(
    Array.from({ length: AT_ONCE }, async () => {
      for (let t = queue.pop(); t; t = queue.pop()) {
        const url = template.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
        const res = await fetch(url, { headers: { 'User-Agent': 'SakaySightAI road coverage' } });
        if (++done % 100 === 0) console.log(`  ${done} tiles`);
        if (!res.ok) continue;
        const vt = new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())));
        const layer = vt.layers.transportation;
        const named = vt.layers.transportation_name;
        if (!layer) continue;
        const toLocal = tiles.tileToLocal(t, layer.extent, projection);
        const read = (l, take) => {
          for (let i = 0; l && i < l.length; i++) {
            const f = l.feature(i);
            if (f.type !== 2) continue;
            const cls = style.roadClass(String(f.properties.class ?? ''));
            if (!MAIN.includes(cls)) continue;
            for (const line of f.loadGeometry()) take(f, cls, line);
          }
        };
        const points = (line) =>
          line.map((p) => {
            const q = toLocal(p.x, p.y);
            return [Math.round(q.x), Math.round(q.z)];
          });
        read(layer, (f, cls, line) => {
          if (f.properties.brunnel === 'tunnel') return;
          roads.push([cls, '', f.properties.oneway ? 1 : 0, points(line)]);
        });
        read(named, (f, cls, line) => {
          if (f.properties.name) roads.push([cls, f.properties.name, 2, points(line)]);
        });
      }
    }),
  );
  writeFileSync(cacheFile, JSON.stringify(roads));
  return roads;
}

const roads = await readRoads();

// Where routes run, as a grid of cells.
const CELL_M = NEAR_M;
const used = new Set();
const cell = (x, z) => `${Math.floor(x / CELL_M)},${Math.floor(z / CELL_M)}`;
const shown = net.shownRoutes(data);
for (const m of shown) {
  const line = net.routeLine(m, projection);
  for (let s = 0; s < line.length; s += CELL_M / 2) {
    const p = line.pointAt(s);
    const cx = Math.floor(p.x / CELL_M);
    const cz = Math.floor(p.z / CELL_M);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) used.add(`${cx + dx},${cz + dz}`);
  }
}

const walk = (points, each) => {
  for (let k = 1; k < points.length; k++) {
    const [ax, az] = points[k - 1];
    const [bx, bz] = points[k];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / SAMPLE_M));
    for (let i = 0; i < n; i++)
      each(ax + ((bx - ax) * (i + 0.5)) / n, az + ((bz - az) * (i + 0.5)) / n, len / n);
  }
};

const byClass = {};
const byName = new Map();
for (const [cls, name, kind, points] of roads) {
  if (kind === 2) {
    const e = byName.get(name) ?? { cls, all: 0, empty: 0 };
    walk(points, (x, z, m) => {
      e.all += m;
      if (!used.has(cell(x, z))) e.empty += m;
    });
    byName.set(name, e);
    continue;
  }
  const c = (byClass[cls] ??= { all: 0, empty: 0 });
  walk(points, (x, z, m) => {
    c.all += m;
    if (!used.has(cell(x, z))) c.empty += m;
  });
}
console.log(`${shown.length} routes`);
for (const cls of MAIN) {
  const c = byClass[cls];
  if (c)
    console.log(
      `${cls.padEnd(10)} ${(c.all / 1000).toFixed(0).padStart(5)} km, ` +
        `${((100 * c.empty) / c.all).toFixed(0)}% has no route`,
    );
}
console.log('longest named main roads with the most empty:');
for (const [name, e] of [...byName]
  .filter(([, e]) => ['motorway', 'trunk', 'primary'].includes(e.cls))
  .sort((a, b) => b[1].empty - a[1].empty)
  .slice(0, 40))
  console.log(
    `  ${name} (${e.cls}): ${(e.all / 1000).toFixed(1)} km, ${((100 * e.empty) / e.all).toFixed(0)}% empty`,
  );

// Where routes turn right round: away from their terminals, a U-turn in the road.
const SPAN_M = 20;
const STEP_M = 10;
const TERMINAL_M = 300;
let turns = 0;
const worst = [];
for (const m of shown) {
  const route = net.networkRoute(m, projection, !data.spursRemoved);
  const line = route.polyline;
  const ends = route.stops.filter((st) => st.terminal).map((st) => st.s);
  let here = 0;
  let last = -Infinity;
  for (let s = SPAN_M; s < line.length - SPAN_M; s += STEP_M) {
    const a = line.pointAt(s - SPAN_M);
    const b = line.pointAt(s);
    const c = line.pointAt(s + SPAN_M);
    const inX = b.x - a.x;
    const inZ = b.z - a.z;
    const outX = c.x - b.x;
    const outZ = c.z - b.z;
    const cos = (inX * outX + inZ * outZ) / (Math.hypot(inX, inZ) * Math.hypot(outX, outZ) || 1);
    if (cos > -0.85 || s - last < 100) continue;
    if (ends.some((t) => Math.abs(t - s) < TERMINAL_M)) continue;
    last = s;
    here++;
  }
  turns += here;
  if (here) worst.push([m.id, m.name, here]);
}
console.log(`U-turns away from terminals: ${turns}, on ${worst.length} of ${shown.length} routes`);
for (const w of worst.sort((a, b) => b[2] - a[2]).slice(0, 14)) console.log(`  ${w.join(' ')}`);
// HIDE_TURNING=n: routes with n or more U-turns are kept in the file, marked hidden.
const hideFrom = Number(process.env.HIDE_TURNING ?? 0);
if (hideFrom > 0) {
  const turning = worst.filter((w) => w[2] >= hideFrom && !w[0].startsWith('corr-'));
  for (const [id, , count] of turning)
    data.routes.find((r) => r.id === id).hidden = `${count} U-turns in the road between its terminals`;
  writeFileSync(`${FILE}.tmp`, JSON.stringify(data));
  renameSync(`${FILE}.tmp`, FILE);
  console.log(`${turning.length} routes hidden`);
}
await server.close();
process.exit(0);
