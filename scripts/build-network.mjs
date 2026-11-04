#!/usr/bin/env node
/**
 * Build the Metro Manila jeepney network, once, offline.
 *
 *   node scripts/build-network.mjs <gtfs-folder> <cache-folder> [--alt <cache-folder>] [--limit N]
 *
 * Input: the DOTC Philippine Transit GTFS feed for Metro Manila (2015; the
 * copy published by Sakay.ph at github.com/sakayph/gtfs). It lists each
 * jeepney route (LTFRB_PUJ*) as two one-way routes, with their stops and
 * headways, but no road geometry.
 *
 * For each route the two directions are joined into one loop (out by one
 * way, back by the other), and the road path through its stops is computed
 * by OSRM on OpenStreetMap roads, with no U-turns at stops. Stops are placed
 * on the loop in their running order.
 *
 * Output: public/data/metro-manila-network.json, fetched by the app when the
 * network is opened (too big to bundle).
 *
 * The OSRM demo server is a shared free service: this runs at one request a
 * second, keeps every answer in <cache-folder> so a rerun resumes, and is
 * meant to be run once and the output committed. Route data: DOTC GTFS
 * (licence allows use in apps that help public transport riders; no DOTC
 * affiliation or endorsement may be implied). Roads: © OpenStreetMap
 * contributors (ODbL).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const USER_AGENT = 'SakaySightAI-network-build/1.0 (hackathon prototype)';
/** Waypoints per OSRM request; longer routes go in overlapping chunks. */
const CHUNK = 80;
const REQUEST_GAP_MS = 1100;
/** Path simplification tolerance (metres): finer than a lane. */
const SIMPLIFY_M = 3;
/** A stop is placed on the loop only within this distance of it. */
const STOP_SNAP_M = 60;
/** Two consecutive stops closer than this are one stop. */
const STOP_MERGE_M = 40;
/**
 * Road between two stops longer than this × the straight line plus this
 * allowance is a wander (e.g. to a U-turn slot on the wrong carriageway).
 * One-way grids and blocks stay well inside it.
 */
const WANDER_FACTOR = 1.6;
const WANDER_ALLOW_M = 250;
/**
 * Only routes whose path stays close to their stops are written (the app
 * checks again, src/core/network/network.ts): at most this share of the
 * path wandering, and at least this share of the stops placed.
 */
const MAX_WANDER = 0.2;
const MIN_STOPS_PLACED = 0.7;

const [gtfsDir, cacheDir] = process.argv.slice(2);
const limitArg = process.argv.indexOf('--limit');
const altArg = process.argv.indexOf('--alt');
/** A second cache of paths (another way of routing); each route keeps whichever is better. */
const altDir = altArg > 0 ? process.argv[altArg + 1] : null;
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
if (!gtfsDir || !cacheDir) {
  console.error(
    'usage: node scripts/build-network.mjs <gtfs-folder> <cache-folder> [--alt <cache-folder>] [--limit N]',
  );
  process.exit(1);
}
mkdirSync(cacheDir, { recursive: true });

// ---------------------------------------------------------------- GTFS

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
const routes = csv('routes.txt').filter((r) => /^LTFRB_PUJ/.test(r.route_id));
const trips = csv('trips.txt');
const tripsOf = new Map();
for (const t of trips)
  (tripsOf.get(t.route_id) ?? tripsOf.set(t.route_id, []).get(t.route_id)).push(t);
const stopTimes = new Map();
for (const st of csv('stop_times.txt')) {
  (stopTimes.get(st.trip_id) ?? stopTimes.set(st.trip_id, []).get(st.trip_id)).push(st);
}
const headways = new Map();
for (const f of csv('frequencies.txt')) {
  (headways.get(f.trip_id) ?? headways.set(f.trip_id, []).get(f.trip_id)).push(+f.headway_secs);
}

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

// The two directions of a route share its name and have consecutive ids.
const groups = new Map();
for (const r of routes) {
  const key = r.route_long_name.toUpperCase().replace(/\s+/g, ' ');
  (groups.get(key) ?? groups.set(key, []).get(key)).push(r);
}

// ---------------------------------------------------------------- Geometry

/** Shared scene origin: the bundled Tungko route's first point (see routes.ts). */
const tungko = JSON.parse(
  readFileSync(new URL('../src/data/tungko-fairview.route.json', import.meta.url)),
);
const [originLng, originLat] = tungko.features.find((f) => f.geometry.type === 'LineString')
  .geometry.coordinates[0];
// The app's projection exactly (src/core/geo/projection.ts), so the stop
// distances written here match the polyline the app builds from the path.
const EARTH_RADIUS_M = 6_371_008.8;
const KY = (EARTH_RADIUS_M * Math.PI) / 180;
const KX = KY * Math.cos((originLat * Math.PI) / 180);
const toXY = ([lng, lat]) => [(lng - originLng) * KX, -(lat - originLat) * KY];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function simplify(points, tol) {
  if (points.length < 3) return points.map((_, i) => i);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let far = -1;
    let farD = tol;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(
        0,
        Math.min(1, ((points[i][0] - ax) * dx + (points[i][1] - ay) * dy) / len2),
      );
      const d = Math.hypot(points[i][0] - (ax + t * dx), points[i][1] - (ay + t * dy));
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return [...keep.keys()].filter((i) => keep[i]);
}

/** Google polyline encoding at 1e6 precision ([lng, lat] in, "lat,lng" order out). */
function encode(coords) {
  let out = '';
  let pLat = 0;
  let pLng = 0;
  const num = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const [lng, lat] of coords) {
    const la = Math.round(lat * 1e6);
    const ln = Math.round(lng * 1e6);
    out += num(la - pLat) + num(ln - pLng);
    pLat = la;
    pLng = ln;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;

/**
 * Compass bearing (degrees from north) of travel at each waypoint: towards
 * the next one. A stop listed once for both directions of a divided road
 * then snaps to the carriageway going this way, not the opposite one (which
 * would send the path kilometres to the next U-turn slot and back).
 */
function bearings(waypoints) {
  return waypoints.map((p, i) => {
    const q = waypoints[i + 1] ?? waypoints[1];
    const dx = (q.lng - p.lng) * Math.cos((p.lat * Math.PI) / 180);
    const dy = q.lat - p.lat;
    return Math.round(((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360);
  });
}

/** How strictly stops must snap: first by direction of travel, then looser, then not at all. */
const SNAP_RULES = [{ range: 70, radius: 60 }, { range: 120, radius: 120 }, null];

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
    let data = null;
    for (let attempt = 0; attempt < 4 && !data; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (res.status === 429 || res.status >= 500) throw new Error(`OSRM ${res.status}`);
        data = await res.json();
      } catch (err) {
        console.warn(`  retry ${attempt + 1}: ${err.message}`);
        await sleep(5000 * (attempt + 1));
      }
    }
    const route = data?.routes?.[0];
    if (route) return route.geometry.coordinates;
    // NoSegment/NoRoute: a stop could not be matched this strictly; loosen.
  }
  throw new Error('OSRM found no route');
}

/** Road path through the waypoints, from the cache or OSRM (one request a second). */
async function osrm(waypoints, cacheKey) {
  const file = path.join(cacheDir, `${cacheKey}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const allBearings = bearings(waypoints);
  const coords = [];
  for (let i = 0; i < waypoints.length - 1; i += CHUNK - 1) {
    const part = await osrmChunk(waypoints.slice(i, i + CHUNK), allBearings.slice(i, i + CHUNK));
    coords.push(...(coords.length ? part.slice(1) : part));
  }
  writeFileSync(file, JSON.stringify(coords));
  return coords;
}

/** Each stop's distance along the loop, in running order (never backwards). */
function placeStops(xy, cum, stopList) {
  const out = [];
  let from = 0;
  for (const st of stopList) {
    const p = toXY([st.lng, st.lat]);
    let best = null;
    // Search forward from the last stop: the same road is passed twice on
    // a loop, once each way, and the stop belongs to this pass.
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
      // Past the first good match by more than a few km: stop looking.
      if (best && cum[i] - best.s > 3000) break;
    }
    if (!best) continue;
    from = best.i;
    if (out.length && best.s - out[out.length - 1].s < STOP_MERGE_M) continue;
    out.push({ name: st.name, s: best.s, p });
  }
  return out;
}

/** Two paths are spliced only where they pass this close (metres): about a road's width, no visible jump. */
const SPLICE_M = 35;
/** …within this far of a stop both of them reach. */
const SPLICE_WINDOW_M = 150;

/**
 * Two road paths through the same stops usually wander in different
 * places. Stitch them: between each pair of stops both reach, take the
 * shorter, switching paths only at stops where they run within SPLICE_M of
 * each other. A small dynamic programme picks the shortest combination.
 */
function stitch(a, b, stopList) {
  const prep = (coords) => {
    const xy = coords.map(toXY);
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + dist(xy[i - 1], xy[i]));
    // Each stop's nearest point index, in running order (as placeStops).
    const at = [];
    let from = 0;
    for (const st of stopList) {
      const p = toXY([st.lng, st.lat]);
      let best = -1;
      let bestD = STOP_SNAP_M;
      for (let i = from; i < xy.length; i++) {
        const d = dist(xy[i], p);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
        if (best >= 0 && cum[i] - cum[best] > 3000) break;
      }
      at.push(best);
      if (best >= 0) from = best;
    }
    return { coords, xy, cum, at };
  };
  const P = [prep(a), prep(b)];
  const common = stopList.map((_, j) => j).filter((j) => P[0].at[j] >= 0 && P[1].at[j] >= 0);
  if (common.length < 2) return null;
  // Where the paths can be swapped at each common stop: [index in a, index in b] or null.
  const splice = common.map((j) => {
    const [A, B] = P;
    let best = null;
    for (let i = A.at[j]; i >= 0 && A.cum[A.at[j]] - A.cum[i] <= SPLICE_WINDOW_M; i--)
      for (let k = B.at[j]; k >= 0 && B.cum[B.at[j]] - B.cum[k] <= SPLICE_WINDOW_M; k--) {
        const d = dist(A.xy[i], B.xy[k]);
        if (d <= SPLICE_M && (!best || d < best.d)) best = { d, i, k };
      }
    return best ? [best.i, best.k] : null;
  });
  // Shortest choice of path per segment, switching only where splice allows.
  const cost = [[0, 0]];
  const from = [[-1, -1]];
  for (let t = 1; t < common.length; t++) {
    const seg = P.map((Q) => Q.cum[Q.at[common[t]]] - Q.cum[Q.at[common[t - 1]]]);
    cost.push([0, 0]);
    from.push([0, 0]);
    for (let q = 0; q < 2; q++) {
      const stay = cost[t - 1][q];
      const swapIn = splice[t - 1] ? cost[t - 1][1 - q] : Infinity;
      from[t][q] = stay <= swapIn ? q : 1 - q;
      cost[t][q] = Math.min(stay, swapIn) + (seg[q] >= 0 ? seg[q] : Infinity);
    }
  }
  let q = cost.at(-1)[0] <= cost.at(-1)[1] ? 0 : 1;
  const choice = [];
  for (let t = common.length - 1; t >= 1; t--) {
    choice[t] = q;
    q = from[t][q];
  }
  choice[0] = choice[1];
  // Walk the chosen pieces: start of path, segments, end of path.
  const out = [];
  let cur = choice[1];
  let i = 0;
  for (let t = 1; t < common.length; t++) {
    if (choice[t] !== cur) {
      const [ia, ib] = splice[t - 1];
      const cut = cur === 0 ? ia : ib;
      out.push(...P[cur].coords.slice(i, cut + 1));
      cur = choice[t];
      i = cur === 0 ? ia : ib;
    }
  }
  out.push(...P[cur].coords.slice(i));
  return out;
}

// ---------------------------------------------------------------- Build

const network = [];
const skipped = [];
let n = 0;
for (const [name, group] of groups) {
  if (n >= limit) break;
  group.sort((a, b) => a.route_id.localeCompare(b.route_id));
  const out = direction(group[0].route_id);
  const back = group[1] ? direction(group[1].route_id) : null;
  if (!out || out.stops.length < 2) {
    skipped.push([name, 'no stops']);
    continue;
  }
  n++;
  // Out one way, back the other; a route listed one way only runs back
  // through its stops in reverse.
  const backStops = back && back.stops.length >= 2 ? back.stops : [...out.stops].reverse();
  const loopStops = [...out.stops, ...backStops];
  const waypoints = [...loopStops, out.stops[0]];
  const id = group[0].route_id.replace('LTFRB_', '').toLowerCase();
  process.stdout.write(`${n} ${id} ${name} (${waypoints.length} stops)… `);
  const candidates = [];
  try {
    candidates.push(await osrm(waypoints, id));
  } catch (err) {
    console.log(`(${err.message}) `);
  }
  if (altDir && existsSync(path.join(altDir, `${id}.json`)))
    candidates.push(JSON.parse(readFileSync(path.join(altDir, `${id}.json`), 'utf8')));
  if (candidates.length === 0) {
    console.log('skipped');
    skipped.push([name, 'no road path']);
    continue;
  }
  if (candidates.length === 2) {
    const stitched = stitch(candidates[0], candidates[1], loopStops);
    if (stitched) candidates.push(stitched);
  }
  // Each way of routing it, measured; the one that places most stops with
  // least wandering wins.
  const built = candidates
    .map((coords) => {
      const keep = simplify(coords.map(toXY), SIMPLIFY_M);
      // Rounded as encoded, so distances here are the ones the app measures.
      const round6 = (v) => Math.round(v * 1e6) / 1e6;
      const kept = keep.map((i) => [round6(coords[i][0]), round6(coords[i][1])]);
      const xy = kept.map(toXY);
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
      const wanderRatio = wander / Math.max(1, length);
      return {
        kept,
        length,
        placed,
        wanderRatio,
        score: placed.length / loopStops.length - 2 * wanderRatio,
      };
    })
    .sort((x, y) => y.score - x.score)[0];
  const { kept, length, placed } = built;
  // The far terminal: where the way back starts. Matched by name, which the
  // feed reuses, so the app moves it to where the road turns round
  // (placeFarTerminal in src/core/network/network.ts).
  const farName = backStops[0].name;
  const far = placed.findIndex((st, i) => i > 0 && st.name === farName);
  const straight = loopStops.reduce(
    (sum, st, i) =>
      i
        ? sum + dist(toXY([st.lng, st.lat]), toXY([loopStops[i - 1].lng, loopStops[i - 1].lat]))
        : 0,
    0,
  );
  const hw = [...out.headways, ...(back?.headways ?? [])].sort((a, b) => a - b);
  network.push({
    id,
    name: group[0].route_long_name,
    from: out.stops[0].name,
    to: backStops[0].name,
    length: Math.round(length),
    // Road length over stop-to-stop distance (one-way grids push it up too).
    detour: +(length / Math.max(1, straight)).toFixed(2),
    // Share of the path that wandered away between stops: the quality check.
    wander: +built.wanderRatio.toFixed(3),
    headwayS: hw.length ? hw[hw.length >> 1] : 600,
    path: encode(kept),
    stops: placed.map((st) => [st.name, Math.round(st.s)]),
    stopsTotal: loopStops.length,
    terminals: [0, far > 0 ? far : Math.floor(placed.length / 2)],
  });
  console.log(
    `${(length / 1000).toFixed(1)} km, ${placed.length}/${loopStops.length} stops placed, wander ${(built.wanderRatio * 100).toFixed(1)}%`,
  );
}

const kept = network.filter(
  (r) => r.wander <= MAX_WANDER && r.stops.length >= MIN_STOPS_PLACED * r.stopsTotal,
);
const outFile = new URL('../public/data/metro-manila-network.json', import.meta.url);
mkdirSync(new URL('../public/data/', import.meta.url), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify({
    origin: { lat: originLat, lng: originLng },
    source:
      'Routes and stops: DOTC Philippine Transit GTFS for Metro Manila (2015), via Sakay.ph. ' +
      'Road paths: OSRM on OpenStreetMap (© OpenStreetMap contributors). Not affiliated with or endorsed by DOTC. ' +
      'Routes may have changed since 2015 (route rationalization); verify before relying on them.',
    routesInFeed: network.length,
    routes: kept,
  }),
);
console.log(
  `\n${network.length} routes built, ${kept.length} close enough to their stops written, ${skipped.length} skipped`,
);
if (skipped.length)
  console.log(
    skipped
      .slice(0, 30)
      .map((s) => s.join(': '))
      .join('\n'),
  );
