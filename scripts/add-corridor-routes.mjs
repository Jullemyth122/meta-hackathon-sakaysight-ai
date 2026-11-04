// The Quirino Highway corridor routes as riders know them, built on
// OpenStreetMap roads, in place of the 2015 GTFS routes that wander through
// San Jose del Monte's subdivisions.
//
//   node scripts/add-corridor-routes.mjs [public/data/metro-manila-network.json]
//
// Each route: terminal to terminal and back by road (OSRM's public demo
// server on OpenStreetMap, one request a second), a stop about every
// STOP_EVERY_M named after the nearest landmark (or else the road), spurs cut
// (src/core/network/spurs.ts), and the road under each stretch (class and
// one-way, from the map's own vector tiles), so the twin puts its kerbs,
// stops and waiting riders beside the road as the map draws it, not in it. The GTFS routes listed in HIDE are kept in the
// file but marked hidden, with the reason. Running it again replaces the
// corridor routes it added before. Writes beside the file, then renames.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { createServer } from 'vite';

const file = process.argv[2] ?? 'public/data/metro-manila-network.json';
const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const STOP_EVERY_M = 600;
const LANDMARK_M = 150;
/** A stop of the bundled Tungko route this close names the corridor's stop (riders know it). */
const KNOWN_STOP_M = 300;
/** Else a road's stop is "<road> near <place>", the nearest place this close. */
const NEAR_PLACE_M = 700;
/** The map's tiles (src/config.ts mapTiles): the kerbs follow the roads as drawn. */
const TILEJSON = 'https://tiles.openfreemap.org/planet';
/** A road further than this from the route line is a different road (metres)… */
const MATCH_M = 15;
/** …and so is one running more than this far off the route's way (degrees). */
const MATCH_DEG = 35;

/** Terminals (OpenStreetMap; SM Tungko and SM Fairview as on the bundled route). */
const PLACES = {
  sapangPalay: { name: 'Sapang Palay (SPYGTSC Terminal)', lat: 14.84139, lng: 121.04304 },
  tungko: { name: 'Tungko - San Jose Jeepney Station', lat: 14.789079, lng: 121.07523 },
  smFairview: { name: 'SM City Fairview Jeepney Terminal', lat: 14.7349, lng: 121.06069 },
  lagro: { name: 'Lagro', lat: 14.735425, lng: 121.068873 },
  // San Jose del Monte's town centre (Bayan), by the city hall and Poblacion market.
  sjdm: { name: 'San Jose del Monte (Bayan)', lat: 14.810353, lng: 121.04778 },
  // The Philcoa jeepney stop on Commonwealth Avenue (OSM node 1005404590).
  philcoa: { name: 'Philcoa', lat: 14.654094, lng: 121.052831 },
  // On Commonwealth Avenue's southbound carriageway: keeps the router on it.
  commonwealthSouth: { name: 'Commonwealth Avenue', lat: 14.691291, lng: 121.087109, via: true },
  // The long-distance terminals (OpenStreetMap via Nominatim, 30 Oct 2026).
  smTungko: { name: 'SM City San Jose del Monte (SM Tungko)', lat: 14.7860692, lng: 121.0746414 },
  cubaoUv: { name: "Cubao (Farmers' Plaza, EDSA)", lat: 14.6202226, lng: 121.0517231 },
  cubaoBus: { name: 'Cubao (Araneta Center Bus Terminal)', lat: 14.6216816, lng: 121.0551894 },
  quiapo: { name: 'Quiapo (Plaza Miranda)', lat: 14.5988612, lng: 120.9837971 },
  ayala: { name: 'Makati (One Ayala)', lat: 14.5504667, lng: 121.0279287 },
  // EDSA at Cubao, southbound: keeps the way to Makati on EDSA.
  edsaCubao: { name: 'EDSA', lat: 14.6202226, lng: 121.0517231, via: true },
};

/**
 * The routes riders name for the corridor (28–29 Oct 2026): Sapang Palay or
 * SM Tungko to SM Fairview or Lagro. Tungko – SM Fairview is the bundled
 * route already. Sapang Palay jeepneys come down through Tungko. Headways are
 * estimates (no published counts).
 */
const CORRIDOR = [
  {
    id: 'corr-sapang-fairview',
    name: 'Sapang Palay - SM Fairview',
    stops: ['sapangPalay', 'tungko', 'smFairview'],
    headwayS: 120,
  },
  {
    id: 'corr-sapang-lagro',
    name: 'Sapang Palay - Lagro',
    stops: ['sapangPalay', 'tungko', 'lagro'],
    headwayS: 120,
  },
  { id: 'corr-tungko-lagro', name: 'SM Tungko - Lagro', stops: ['tungko', 'lagro'], headwayS: 120 },
  // Down Quirino Highway and Commonwealth Avenue to Philcoa, 2–3 hours each
  // way by a rider's account (30 Oct 2026); some from the town centre of San
  // Jose del Monte through Gaya-Gaya, some from SM Tungko. Headways are
  // estimates.
  {
    id: 'corr-sjdm-philcoa',
    name: 'San Jose del Monte - Philcoa via Commonwealth',
    stops: ['sjdm', 'tungko', 'commonwealthSouth', 'philcoa'],
    headwayS: 180,
  },
  {
    id: 'corr-tungko-philcoa',
    name: 'SM Tungko - Philcoa via Commonwealth',
    stops: ['tungko', 'commonwealthSouth', 'philcoa'],
    headwayS: 180,
  },
  // Not jeepneys: the far commutes from SM Tungko (a rider's account, 30 Oct
  // 2026: to Cubao, Quiapo and Manila, Kamuning, Makati), by UV Express
  // (point to point: loads at its terminals, leaves full, lets riders off on
  // the way) and by city bus (a stop about every kilometre). Their own
  // terminals, not the jeepneys'. Headways are estimates.
  {
    id: 'corr-uv-tungko-cubao',
    name: 'UV Express: SM Tungko - Cubao',
    kind: 'uv',
    stops: ['smTungko', 'commonwealthSouth', 'cubaoUv'],
    headwayS: 480,
    stopEveryM: 1500,
  },
  {
    id: 'corr-uv-tungko-quiapo',
    name: 'UV Express: SM Tungko - Quiapo',
    kind: 'uv',
    stops: ['smTungko', 'commonwealthSouth', 'quiapo'],
    headwayS: 720,
    stopEveryM: 1500,
  },
  {
    id: 'corr-uv-tungko-ayala',
    name: 'UV Express: SM Tungko - Makati (Ayala) via EDSA',
    kind: 'uv',
    stops: ['smTungko', 'commonwealthSouth', 'edsaCubao', 'ayala'],
    headwayS: 900,
    stopEveryM: 1500,
  },
  {
    id: 'corr-bus-tungko-quiapo',
    name: 'Bus: SM Tungko - Quiapo via Commonwealth',
    kind: 'bus',
    stops: ['smTungko', 'commonwealthSouth', 'quiapo'],
    headwayS: 600,
    stopEveryM: 1000,
  },
  {
    id: 'corr-bus-tungko-cubao',
    name: 'Bus: SM Tungko - Cubao',
    kind: 'bus',
    stops: ['smTungko', 'commonwealthSouth', 'cubaoBus'],
    headwayS: 600,
    stopEveryM: 1000,
  },
  {
    id: 'corr-bus-tungko-ayala',
    name: 'Bus: SM Tungko - Makati (Ayala) via EDSA',
    kind: 'bus',
    stops: ['smTungko', 'commonwealthSouth', 'edsaCubao', 'ayala'],
    headwayS: 600,
    stopEveryM: 1000,
  },
];

/** 2015 GTFS routes through San Jose del Monte's subdivisions: hidden, not deleted. */
const HIDE = [
  'puj1348',
  'puj1494',
  'puj1506',
  'puj2367',
  'puj2369',
  'puj2411',
  'puj2415',
  'puj2269',
];
const HIDE_REASON =
  'Hidden 29 Oct 2026: its 2015 GTFS path winds through San Jose del Monte subdivisions; riders know the corridor as Sapang Palay / SM Tungko to SM Fairview / Lagro (added as corr-* routes).';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function osrm(points) {
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const res = await fetch(`${OSRM}/${coords}?overview=full&geometries=geojson&steps=true`, {
    headers: { 'User-Agent': 'SakaySightAI hackathon route builder' },
  });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const body = await res.json();
  if (body.code !== 'Ok') throw new Error(`OSRM: ${body.code}`);
  await sleep(1100);
  return body.routes[0];
}

let tileTemplate = null;
/** The map's vector tiles' road lines around `points` (local metres): class, one-way, points. */
async function mapRoads(points) {
  tileTemplate ??= (await (await fetch(TILEJSON)).json()).tiles[0];
  const out = [];
  for (const t of tiles.tilesAround(points, projection, 50, 14)) {
    const url = tileTemplate.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SakaySightAI hackathon route builder' },
    });
    if (res.status === 204 || res.status === 404) continue;
    if (!res.ok) throw new Error(`Tile ${t.z}/${t.x}/${t.y}: HTTP ${res.status}`);
    const layer = new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer()))).layers
      .transportation;
    if (!layer) continue;
    const toLocal = tiles.tileToLocal(t, layer.extent, projection);
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const cls = style.roadClass(String(f.properties.class ?? ''));
      if (f.type !== 2 || !style.ROADS[cls] || f.properties.brunnel === 'tunnel') continue;
      const oneway = f.properties.oneway === 1 || f.properties.oneway === -1;
      for (const line of f.loadGeometry())
        if (line.length > 1) out.push({ cls, oneway, pts: line.map((q) => toLocal(q.x, q.y)) });
    }
  }
  return out;
}

/**
 * The road under each stretch of `line` (local metres), as the map draws
 * it: [metres along, class, one-way 1/0], a new entry wherever it changes.
 * Each point takes the nearest map road within MATCH_M running its way; a
 * point with none (a junction) keeps the road before it.
 */
async function roadsUnder(line) {
  const pts = line.points;
  const ways = await mapRoads(pts);
  const angle = (a, b) => {
    const d = Math.abs((((a - b) % Math.PI) + Math.PI) % Math.PI);
    return Math.min(d, Math.PI - d);
  };
  // Each segment in every CELL_M cell within MATCH_M of it.
  const CELL_M = 50;
  const grid = new Map();
  for (const w of ways)
    for (let k = 1; k < w.pts.length; k++) {
      const u = w.pts[k - 1];
      const v = w.pts[k];
      const x0 = Math.floor((Math.min(u.x, v.x) - MATCH_M) / CELL_M);
      const x1 = Math.floor((Math.max(u.x, v.x) + MATCH_M) / CELL_M);
      const z0 = Math.floor((Math.min(u.z, v.z) - MATCH_M) / CELL_M);
      const z1 = Math.floor((Math.max(u.z, v.z) + MATCH_M) / CELL_M);
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) {
          const key = `${cx},${cz}`;
          (grid.get(key) ?? grid.set(key, []).get(key)).push({ w, u, v });
        }
    }
  const roads = [];
  let last = null;
  let missed = 0;
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const heading = Math.atan2(b.z - a.z, b.x - a.x);
    let best = null;
    for (const { w, u, v } of grid.get(`${Math.floor(p.x / CELL_M)},${Math.floor(p.z / CELL_M)}`) ??
      []) {
      const dx = v.x - u.x;
      const dz = v.z - u.z;
      const t = Math.max(
        0,
        Math.min(1, ((p.x - u.x) * dx + (p.z - u.z) * dz) / (dx * dx + dz * dz || 1)),
      );
      const d = Math.hypot(u.x + t * dx - p.x, u.z + t * dz - p.z);
      if (d > MATCH_M || angle(Math.atan2(dz, dx), heading) > (MATCH_DEG * Math.PI) / 180) continue;
      if (!best || d < best.d) best = { d, cls: w.cls, oneway: w.oneway };
    }
    if (!best) missed++;
    const r = best ?? last ?? { cls: 'minor', oneway: false };
    last = r;
    const prev = roads[roads.length - 1];
    const oneway = r.oneway ? 1 : 0;
    if (!prev || prev[1] !== r.cls || prev[2] !== oneway)
      roads.push([Math.round(line.cumulative[i] * 10) / 10, r.cls, oneway]);
  });
  console.log(`  ${missed} of ${pts.length} points on no map road (kept the one before)`);
  return roads;
}

const data = JSON.parse(readFileSync(file, 'utf8'));
const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
const net = await server.ssrLoadModule('/src/core/network/network.ts');
const { defaultRoute } = await server.ssrLoadModule('/src/core/geo/routes.ts');
const { Polyline } = await server.ssrLoadModule('/src/core/geo/polyline.ts');
const tiles = await server.ssrLoadModule('/src/core/map/tiles.ts');
const style = await server.ssrLoadModule('/src/core/map/style.ts');
const projection = defaultRoute().projection;
const places = JSON.parse(readFileSync('public/data/metro-manila-places.json', 'utf8')).places.map(
  ([name, kind, lat, lng]) => ({ name, kind, at: projection.toLocal({ lat, lng }) }),
);
// The bundled route's stops (Malaria, Sampaguita, Lagro…): the names riders use on Quirino.
const tungko = defaultRoute();
const knownStops = tungko.stops.map((st) => ({ name: st.name, at: tungko.polyline.pointAt(st.s) }));

data.routes = data.routes.filter((r) => !r.id.startsWith('corr-'));
for (const r of data.routes) if (HIDE.includes(r.id)) r.hidden = HIDE_REASON;

for (const c of CORRIDOR) {
  const ends = c.stops.map((k) => PLACES[k]);
  const out = await osrm(ends);
  // A via point is on the outward carriageway: the way back goes without it.
  const back = await osrm([...ends].reverse().filter((p) => !p.via));
  // The loop: out, then back, each in local metres; road names along the way.
  const named = [];
  const pts = [];
  for (const leg of [out, back])
    for (const l of leg.legs)
      for (const step of l.steps)
        for (const [lng, lat] of step.geometry.coordinates) {
          const p = projection.toLocal({ lat, lng });
          const last = pts[pts.length - 1];
          if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.5) continue;
          pts.push(p);
          named.push(step.name || '');
        }
  const line = new Polyline(pts);
  const outM = new Polyline(pts.slice(0, out.geometry.coordinates.length)).length;
  // A stop every STOP_EVERY_M, named after the nearest landmark, else the road.
  // A stop's name: a stop of the Tungko route by it (the name riders use);
  // else a landmark there; else the road, "near" the nearest place, so no
  // two read the same.
  const nearest = (list, p, within) => {
    let best = null;
    let bestD = within;
    for (const pl of list) {
      const d = Math.hypot(pl.at.x - p.x, pl.at.z - p.z);
      if (d < bestD) [best, bestD] = [pl.name, d];
    }
    return best;
  };
  const stopAt = (s, before) => {
    const p = line.pointAt(s);
    // The road there: the vertex nearest along the path.
    let i = 0;
    while (i < pts.length - 1 && line.cumulative[i + 1] < s) i++;
    const road = named[i] || 'Unnamed road';
    const by = nearest(places, p, NEAR_PLACE_M);
    const names = [
      nearest(knownStops, p, KNOWN_STOP_M),
      nearest(places, p, LANDMARK_M),
      by && `${road} near ${by}`,
      road,
    ];
    // Not the name of the stop before it, when there is another.
    return names.find((n) => n && n !== before) ?? road;
  };
  const every = c.stopEveryM ?? STOP_EVERY_M;
  const stops = [[ends[0].name, 0]];
  const terminals = [0];
  for (let s = every; s < line.length - every / 2; s += every) {
    // The far terminal, in its place on the way.
    if (s - every < outM && s >= outM) {
      terminals.push(stops.length);
      stops.push([ends[ends.length - 1].name, Math.round(outM)]);
      if (s - outM < every / 2) continue;
    }
    stops.push([stopAt(s, stops[stops.length - 1]?.[0]), Math.round(s)]);
  }
  const meta = {
    id: c.id,
    name: c.name,
    from: ends[0].name,
    to: ends[ends.length - 1].name,
    length: Math.round(line.length),
    detour: 1,
    wander: 0,
    headwayS: c.headwayS,
    path: net.encodePath(pts.map((p) => projection.toGeo(p))),
    stops,
    stopsTotal: stops.length,
    terminals,
    source: 'OpenStreetMap roads via OSRM; terminals from OpenStreetMap',
    ...(c.kind && { kind: c.kind }),
  };
  // Cut any spurs the router left, as for the rest of the network.
  const route = net.networkRoute(meta, projection, true);
  meta.path = net.encodePath(route.polyline.points.map((p) => projection.toGeo(p)));
  meta.length = Math.round(route.polyline.length);
  meta.stops = meta.stops.map(([name], i) => [name, Math.round(route.stops[i].s * 10) / 10]);
  meta.roads = await roadsUnder(route.polyline);
  data.routes.push(meta);
  console.log(
    `${c.name}: ${(meta.length / 1000).toFixed(1)} km round trip, ${stops.length} stops, far terminal at ${(outM / 1000).toFixed(1)} km, ${meta.roads.length} road stretches`,
  );
  console.log(`  by ${[...new Set(named.filter(Boolean))].join(' → ')}`);
}

writeFileSync(`${file}.tmp`, JSON.stringify(data));
renameSync(`${file}.tmp`, file);
console.log(`${HIDE.length} GTFS routes hidden; ${CORRIDOR.length} corridor routes added.`);
await server.close();
