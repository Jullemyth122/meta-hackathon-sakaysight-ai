#!/usr/bin/env node
/**
 * Build a route GeoJSON from OpenStreetMap data, once, offline.
 *
 * Two ways to get the road geometry:
 *
 *   --relation <id>   An OSM route relation (when the jeepney route is mapped).
 *   --osrm <a;b;...>  Waypoints "lng,lat;lng,lat". The road path between them
 *                     is computed by OSRM on OSM roads, with no U-turns. Use
 *                     this when the route is not mapped as a relation
 *                     (Tungko–SM Fairview is not).
 *
 * Either way, the OSM bus stops within 30 m of the line are added as Point
 * features, so the twin uses real stop locations instead of placeholders.
 * A line that doubles back on itself is refused: jeepneys turn round only at
 * their terminals.
 *
 * A jeepney route that runs one way out and another way back (one-way roads,
 * a turnaround loop at the end) is a loop: pass waypoints that start and end
 * at the same terminal, `--loop yes`, and the terminals where everyone gets
 * off and the next trip loads. The first terminal must be the start:
 *
 *   npm run route:fetch -- \
 *     --osrm "121.075230,14.789079;121.080737,14.768668;121.062608,14.735455;121.060689,14.73459;121.0555,14.730379;121.07794,14.744513;121.080713,14.768788;121.075230,14.789079" \
 *     --loop yes \
 *     --terminals "Tungko - San Jose Jeepney Station@121.075230,14.789079;SM City Fairview Jeepney Terminal@121.06069,14.73490" \
 *     --name "Tungko – SM City Fairview" --from Tungko --to "SM City Fairview" \
 *     --out src/data/tungko-fairview.route.json
 *   node scripts/route-roads.mjs src/data/tungko-fairview.route.json
 *
 * Waypoints: Tungko jeepney station (OSM node 3189049330), Quirino Hwy
 * southbound at Malaria, Quirino near SM, the SM terminal, Regalado, Quirino
 * northbound, northbound at Malaria, back to the station.
 *
 * Overpass and the OSRM demo server are shared free services: run this once
 * and commit the output, never call them from the app. Data © OpenStreetMap
 * contributors (ODbL); keep the attribution wherever the map is shown.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const USER_AGENT = 'SakaySightAI hackathon prototype (route fetch script)';
const STOP_RADIUS_M = 30;

function args() {
  const out = {
    relation: null,
    osrm: null,
    name: null,
    from: null,
    to: null,
    loop: null,
    terminals: null,
    out: 'public/data/route.geojson',
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key in out) out[key] = argv[i + 1];
  }
  const validRelation = out.relation && /^\d+$/.test(out.relation);
  if (!validRelation && !out.osrm) {
    console.error(
      'Usage: npm run route:fetch -- (--relation <id> | --osrm "lng,lat;lng,lat") ' +
        '[--loop yes] [--terminals "Name@lng,lat;..."] [--name ..] [--from ..] [--to ..] [--out path]',
    );
    process.exit(1);
  }
  return out;
}

async function overpass(query) {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`Overpass responded ${res.status}`);
  return res.json();
}

/**
 * Chain the relation's ways into one continuous line. OSM ways can be stored
 * in either direction, so each next way is flipped if that makes it connect.
 */
function chainWays(ways) {
  const key = (p) => `${p.lat},${p.lon}`;
  const line = [...ways[0]];
  for (const way of ways.slice(1)) {
    const end = key(line[line.length - 1]);
    if (key(way[0]) === end) line.push(...way.slice(1));
    else if (key(way[way.length - 1]) === end) line.push(...way.reverse().slice(1));
    else if (line.length === ways[0].length && key(line[0]) === key(way[0])) {
      // The first way itself was reversed.
      line.reverse();
      line.push(...way.slice(1));
    } else {
      console.warn('Gap in relation geometry; joining with a straight segment.');
      line.push(...way);
    }
  }
  return line;
}

/** @returns {Promise<{coords: number[][], props: object}>} [lng, lat] pairs */
async function fromRelation(relation) {
  const data = await overpass(
    `[out:json][timeout:60];relation(${relation});way(r);out geom;relation(${relation});out tags;`,
  );
  const rel = data.elements.find((e) => e.type === 'relation');
  const ways = data.elements.filter((e) => e.type === 'way' && e.geometry).map((w) => w.geometry);
  if (!ways.length) throw new Error('Relation has no way geometry');
  return {
    coords: chainWays(ways).map((p) => [p.lon, p.lat]),
    props: {
      name: rel?.tags?.name ?? `OSM relation ${relation}`,
      from: rel?.tags?.from,
      to: rel?.tags?.to,
      osmRelation: Number(relation),
      geometry: 'OSM route relation',
    },
  };
}

/**
 * A jeepney never U-turns on the road: it keeps to its franchise route and
 * turns around only at a terminal, through the streets around it. So OSRM
 * may not turn round at a waypoint (continue_straight) and must reach each
 * one on the kerb side (approaches=curb); it then finds the legal way round
 * a block itself. Put the terminal waypoints on that block, not mid-road.
 */
async function fromOsrm(waypoints) {
  const count = waypoints.split(';').length;
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    continue_straight: 'true',
    approaches: Array(count).fill('curb').join(';'),
  });
  const res = await fetch(`${OSRM}/${waypoints}?${params}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`OSRM responded ${res.status}`);
  const data = await res.json();
  const route = data.routes?.[0];
  if (!route) throw new Error(`OSRM found no route: ${data.code}`);
  return {
    coords: route.geometry.coordinates,
    props: {
      geometry:
        'Road path through the waypoints computed by OSRM on OpenStreetMap roads, ' +
        'respecting one-way streets and turn restrictions, with no U-turns. ' +
        'Not an official route record: verify by riding.',
    },
  };
}

/** Heading change counted over this much road either side of a point. */
const UTURN_SPAN_M = 12;
const UTURN_DEG = 150;

/**
 * Points where the line doubles back on itself (a U-turn), including where
 * a loop's end meets its start. Returns [index, degrees] pairs.
 */
function uTurns(coords, loop) {
  const kx = 111_320 * Math.cos((coords[0][1] * Math.PI) / 180);
  const ky = 110_540;
  const p = coords.map(([lng, lat]) => [lng * kx, lat * ky]);
  if (loop) p.push(p[1]);
  const s = [0];
  for (let i = 1; i < p.length; i++)
    s.push(s[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  const reach = (i, dir) => {
    let k = i;
    while (k + dir >= 0 && k + dir < p.length && Math.abs(s[k] - s[i]) < UTURN_SPAN_M) k += dir;
    return k;
  };
  const found = [];
  for (let i = 1; i < p.length - 1; i++) {
    const a = reach(i, -1);
    const b = reach(i, 1);
    if (s[i] - s[a] < 3 || s[b] - s[i] < 3) continue;
    const h1 = Math.atan2(p[i][1] - p[a][1], p[i][0] - p[a][0]);
    const h2 = Math.atan2(p[b][1] - p[i][1], p[b][0] - p[i][0]);
    let d = (Math.abs(h2 - h1) * 180) / Math.PI;
    if (d > 180) d = 360 - d;
    if (d > UTURN_DEG) found.push([i, Math.round(d)]);
  }
  return found;
}

/** OSM bus stops near the line, as GeoJSON Points. */
async function stopsAlong(coords) {
  // Every 4th vertex is plenty for a 30 m corridor and keeps the query short.
  const sample = coords.filter((_, i) => i % 4 === 0 || i === coords.length - 1);
  const around = sample.map(([lng, lat]) => `${lat.toFixed(6)},${lng.toFixed(6)}`).join(',');
  const data = await overpass(
    `[out:json][timeout:60];(` +
      `node[highway=bus_stop](around:${STOP_RADIUS_M},${around});` +
      `node[public_transport=platform](around:${STOP_RADIUS_M},${around});` +
      `);out;`,
  );
  return data.elements.map((n) => ({
    type: 'Feature',
    properties: { name: n.tags?.name ?? null, osmNode: n.id, kind: 'stop' },
    geometry: { type: 'Point', coordinates: [n.lon, n.lat] },
  }));
}

async function main() {
  const opts = args();
  const { coords, props } = opts.osrm
    ? await fromOsrm(opts.osrm)
    : await fromRelation(opts.relation);
  const turns = uTurns(coords, opts.loop === 'yes');
  if (turns.length > 0) {
    for (const [i, deg] of turns) console.error(`U-turn (${deg}°) at ${coords[i % coords.length]}`);
    throw new Error('The route U-turns on the road; move the waypoints (see fromOsrm)');
  }
  const stops = await stopsAlong(coords);
  // "Name@lng,lat;Name@lng,lat": where everyone gets off and the next trip loads.
  const terminals = (opts.terminals ?? '')
    .split(';')
    .filter(Boolean)
    .map((entry) => {
      const [name, at] = entry.split('@');
      const [lng, lat] = at.split(',').map(Number);
      return {
        type: 'Feature',
        properties: { name, kind: 'terminal' },
        geometry: { type: 'Point', coordinates: [lng, lat] },
      };
    });

  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          ...props,
          name: opts.name ?? props.name ?? 'Unnamed route',
          from: opts.from ?? props.from ?? null,
          to: opts.to ?? props.to ?? null,
          loop: opts.loop === 'yes',
          source: 'osm',
          attribution: '© OpenStreetMap contributors',
          fetchedAt: new Date().toISOString(),
        },
        geometry: { type: 'LineString', coordinates: coords },
      },
      ...terminals,
      ...stops,
    ],
  };
  await mkdir(dirname(opts.out), { recursive: true });
  await writeFile(opts.out, JSON.stringify(geojson, null, 1) + '\n');
  console.log(
    `Saved ${coords.length} points, ${terminals.length} terminals and ${stops.length} stops to ${opts.out}`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
