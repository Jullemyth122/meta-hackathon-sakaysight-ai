/**
 * How many vehicles each route has, and what kinds: not one figure for every
 * route, but Metro Manila's real fleet shared out by where people are and
 * which roads they travel on, so Commonwealth is packed and Makati, where
 * more people drive, is not.
 *
 * Published figures:
 *   jeepneys   42,177 in Metro Manila (LTFRB, April 2024)
 *   UV Express 5,953 authorized in NCR (LTFRB, 2017)
 *   buses      about 4,100 on 34 routes (LTFRB, 2020)
 *   people     census of 1 July 2024, by city (PSA)
 *
 * Assumptions, because no city-by-city or route-by-route count is published:
 * each city's pull is the square root of its density, the road weights
 * (ROAD_PULL), and the share kept off public transport where more people own
 * cars (CAR_CITY), and how much more the busiest corridors carry than their
 * road class says (BUSY_CORRIDORS). Every route's size also varies a little, as real ones do.
 * The whole fleet is shared among the routes on the map, so a road's total is
 * meaningful, not any one route's franchise count.
 */

import type { LatLng, Projection } from '../geo/projection';
import type { Route } from '../geo/routes';

export const METRO_FLEET = { jeepney: 42_177, uv: 5_953, bus: 4_100 } as const;
const FLEET_TOTAL = METRO_FLEET.jeepney + METRO_FLEET.uv + METRO_FLEET.bus;

/** A city: its census population, land area (km²) and about where its middle is. */
interface City {
  name: string;
  people: number;
  km2: number;
  lat: number;
  lng: number;
}

const CITIES: readonly City[] = [
  { name: 'Manila', people: 1_902_590, km2: 42.9, lat: 14.5995, lng: 120.9842 },
  { name: 'Quezon City', people: 3_084_270, km2: 161.1, lat: 14.676, lng: 121.0437 },
  { name: 'Caloocan', people: 1_712_945, km2: 55.8, lat: 14.6507, lng: 120.9676 },
  { name: 'Malabon', people: 389_929, km2: 15.7, lat: 14.6681, lng: 120.9658 },
  { name: 'Navotas', people: 252_878, km2: 8.9, lat: 14.6667, lng: 120.9417 },
  { name: 'Valenzuela', people: 725_173, km2: 45.8, lat: 14.7011, lng: 120.983 },
  { name: 'Marikina', people: 471_323, km2: 21.5, lat: 14.6507, lng: 121.1029 },
  { name: 'Pasig', people: 853_050, km2: 48.5, lat: 14.5764, lng: 121.0851 },
  { name: 'San Juan', people: 134_312, km2: 6, lat: 14.6019, lng: 121.0355 },
  { name: 'Mandaluyong', people: 465_902, km2: 11.3, lat: 14.5794, lng: 121.0359 },
  { name: 'Makati', people: 309_770, km2: 27.4, lat: 14.5547, lng: 121.0244 },
  { name: 'Pasay', people: 453_186, km2: 19, lat: 14.5378, lng: 121.0014 },
  { name: 'Taguig', people: 1_308_085, km2: 45.2, lat: 14.5176, lng: 121.0509 },
  { name: 'Pateros', people: 67_319, km2: 2.1, lat: 14.5454, lng: 121.0687 },
  { name: 'Parañaque', people: 703_245, km2: 47.7, lat: 14.4793, lng: 121.0198 },
  { name: 'Las Piñas', people: 615_549, km2: 32.7, lat: 14.4445, lng: 120.9939 },
  { name: 'Muntinlupa', people: 552_225, km2: 39.8, lat: 14.4081, lng: 121.0415 },
];

/** More people drive here: this much of a city's pull is left (an assumption). */
const CAR_CITY: Readonly<Record<string, number>> = { Makati: 0.5, Taguig: 0.8, Pasig: 0.85 };
/** Outside Metro Manila (Bulacan, Rizal, Cavite): its feeder roads, relative to a city's. */
const OUTSIDE_PULL = 0.6;
/** Further than this from every city's middle is outside Metro Manila (kilometres). */
const CITY_REACH_KM = 9;

/** How much public transport a road carries, relative to an ordinary city road. */
const ROAD_PULL: Readonly<Record<string, number>> = {
  trunk: 4,
  motorway: 1.5,
  primary: 2.2,
  secondary: 1.3,
  tertiary: 0.8,
  busway: 2,
  minor: 0.5,
  service: 0.4,
};
/**
 * Roads that carry far more than their class says: a route on one counts for
 * this much more along it (an assumption). Few of the routes on the map run
 * on Commonwealth Avenue, and those share out their fleet over a long way.
 */
const BUSY_CORRIDORS: ReadonlyArray<{ from: LatLng; to: LatLng; pull: number }> = [
  { from: { lat: 14.653, lng: 121.051 }, to: { lat: 14.7065, lng: 121.0725 }, pull: 8 },
];
/** A route within this of a corridor's line is on it (kilometres). */
const CORRIDOR_REACH_KM = 0.4;
/** A route's road when it is not known. */
const UNKNOWN_ROAD_PULL = 1;

/** How a fleet's vehicles are shared out, each 0–1 of the whole. */
export interface FleetMix {
  modern: number;
  bus: number;
  uv: number;
}

/** A route read every this many metres. */
const SAMPLE_M = 250;
/** A UV Express line of its own, from its own terminal (an assumption). */
const OWN_LINE_FLEET = 60;
/** Buses on the bus lines (the feed's own), shared out by road; the rest run among the jeepneys. */
const ON_BUS_LINES = 0.8;
/** Fewest vehicles on any route. */
const MIN_FLEET = 3;
/** How much routes differ for reasons nothing here knows (the width of the spread). */
const ROUTE_SPREAD = 0.5;
/** Buses and UVs on an entirely big-road route, before scaling to the real fleet. */
const BIG_ROAD_BUS = 0.3;
const BIG_ROAD_UV = 0.3;
/** Modern jeepneys among the jeepneys (an assumption: the program is partway). */
const MODERN_SHARE = 0.12;

/** How much city pulls public transport at (lat, lng). */
export function cityPull({ lat, lng }: LatLng): number {
  const kmPerLng = 111 * Math.cos((lat * Math.PI) / 180);
  let nearest: City | null = null;
  let best = CITY_REACH_KM;
  for (const c of CITIES) {
    const d = Math.hypot((c.lat - lat) * 111, (c.lng - lng) * kmPerLng);
    if (d < best) [nearest, best] = [c, d];
  }
  if (!nearest) return OUTSIDE_PULL;
  const density = nearest.people / nearest.km2;
  return Math.sqrt(density / 20_000) * (CAR_CITY[nearest.name] ?? 1);
}

/** How much more a busy corridor carries at (lat, lng), else 1. */
export function corridorPull({ lat, lng }: LatLng): number {
  const kmPerLng = 111 * Math.cos((lat * Math.PI) / 180);
  for (const { from, to, pull } of BUSY_CORRIDORS) {
    const ax = (to.lng - from.lng) * kmPerLng;
    const az = (to.lat - from.lat) * 111;
    const px = (lng - from.lng) * kmPerLng;
    const pz = (lat - from.lat) * 111;
    const t = Math.max(0, Math.min(1, (px * ax + pz * az) / (ax * ax + az * az)));
    if (Math.hypot(px - ax * t, pz - az * t) < CORRIDOR_REACH_KM) return pull;
  }
  return 1;
}

/** A route's own number, 0–1, fixed by its id. */
function ownShare(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4_294_967_296;
}

/** What is planned for one route. */
export interface RoutePlan {
  fleet: number;
  mix: FleetMix;
}

interface RouteRoads {
  route: Route;
  /** [metres along, class, one-way], when known. */
  roads?: ReadonlyArray<readonly [number, string, number]>;
}

/** Every route's fleet and mix, the fleet adding up to Metro Manila's. */
export function fleetPlan(routes: readonly RouteRoads[], projection: Projection): RoutePlan[] {
  const read = routes.map(({ route, roads }) => {
    const L = route.polyline.length;
    let pull = 0;
    let big = 0;
    let samples = 0;
    let stretch = 0;
    for (let s = 0; s < L; s += SAMPLE_M) {
      samples++;
      // Road stretches are in order; the one in force here.
      while (roads && stretch + 1 < roads.length && roads[stretch + 1]![0] <= s) stretch++;
      const cls = roads?.[stretch]?.[1];
      const at = projection.toGeo(route.polyline.pointAt(s));
      pull +=
        cityPull(at) *
        corridorPull(at) *
        (cls ? (ROAD_PULL[cls] ?? UNKNOWN_ROAD_PULL) : UNKNOWN_ROAD_PULL);
      if (cls === 'trunk' || cls === 'motorway') big++;
      else if (cls === 'primary') big += 0.4;
    }
    const spread = Math.exp(ROUTE_SPREAD * (2 * ownShare(route.id) - 1));
    return {
      weight: (pull * SAMPLE_M * spread) / 1000,
      big: big / Math.max(1, samples),
    };
  });
  // A line of its own (all buses, all vans) has a small fleet; everything
  // else shares what is left.
  const mixed = routes.map(({ route }) => !route.kind || route.kind === 'jeepney');
  const whole = read.reduce((n, r, i) => n + (mixed[i] ? r.weight : 0), 0);
  const isBus = (i: number) => routes[i]!.route.kind === 'bus';
  const busWeight = read.reduce((n, r, i) => n + (isBus(i) ? r.weight : 0), 0);
  const ownFleet = (i: number) =>
    isBus(i)
      ? Math.max(
          MIN_FLEET,
          Math.round((METRO_FLEET.bus * ON_BUS_LINES * read[i]!.weight) / busWeight),
        )
      : OWN_LINE_FLEET;
  const ownLines = mixed.reduce((n, m, i) => n + (m ? 0 : ownFleet(i)), 0);
  const fleets = read.map((r, i) =>
    mixed[i]
      ? Math.max(MIN_FLEET, Math.round(((FLEET_TOTAL - ownLines) * r.weight) / whole))
      : ownFleet(i),
  );
  // Scaled so the whole fleet has as many buses and vans as there really
  // are: after the routes that are all buses or all vans.
  const own = (kind: string) =>
    fleets.reduce((n, count, i) => n + (routes[i]!.route.kind === kind ? count : 0), 0);
  const byRoad = fleets.reduce((n, count, i) => n + (mixed[i] ? count * read[i]!.big : 0), 0);
  const scaleFor = (real: number, kind: string, share: number) =>
    Math.max(0, real - own(kind)) / Math.max(1e-6, share * byRoad);
  const busScale = scaleFor(METRO_FLEET.bus, 'bus', BIG_ROAD_BUS);
  const uvScale = scaleFor(METRO_FLEET.uv, 'uv', BIG_ROAD_UV);
  return read.map((r, i) => {
    const bus = Math.min(0.5, BIG_ROAD_BUS * r.big * busScale);
    const uv = Math.min(0.4, BIG_ROAD_UV * r.big * uvScale);
    return {
      fleet: fleets[i]!,
      mix: { modern: MODERN_SHARE * (1 - bus - uv), bus, uv },
    };
  });
}
