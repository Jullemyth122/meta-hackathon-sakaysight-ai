// Skyway, NLEX, SLEX and the like, in the network file: no jeepney runs on an
// expressway, and nobody gets on or off a bus up there.
//
//   node scripts/keep-off-expressways.mjs [public/data/metro-manila-network.json]
//
// A jeepney route with more than MAX_ON_EXPRESSWAY_M of expressway is kept in
// the file but marked hidden, with the reason: the router, not knowing what
// a jeepney may use, took the expressway over the service road beneath it. A
// bus may use one, but a stop on it (not a terminal) is taken off; the road
// classes come from network-roads.mjs. Running it again changes nothing.
// Writes beside the file, then renames.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const file = process.argv[2] ?? 'public/data/metro-manila-network.json';
/** Less than this is a ramp crossed or a road read wrongly at a junction (metres). */
const MAX_ON_EXPRESSWAY_M = 300;

const data = JSON.parse(readFileSync(file, 'utf8'));

/** The stretches of a route on an expressway, as [from, to] metres along it. */
function expressway(route) {
  const roads = route.roads ?? [];
  return roads.flatMap(([s, cls], i) =>
    cls === 'motorway' ? [[s, roads[i + 1]?.[0] ?? route.length]] : [],
  );
}

let hidden = 0;
let taken = 0;
for (const route of data.routes) {
  if (route.hidden) continue;
  const stretches = expressway(route);
  if (route.kind === 'bus') {
    const terminals = route.terminals.map((t) => route.stops[t]);
    const kept = route.stops.filter(
      (st) => terminals.includes(st) || !stretches.some(([a, b]) => st[1] >= a && st[1] <= b),
    );
    taken += route.stops.length - kept.length;
    route.stopsTotal -= route.stops.length - kept.length;
    route.stops = kept;
    route.terminals = terminals.map((st) => kept.indexOf(st));
  } else if (stretches.reduce((m, [a, b]) => m + b - a, 0) > MAX_ON_EXPRESSWAY_M) {
    route.hidden = 'Runs on an expressway, where jeepneys do not';
    hidden++;
  }
}
writeFileSync(`${file}.tmp`, JSON.stringify(data));
renameSync(`${file}.tmp`, file);
console.log(`${hidden} jeepney routes hidden, ${taken} stops taken off expressways`);
