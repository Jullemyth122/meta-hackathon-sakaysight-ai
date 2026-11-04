#!/usr/bin/env node
/**
 * Gas stations around a route, once, offline.
 *
 *   node scripts/fetch-fuel.mjs src/data/tungko-fairview.route.json src/data/fuel-stations.json
 *
 * Two sources, merged:
 *
 *   OpenStreetMap   every station within AREA_M of the route line (the
 *                   neighbourhoods the map shows, not just the road): its
 *                   forecourt outline when mapped as an area, its brand
 *                   (normalised to the names the DOE price monitoring uses),
 *                   and whatever fuel:* and opening_hours tags mappers added.
 *   survey          stations the team checked on the ground that
 *                   OpenStreetMap is missing (src/data/fuel-stations.survey.json),
 *                   with a position from a phone GPS at the station.
 *
 * OpenStreetMap is incomplete here: several stations on Malaria Road and in
 * Bagong Silang are not mapped at all. Add them by surveying (or better,
 * map them in OpenStreetMap with the Every Door or StreetComplete app, then
 * re-run this). Never copy positions from Google Maps: its terms forbid it,
 * and so do OpenStreetMap's.
 *
 * Prices are not in either source; they come from the DOE
 * (src/data/diesel-prices.json).
 *
 * Overpass is a shared free service: run this once and commit the output.
 * Data © OpenStreetMap contributors (ODbL).
 */

import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'SakaySightAI hackathon prototype (fuel stations script)';
/** Stations within this of the route are shown: the area the map covers around it. */
const AREA_M = 4000;
/** --metro-manila: the network's area, with San Jose del Monte and the edges of Rizal, Cavite and Bulacan. */
const METRO_MANILA_BBOX = '14.30,120.88,14.86,121.20';
/** Two records of one brand closer than this are the same station mapped twice. */
const SAME_STATION_M = 40;
const SURVEY_PATH = 'src/data/fuel-stations.survey.json';

/** OSM brand/name spellings to one name each (DOE's where it has one). */
const BRANDS = [
  [/^petron/i, 'Petron'],
  [/^shell/i, 'Shell'],
  [/^caltex/i, 'Caltex'],
  [/^phoenix/i, 'Phoenix'],
  [/^(total|totalenergies)/i, 'Total'],
  [/^flying\s*v/i, 'Flying V'],
  [/^uni\s*oil/i, 'Unioil'],
  [/^sea\s*oil/i, 'Seaoil'],
  [/^ptt/i, 'PTT'],
  [/^clean\s*fuel/i, 'Cleanfuel'],
  [/^jade\s*blue/i, 'Jade Blue'],
  [/^uno(\s*fuel)?\b|^unofuel/i, 'Uno Fuel'],
  [/^jetti/i, 'Jetti'],
  [/^boss\b/i, 'Boss'],
  [/^power\s*fill/i, 'Powerfill'],
];
/** Brand names that, on a retail area or a canopy, are a station even without amenity=fuel. */
const STATION_NAMES =
  'petron|shell|caltex|phoenix|total|totalenergies|flying v|unioil|seaoil|ptt|cleanfuel|clean fuel|jetti|uno fuel';

function brandOf(tags) {
  const raw = (tags.brand ?? tags.name ?? '').trim();
  for (const [re, name] of BRANDS) if (re.test(raw)) return name;
  return raw || 'Gas station';
}

async function overpass(query, tries = 5) {
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

/** Metres between two [lng, lat] points (small distances). */
function metres([lng1, lat1], [lng2, lat2]) {
  const kx = 111_320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot((lng2 - lng1) * kx, (lat2 - lat1) * 110_540);
}

function fromOsm(e) {
  const t = e.tags ?? {};
  // Nodes carry lat/lon; with `out geom` areas carry bounds instead of a centre.
  const b = e.bounds;
  const centre =
    e.lat !== undefined
      ? { lat: e.lat, lon: e.lon }
      : (e.center ?? (b && { lat: (b.minlat + b.maxlat) / 2, lon: (b.minlon + b.maxlon) / 2 }));
  if (!centre) return null;
  return {
    id: `${e.type}/${e.id}`,
    source: 'osm',
    name: t.name ?? null,
    brand: brandOf(t),
    at: [+centre.lon.toFixed(7), +centre.lat.toFixed(7)],
    // A way is the forecourt outline; a node is just a point.
    outline:
      e.type === 'way' && e.geometry?.length > 2
        ? e.geometry.map((g) => [+g.lon.toFixed(7), +g.lat.toFixed(7)])
        : null,
    fuels: Object.keys(t)
      .filter((k) => k.startsWith('fuel:') && t[k] === 'yes')
      .map((k) => k.slice(5)),
    hours: t.opening_hours ?? null,
  };
}

async function surveyed() {
  if (!existsSync(SURVEY_PATH)) return [];
  const { stations = [] } = JSON.parse(await readFile(SURVEY_PATH, 'utf8'));
  return stations.map((s, i) => ({
    id: `survey/${i + 1}`,
    source: 'survey',
    name: s.name ?? null,
    brand: brandOf({ brand: s.brand, name: s.name }),
    at: s.at,
    outline: null,
    fuels: s.fuels ?? [],
    hours: s.hours ?? null,
  }));
}

async function main() {
  const [routePath, outPath] = process.argv.slice(2);
  if (!routePath || !outPath) {
    console.error('Usage: node scripts/fetch-fuel.mjs <route.geojson | --metro-manila> <out.json>');
    process.exit(1);
  }
  // A whole area (the network's), or the stations around one route.
  let around = METRO_MANILA_BBOX;
  if (routePath !== '--metro-manila') {
    const route = JSON.parse(await readFile(routePath, 'utf8'));
    const line = route.features.find((f) => f.geometry?.type === 'LineString');
    // Every 8th vertex is plenty for a 4 km area and keeps the query short.
    around = `around:${AREA_M},${line.geometry.coordinates
      .filter((_, i) => i % 8 === 0)
      .map(([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`)
      .join(',')}`;
  }
  // Stations are mostly amenity=fuel. Some are mapped only as a retail area
  // or a canopy carrying the brand name, or with fuel:* tags; those count
  // too. Closed or demolished ones (disused:/razed:amenity=fuel) do not:
  // they have no amenity tag at all, and a brand-named retail area also
  // needs no lifecycle tag.
  const data = await overpass(
    `[out:json][timeout:120];(` +
      `nwr[amenity=fuel](${around});` +
      `nwr[~"^fuel:"~"^yes$"][!amenity][!shop](${around});` +
      `nwr["name"~"^(${STATION_NAMES})$",i][landuse=retail][!amenity][!"disused:amenity"][!"razed:amenity"](${around});` +
      `nwr["name"~"^(${STATION_NAMES})$",i][building=roof][!amenity][!"disused:amenity"][!"razed:amenity"](${around});` +
      `);out center geom tags;`,
  );

  // Areas first, so a station mapped as both a point and its forecourt keeps the forecourt.
  const osm = data.elements
    .map(fromOsm)
    .filter(Boolean)
    .sort((a, b) => Number(!!b.outline) - Number(!!a.outline));
  const stations = [];
  for (const s of [...osm, ...(await surveyed())]) {
    const twin = stations.find((o) => o.brand === s.brand && metres(o.at, s.at) < SAME_STATION_M);
    if (!twin) stations.push(s);
  }
  stations.sort((a, b) => a.id.localeCompare(b.id));

  const out = {
    source:
      'OpenStreetMap (© OpenStreetMap contributors, ODbL) plus team survey (fuel-stations.survey.json)',
    areaM: routePath === '--metro-manila' ? null : AREA_M,
    ...(routePath === '--metro-manila' && { bbox: METRO_MANILA_BBOX }),
    fetchedAt: new Date().toISOString(),
    stations,
  };
  const tmp = `${outPath}.tmp`;
  await writeFile(tmp, JSON.stringify(out, null, 1) + '\n');
  await rename(tmp, outPath);

  const brands = {};
  for (const s of stations) brands[s.brand] = (brands[s.brand] ?? 0) + 1;
  console.log(
    `${stations.length} stations: ${osm.length} OpenStreetMap records (` +
      `${osm.length - stations.filter((s) => s.source === 'osm').length} duplicates merged), ` +
      `${stations.filter((s) => s.source === 'survey').length} surveyed, ` +
      `${stations.filter((s) => s.outline).length} with outlines`,
  );
  console.log(JSON.stringify(brands));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
