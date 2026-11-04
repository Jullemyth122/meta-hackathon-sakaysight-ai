#!/usr/bin/env node
/**
 * Fetch the places Metro Manila commuters name, once, offline: districts and
 * neighbourhoods (Quiapo, Cubao, Philcoa), malls (SM North EDSA), train
 * stations, markets (Divisoria), schools, hospitals and terminals, from
 * OpenStreetMap. The commuter app searches these so a trip can start or end
 * at a landmark, not only at a GTFS stop (whose names are intersections).
 *
 *   node scripts/fetch-places.mjs
 *
 * Output: public/data/metro-manila-places.json ([name, kind, lat, lng] rows).
 * Overpass is a shared free service: run once and commit the output. Data
 * © OpenStreetMap contributors (ODbL).
 */

import { mkdirSync, writeFileSync } from 'node:fs';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'SakaySightAI hackathon prototype (places script)';
/** Metro Manila with San Jose del Monte and the edges of Rizal, Cavite and Bulacan. */
const BBOX = '14.30,120.88,14.86,121.20';
/** Two places of the same name closer than this are one (a mall mapped as a node and a way). */
const SAME_PLACE_M = 300;

const query = `[out:json][timeout:120];
(
  node[place~"^(city|town|suburb|quarter|neighbourhood|village)$"][name](${BBOX});
  nwr[shop=mall][name](${BBOX});
  nwr[railway=station][name](${BBOX});
  nwr[public_transport=station][name](${BBOX});
  nwr[amenity~"^(marketplace|bus_station|university|college|hospital|townhall)$"][name](${BBOX});
);
out center tags;`;

async function overpass(q, tries = 5) {
  for (let i = 1; ; i++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      body: new URLSearchParams({ data: q }),
      headers: { 'User-Agent': USER_AGENT },
    });
    if (res.ok) return res.json();
    if (i === tries) throw new Error(`Overpass responded ${res.status}`);
    await new Promise((r) => setTimeout(r, 15000 * i));
  }
}

function kindOf(tags) {
  if (tags.place) return tags.place === 'city' || tags.place === 'town' ? 'city' : 'area';
  if (tags.shop === 'mall') return 'mall';
  if (tags.railway === 'station' || tags.public_transport === 'station') return 'station';
  if (tags.amenity === 'marketplace') return 'market';
  if (tags.amenity === 'bus_station') return 'terminal';
  if (tags.amenity === 'hospital') return 'hospital';
  if (tags.amenity === 'townhall') return 'city hall';
  return 'school';
}

const metres = (a, b) =>
  Math.hypot(
    (a.lat - b.lat) * 111_195,
    (a.lng - b.lng) * 111_195 * Math.cos((a.lat * Math.PI) / 180),
  );

const data = await overpass(query);
const places = [];
for (const el of data.elements) {
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  const name = el.tags?.name?.trim();
  if (!name || lat === undefined || lng === undefined) continue;
  const p = { name, kind: kindOf(el.tags), lat, lng };
  if (places.some((q) => q.name === p.name && metres(q, p) < SAME_PLACE_M)) continue;
  places.push(p);
}
places.sort((a, b) => a.name.localeCompare(b.name));
mkdirSync(new URL('../public/data/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../public/data/metro-manila-places.json', import.meta.url),
  JSON.stringify({
    source: 'OpenStreetMap (© OpenStreetMap contributors, ODbL), via Overpass',
    places: places.map((p) => [p.name, p.kind, +p.lat.toFixed(6), +p.lng.toFixed(6)]),
  }),
);
const count = {};
for (const p of places) count[p.kind] = (count[p.kind] ?? 0) + 1;
console.log(`${places.length} places`, count);
