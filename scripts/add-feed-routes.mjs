// The routes of the 2015 GTFS feed the network does not have yet: every bus
// line (scripts/build-network.mjs reads jeepneys only), and the jeepney routes
// it left out because their road paths wandered.
//
//   node scripts/add-feed-routes.mjs <gtfs-folder> <cache-folder> [--limit N]
//
// Those paths wandered because the router was made to call at every stop: a
// stop listed once for both directions of a divided road sends it on to the
// next U-turn slot and back. Here it is only given a stop every few km, so
// it keeps to the road between them, and the other stops are placed on that
// path where they fall. Routes that still wander are left out, with the
// reason. Spurs are cut as in despur-network.mjs; run network-roads.mjs after
// this for each new route's road classes. Answers are kept in <cache-folder>,
// so a rerun resumes. OSRM's demo server is shared: one request a second.
// Route data: DOTC GTFS (no DOTC affiliation or endorsement may be implied).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

const FILE = process.env.NETFILE ?? 'public/data/metro-manila-network.json';
const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const USER_AGENT = 'SakaySightAI-network-build/1.0 (hackathon prototype)';
const REQUEST_GAP_MS = 1100;
/** The router is given a stop this often (metres): each tried until one fits the stops. */
const WAYPOINT_SPACINGS_M = [5000, 8000, 2500, 1200];
/** Waypoints per request; longer routes go in overlapping chunks. */
const CHUNK = 80;
/** A stop is placed on the path only within this of it (metres). */
const STOP_SNAP_M = 90;
/** Two consecutive stops closer than this are one stop (metres). */
const STOP_MERGE_M = 40;
/** The checks of build-network.mjs (and of the app: src/core/network/network.ts). */
const WANDER_FACTOR = 1.6;
const WANDER_ALLOW_M = 250;
const MAX_WANDER = 0.2;
const MIN_STOPS_PLACED = 0.7;
/** How often buses of a line run, when the feed does not say (seconds). */
const DEFAULT_HEADWAY_S = 600;

const [gtfsDir, cacheDir] = process.argv.slice(2);
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
if (!gtfsDir || !cacheDir) {
  console.error('usage: node scripts/add-feed-routes.mjs <gtfs-folder> <cache-folder> [--limit N]');
  process.exit(1);
}
mkdirSync(cacheDir, { recursive: true });

function csv(name) {
  const text = readFileSync(path.join(gtfsDir, name), 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const split = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v.trim()])));
}

const stops = new Map(
  csv('stops.txt').map((s) => [
    s.stop_id,
    { name: s.stop_name, lat: +s.stop_lat, lng: +s.stop_lon },
  ]),
);
const tripsOf = new Map();
for (const t of csv('trips.txt'))
  (tripsOf.get(t.route_id) ?? tripsOf.set(t.route_id, []).get(t.route_id)).push(t);
const stopTimes = new Map();
for (const st of csv('stop_times.txt'))
  (stopTimes.get(st.trip_id) ?? stopTimes.set(st.trip_id, []).get(st.trip_id)).push(st);
const headways = new Map();
for (const f of csv('frequencies.txt'))
  (headways.get(f.trip_id) ?? headways.set(f.trip_id, []).get(f.trip_id)).push(+f.headway_secs);

/** The stop sequence of a one-way route (its longest trip) and its headways. */
function direction(routeId) {
  let best = null;
  for (const t of tripsOf.get(routeId) ?? []) {
    const seq = (stopTimes.get(t.trip_id) ?? []).sort(
      (a, b) => +a.stop_sequence - +b.stop_sequence,
    );
    if (!best || seq.length > best.seq.length) best = { seq, trip: t.trip_id };
  }
  if (!best) return null;
  return {
    stops: best.seq.map((st) => stops.get(st.stop_id)).filter(Boolean),
    headways: headways.get(best.trip) ?? [],
  };
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
const net = await server.ssrLoadModule('/src/core/network/network.ts');
const { defaultRoute } = await server.ssrLoadModule('/src/core/geo/routes.ts');
const projection = defaultRoute().projection;

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const known = new Set(data.routes.map((r) => r.id));

// The two directions of a route share its name.
const groups = new Map();
for (const r of csv('routes.txt')) {
  if (!/^LTFRB_PU[JB]/.test(r.route_id)) continue;
  const key = r.route_long_name.toUpperCase().replace(/\s+/g, ' ');
  (groups.get(key) ?? groups.set(key, []).get(key)).push(r);
}

const toXY = ({ lat, lng }) => {
  const p = projection.toLocal({ lat, lng });
  return [p.x, p.z];
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** A stop every `spacing` metres of a run of stops, with both its ends. */
function thinned(list, spacing) {
  const out = [list[0]];
  for (let i = 1; i < list.length - 1; i++)
    if (dist(toXY(out[out.length - 1]), toXY(list[i])) >= spacing) out.push(list[i]);
  out.push(list[list.length - 1]);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;

function bearings(waypoints) {
  return waypoints.map((p, i) => {
    const q = waypoints[i + 1] ?? waypoints[1];
    const dx = (q.lng - p.lng) * Math.cos((p.lat * Math.PI) / 180);
    const dy = q.lat - p.lat;
    return Math.round(((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360);
  });
}

/** How strictly stops must snap: first by direction of travel, then looser, then not at all. */
const SNAP_RULES = [{ range: 60, radius: 150 }, { range: 100, radius: 250 }, null];

async function osrmChunk(chunk, chunkBearings) {
  for (const rule of SNAP_RULES) {
    const wait = lastRequest + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const params = new URLSearchParams({
      overview: 'full',
      geometries: 'geojson',
      continue_straight: 'true',
    });
    if (rule) {
      params.set('bearings', chunkBearings.map((b) => `${b},${rule.range}`).join(';'));
      params.set('radiuses', chunk.map(() => String(rule.radius)).join(';'));
    }
    const url = `${OSRM}/${chunk.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';')}?${params}`;
    let answer = null;
    for (let attempt = 0; attempt < 4 && !answer; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (res.status === 429 || res.status >= 500) throw new Error(`OSRM ${res.status}`);
        answer = await res.json();
      } catch (err) {
        console.warn(`  retry ${attempt + 1}: ${err.message}`);
        await sleep(5000 * (attempt + 1));
      }
    }
    const route = answer?.routes?.[0];
    if (route) return route.geometry.coordinates;
  }
  throw new Error('OSRM found no route');
}

async function osrm(waypoints, id) {
  const file = path.join(cacheDir, `${id}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const all = bearings(waypoints);
  const coords = [];
  for (let i = 0; i < waypoints.length - 1; i += CHUNK - 1) {
    const part = await osrmChunk(waypoints.slice(i, i + CHUNK), all.slice(i, i + CHUNK));
    coords.push(...(coords.length ? part.slice(1) : part));
  }
  writeFileSync(file, JSON.stringify(coords));
  return coords;
}

/** Each stop's distance along the path, in running order (never backwards). */
function placeStops(xy, cum, list) {
  const out = [];
  let from = 0;
  for (const st of list) {
    const p = toXY(st);
    let best = null;
    // The same road is passed twice, once each way: search on from the last stop.
    for (let i = from; i < xy.length - 1; i++) {
      const [ax, ay] = xy[i];
      const [bx, by] = xy[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
      const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
      if (d < STOP_SNAP_M && (!best || d < best.d))
        best = { d, s: cum[i] + t * Math.sqrt(len2), i };
      if (best && cum[i] - best.s > 3000) break;
    }
    if (!best) continue;
    from = best.i;
    if (out.length && best.s - out[out.length - 1].s < STOP_MERGE_M) continue;
    out.push({ name: st.name, s: best.s, p });
  }
  return out;
}

const added = [];
const left = [];
let n = 0;
for (const [, group] of groups) {
  group.sort((a, b) => a.route_id.localeCompare(b.route_id));
  const id = group[0].route_id.replace('LTFRB_', '').toLowerCase();
  if (known.has(id) || n >= limit) continue;
  const out = direction(group[0].route_id);
  const back = group[1] ? direction(group[1].route_id) : null;
  if (!out || out.stops.length < 2) {
    left.push([id, 'no stops']);
    continue;
  }
  n++;
  const backStops = back && back.stops.length >= 2 ? back.stops : [...out.stops].reverse();
  const loopStops = [...out.stops, ...backStops];
  let fit = null;
  for (const spacing of WAYPOINT_SPACINGS_M) {
    const waypoints = [...thinned(out.stops, spacing), ...thinned(backStops, spacing), out.stops[0]];
    let coords;
    try {
      coords = await osrm(waypoints, `${id}-${spacing}`);
    } catch {
      continue;
    }
    const xy = coords.map(([lng, lat]) => toXY({ lat, lng }));
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + dist(xy[i - 1], xy[i]));
    const length = cum[cum.length - 1];
    const placed = placeStops(xy, cum, loopStops);
    let wander = 0;
    for (let k = 1; k < placed.length; k++) {
      const extra =
        placed[k].s -
        placed[k - 1].s -
        (WANDER_FACTOR * dist(placed[k].p, placed[k - 1].p) + WANDER_ALLOW_M);
      if (extra > 0) wander += extra;
    }
    const wanderShare = wander / Math.max(1, length);
    const placedShare = placed.length / loopStops.length;
    const try_ = { coords, length, placed, wanderShare, placedShare, spacing };
    if (!fit || placedShare - 2 * wanderShare > fit.placedShare - 2 * fit.wanderShare) fit = try_;
    if (wanderShare <= MAX_WANDER && placedShare >= MIN_STOPS_PLACED) break;
  }
  if (!fit) {
    left.push([id, 'no road path']);
    continue;
  }
  const { coords, length, placed, wanderShare, placedShare } = fit;
  const label = `${n} ${id} ${group[0].route_long_name}: ${(length / 1000).toFixed(1)} km, ${placed.length}/${loopStops.length} stops, wander ${(wanderShare * 100).toFixed(1)}%, every ${fit.spacing} m`;
  if (wanderShare > MAX_WANDER || placedShare < MIN_STOPS_PLACED) {
    console.log(`${label} — left out`);
    left.push([id, `wander ${wanderShare.toFixed(2)}, stops ${placedShare.toFixed(2)}`]);
    continue;
  }
  console.log(label);
  const farName = backStops[0].name;
  const far = placed.findIndex((st, i) => i > 0 && st.name === farName);
  const straight = loopStops.reduce(
    (sum, st, i) => (i ? sum + dist(toXY(st), toXY(loopStops[i - 1])) : 0),
    0,
  );
  const hw = [...out.headways, ...(back?.headways ?? [])].sort((a, b) => a - b);
  const meta = {
    id,
    name: group[0].route_long_name,
    ...(/^LTFRB_PUB/.test(group[0].route_id) ? { kind: 'bus' } : {}),
    from: out.stops[0].name,
    to: backStops[0].name,
    length: Math.round(length),
    detour: +(length / Math.max(1, straight)).toFixed(2),
    wander: +wanderShare.toFixed(3),
    headwayS: hw.length ? hw[hw.length >> 1] : DEFAULT_HEADWAY_S,
    path: net.encodePath(coords.map(([lng, lat]) => ({ lat, lng }))),
    stops: placed.map((st) => [st.name, Math.round(st.s)]),
    stopsTotal: loopStops.length,
    terminals: [0, far > 0 ? far : Math.floor(placed.length / 2)],
  };
  // Spurs cut once, here, as the file says they are (despur-network.mjs).
  const route = net.networkRoute(meta, projection, true);
  meta.path = net.encodePath(route.polyline.points.map((p) => projection.toGeo(p)));
  meta.length = Math.round(route.polyline.length);
  meta.stops = meta.stops.map(([name], i) => [name, Math.round(route.stops[i].s * 10) / 10]);
  added.push(meta);
}

data.routes.push(...added);
data.source = data.source.replace('Routes and stops:', 'Routes and stops (jeepneys and buses):');
writeFileSync(`${FILE}.tmp`, JSON.stringify(data));
renameSync(`${FILE}.tmp`, FILE);
console.log(`\n${added.length} routes added, ${left.length} left out; ${data.routes.length} in the file`);
console.log(`buses: ${added.filter((r) => r.kind === 'bus').length}`);
for (const [id, why] of left.slice(0, 40)) console.log(`  ${id}: ${why}`);
await server.close();
process.exit(0);
