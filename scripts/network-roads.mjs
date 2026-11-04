/**
 * Which road each network route runs on, from the map's own vector tiles, so
 * every route keeps to its side of the road, in the lanes that road has, by
 * the same rules as the bundled Tungko route. Writes `roads` ([metres along,
 * class, one-way 1/0]) on each route of public/data/metro-manila-network.json
 * that has none. Only roads the map draws are read, one tile each, once.
 *
 *   node scripts/network-roads.mjs
 *
 * Tiles (and so road classes) by OpenFreeMap; © OpenMapTiles, © OpenStreetMap
 * contributors.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { createServer } from 'vite';

const FILE = process.env.NETFILE ?? 'public/data/metro-manila-network.json';
const TILEJSON = 'https://tiles.openfreemap.org/planet';
const ZOOM = 14;
/** A road further than this from the route line is a different road (metres)… */
const MATCH_M = 15;
/** …and so is one running more than this far off the route's way (degrees). */
const MATCH_DEG = 35;
/** The line is read this often (metres). */
const STEP_M = 15;
/** A different road for less than this is a side road crossed: ignored (metres). */
const MIN_STRETCH_M = 40;
const CELL_M = 50;
const AT_ONCE = 6;

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
// CHECK=1: read every route again for the report below, and write nothing.
const CHECK = process.env.CHECK === '1';
const todo = CHECK ? data.routes : data.routes.filter((r) => !r.roads?.length);
const lines = new Map(todo.map((r) => [r.id, net.routeLine(r, projection)]));
console.log(`${todo.length} of ${data.routes.length} routes to read`);

// Every tile any of them passes through.
const wanted = new Map();
for (const line of lines.values())
  for (const t of tiles.tilesAround(line.points, projection, 50, ZOOM))
    wanted.set(`${t.x}/${t.y}`, t);
console.log(`${wanted.size} tiles`);

const template = (await (await fetch(TILEJSON)).json()).tiles[0];
/** Segments by grid cell: [ax, az, bx, bz, class, one-way, the way it runs (1, or -1)]. */
const grid = new Map();
const add = (ax, az, bx, bz, cls, oneway, way) => {
  const x0 = Math.floor((Math.min(ax, bx) - MATCH_M) / CELL_M);
  const x1 = Math.floor((Math.max(ax, bx) + MATCH_M) / CELL_M);
  const z0 = Math.floor((Math.min(az, bz) - MATCH_M) / CELL_M);
  const z1 = Math.floor((Math.max(az, bz) + MATCH_M) / CELL_M);
  for (let cx = x0; cx <= x1; cx++)
    for (let cz = z0; cz <= z1; cz++) {
      const key = `${cx},${cz}`;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push([ax, az, bx, bz, cls, oneway, way]);
    }
};

async function readTile(t) {
  const url = template.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
  const res = await fetch(url, { headers: { 'User-Agent': 'SakaySightAI hackathon route builder' } });
  if (res.status === 204 || res.status === 404) return;
  if (!res.ok) throw new Error(`Tile ${t.z}/${t.x}/${t.y}: HTTP ${res.status}`);
  const layer = new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer()))).layers
    .transportation;
  if (!layer) return;
  const toLocal = tiles.tileToLocal(t, layer.extent, projection);
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const cls = style.roadClass(String(f.properties.class ?? ''));
    if (f.type !== 2 || !style.ROADS[cls] || f.properties.brunnel === 'tunnel') continue;
    if (cls === 'path' || cls === 'track') continue;
    const oneway = f.properties.oneway === 1 || f.properties.oneway === -1 ? 1 : 0;
    for (const line of f.loadGeometry())
      for (let k = 1; k < line.length; k++) {
        const u = toLocal(line[k - 1].x, line[k - 1].y);
        const v = toLocal(line[k].x, line[k].y);
        add(u.x, u.z, v.x, v.z, cls, oneway, f.properties.oneway === -1 ? -1 : 1);
      }
  }
}

const queue = [...wanted.values()];
let done = 0;
await Promise.all(
  Array.from({ length: AT_ONCE }, async () => {
    for (let t = queue.pop(); t; t = queue.pop()) {
      await readTile(t);
      if (++done % 50 === 0) console.log(`  ${done} tiles`);
    }
  }),
);

const off = (a, b) => {
  const d = Math.abs((((a - b) % Math.PI) + Math.PI) % Math.PI);
  return Math.min(d, Math.PI - d);
};

/** The road under `line` every STEP_M, as [metres along, class, one-way]. */
function roadsUnder(line) {
  const out = [];
  let last = null;
  let onRoad = 0;
  let samples = 0;
  let oneWay = 0;
  let wrongWay = 0;
  for (let s = 0; s <= line.length; s += STEP_M) {
    samples++;
    const p = line.pointAt(s);
    const q = line.pointAt(Math.min(line.length, s + 5));
    const heading = Math.atan2(q.z - p.z, q.x - p.x);
    let best = null;
    for (const [ax, az, bx, bz, cls, oneway, way] of grid.get(
      `${Math.floor(p.x / CELL_M)},${Math.floor(p.z / CELL_M)}`,
    ) ?? []) {
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(
        0,
        Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / (dx * dx + dz * dz || 1)),
      );
      const d = Math.hypot(ax + t * dx - p.x, az + t * dz - p.z);
      if (d > MATCH_M || off(Math.atan2(dz, dx), heading) > (MATCH_DEG * Math.PI) / 180) continue;
      // The other side of a divided road can be this close: the one running our way first.
      const against = oneway === 1 && dx * way * (q.x - p.x) + dz * way * (q.z - p.z) < 0;
      const rank = d + (against ? MATCH_M : 0);
      if (!best || rank < best.rank) best = { rank, cls, oneway, against };
    }
    if (best) onRoad++;
    if (best?.oneway) {
      oneWay++;
      if (best.against) wrongWay++;
    }
    const r = best ?? last ?? { cls: 'minor', oneway: 0 };
    last = r;
    const prev = out[out.length - 1];
    if (!prev || prev[1] !== r.cls || prev[2] !== r.oneway) out.push([s, r.cls, r.oneway]);
  }
  // Short stretches are side roads crossed: back to the road either side.
  const kept = out.filter((r, i) => {
    const next = out[i + 1]?.[0] ?? line.length;
    return i === 0 || next - r[0] >= MIN_STRETCH_M;
  });
  const merged = kept.filter(
    (r, i) => i === 0 || r[1] !== kept[i - 1][1] || r[2] !== kept[i - 1][2],
  );
  return { roads: merged, matched: onRoad / samples, oneWay, wrongWay };
}

let total = 0;
let oneWaySamples = 0;
let wrongWaySamples = 0;
const wrongRoutes = [];
const byClass = {};
for (const route of todo) {
  const { roads, matched, oneWay, wrongWay } = roadsUnder(lines.get(route.id));
  if (!CHECK) route.roads = roads;
  total += matched;
  oneWaySamples += oneWay;
  wrongWaySamples += wrongWay;
  if (wrongWay > 0) wrongRoutes.push([route.id, wrongWay * STEP_M]);
  for (const [, cls] of roads) byClass[cls] = (byClass[cls] ?? 0) + 1;
}
console.log(`on a map road: ${((100 * total) / Math.max(1, todo.length)).toFixed(1)}% of the line`);
console.log(byClass);
console.log(
  `one-way road: ${(oneWaySamples * STEP_M) / 1000} km; against its direction: ` +
    `${(wrongWaySamples * STEP_M) / 1000} km, on ${wrongRoutes.length} routes`,
);
console.log(wrongRoutes.sort((a, b) => b[1] - a[1]).slice(0, 12));

if (!CHECK) {
  writeFileSync(`${FILE}.tmp`, JSON.stringify(data));
  renameSync(`${FILE}.tmp`, FILE);
  console.log(`written ${FILE}`);
}
await server.close();
process.exit(0);
