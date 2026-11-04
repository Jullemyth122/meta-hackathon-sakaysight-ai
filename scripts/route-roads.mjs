#!/usr/bin/env node
/**
 * Record which road each stretch of a route drives on, so the twin knows
 * where the kerb is: the jeepney pulls in to it at stops and people wait on
 * the pavement beside it, not somewhere out in a field.
 *
 *   node scripts/route-roads.mjs src/data/tungko-fairview.route.json
 *
 * For every point of the route line, finds the OpenStreetMap road under it
 * (nearest road segment running the same way) and stores its class and
 * whether it is one-way, run-length encoded, in the line's properties:
 *
 *   "roads": [[fromPointIndex, "primary", 0], [212, "primary", 1], ...]
 *
 * The app turns class + one-way into a width with the same table the map
 * uses (src/core/map/style.ts), so the kerb lines up with the drawn road.
 * The file is rewritten in one rename, safe while the dev server runs.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'SakaySightAI hackathon prototype (route roads script)';
/** A road further than this from the route point is a different road. */
const MATCH_M = 15;
/** A road segment must run within this angle of the route (either way). */
const MATCH_DEG = 35;

/** OSM highway=* to the map's (OpenMapTiles) road classes. */
const CLASS = {
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  busway: 'busway',
  unclassified: 'minor',
  residential: 'minor',
  living_street: 'minor',
  service: 'service',
};

async function overpass(query, tries = 4) {
  for (let i = 1; ; i++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      headers: { 'User-Agent': USER_AGENT },
    });
    if (res.ok) return res.json();
    if (i === tries) throw new Error(`Overpass responded ${res.status}`);
    console.warn(`Overpass ${res.status}, retrying in ${5 * i} s`);
    await new Promise((r) => setTimeout(r, 5000 * i));
  }
}

/** Metres east/north of `origin`, good enough over a few kilometres. */
function localOf(origin) {
  const kx = 111_320 * Math.cos((origin[1] * Math.PI) / 180);
  const ky = 110_540;
  return ([lng, lat]) => [(lng - origin[0]) * kx, (lat - origin[1]) * ky];
}

/** Distance from p to segment ab, and the segment's direction (radians). */
function toSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return { d: Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]), dir: Math.atan2(dy, dx) };
}

/** Smallest angle between two directions, ignoring which way along the road. */
function lineAngle(a, b) {
  const d = Math.abs((((a - b) % Math.PI) + Math.PI) % Math.PI);
  return Math.min(d, Math.PI - d);
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node scripts/route-roads.mjs <route.geojson>');
    process.exit(1);
  }
  const geojson = JSON.parse(await readFile(path, 'utf8'));
  const line = geojson.features.find((f) => f.geometry?.type === 'LineString');
  if (!line) throw new Error('No LineString in ' + path);
  const coords = line.geometry.coordinates;

  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const pad = 0.002;
  const bbox = [
    Math.min(...lats) - pad,
    Math.min(...lngs) - pad,
    Math.max(...lats) + pad,
    Math.max(...lngs) + pad,
  ].join(',');
  const kinds = Object.keys(CLASS).join('|');
  const data = await overpass(
    `[out:json][timeout:60];way["highway"~"^(${kinds})(_link)?$"](${bbox});out geom tags;`,
  );

  const local = localOf(coords[0]);
  const ways = data.elements
    .filter((w) => w.type === 'way' && w.geometry?.length > 1)
    .map((w) => {
      const t = w.tags ?? {};
      return {
        cls: CLASS[t.highway.replace(/_link$/, '')],
        oneway:
          t.oneway === 'yes' ||
          t.oneway === '1' ||
          t.oneway === '-1' ||
          t.junction === 'roundabout' ||
          t.highway === 'motorway',
        pts: w.geometry.map((g) => local([g.lon, g.lat])),
      };
    });
  console.log(`${ways.length} roads around the route`);

  const pts = coords.map(local);
  const perPoint = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
    let best = null;
    for (const w of ways) {
      for (let k = 1; k < w.pts.length; k++) {
        const { d, dir } = toSegment(p, w.pts[k - 1], w.pts[k]);
        if (d > MATCH_M || lineAngle(dir, heading) > (MATCH_DEG * Math.PI) / 180) continue;
        if (!best || d < best.d) best = { d, cls: w.cls, oneway: w.oneway };
      }
    }
    return best;
  });

  // Unmatched points (a junction, a gap in the data) take the previous road.
  let last = perPoint.find(Boolean) ?? { cls: 'minor', oneway: false };
  const roads = [];
  perPoint.forEach((m, i) => {
    const r = m ?? last;
    last = r;
    const prev = roads[roads.length - 1];
    const oneway = r.oneway ? 1 : 0;
    if (!prev || prev[1] !== r.cls || prev[2] !== oneway) roads.push([i, r.cls, oneway]);
  });
  const missed = perPoint.filter((m) => !m).length;
  console.log(`${roads.length} stretches; ${missed} of ${pts.length} points unmatched`);
  for (const [i, cls, oneway] of roads)
    console.log(`  from point ${i}: ${cls}${oneway ? ' (one-way)' : ''}`);

  line.properties.roads = roads;
  line.properties.roadsFetchedAt = new Date().toISOString();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(geojson, null, 2) + '\n');
  await rename(tmp, path);
  console.log(`Wrote ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
