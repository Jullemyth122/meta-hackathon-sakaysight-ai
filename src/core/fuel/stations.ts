/**
 * Gas stations along the route, and what diesel costs there.
 *
 * Where they are comes from OpenStreetMap plus stations the team surveyed
 * (src/data/fuel-stations.json, scripts/fetch-fuel.mjs): ~150 stations
 * within 4 km of the route, most with their forecourt outline. OpenStreetMap
 * still misses some here (fuel-stations.survey.json lists them to check).
 * What diesel costs comes from the DOE's
 * weekly NCR price monitoring (src/data/diesel-prices.json): the lowest and
 * highest pump price per brand in Caloocan and Quezon City that week. There
 * is no per-station price feed in the Philippines, so a station shows its
 * brand's range, not its own pump price.
 *
 * A jeepney can only use a station it can pull straight into: on its own
 * side of the road (it may not cross traffic or U-turn, see fetch-route.mjs),
 * right beside its lane. The rest are on the map but not offered to drivers.
 */

import pricesJson from '@/data/diesel-prices.json';
import stationsJson from '@/data/fuel-stations.json';
import type { LocalPoint } from '../geo/projection';
import { aheadOf, kerbAt, type Route } from '../geo/routes';
import type { RoadEdge, StationFit } from '../map/streets';

export interface FuelStation {
  id: string;
  name: string | null;
  brand: string;
  at: LocalPoint;
  /** Forecourt outline when mapped as an area, else null (a point). */
  outline: LocalPoint[] | null;
  /** Fuels mappers tagged (rarely filled in); every station here sells diesel. */
  fuels: string[];
  hours: string | null;
  /** Along-route position of the nearest point of the route. */
  s: number;
  /** Metres from the route line. */
  roadM: number;
  /** Side of the road, for a jeepney driving towards higher s. */
  side: 'left' | 'right';
}

/** Close enough to the lane to pull in (the forecourt may be set back a little). */
export const PULL_IN_M = 45;

/** The brands the DOE lists by name; everything else is "Independent". */
const DOE_BRANDS = new Set(
  Object.values(pricesJson.cities).flatMap((c) => Object.keys(c.diesel.brands)),
);
export const priceGroup = (brand: string) => (DOE_BRANDS.has(brand) ? brand : 'Independent');

export interface PriceRange {
  min: number;
  max: number;
}

/** A brand's pump price range on this route this week (Caloocan and Quezon City together). */
export function dieselPrice(
  brand: string,
  product: 'diesel' | 'dieselPlus' = 'diesel',
): PriceRange | null {
  const group = priceGroup(brand);
  let range: PriceRange | null = null;
  for (const city of Object.values(pricesJson.cities)) {
    const r = (city[product].brands as Record<string, number[]>)[group];
    if (!r) continue;
    range = range
      ? { min: Math.min(range.min, r[0]!), max: Math.max(range.max, r[1]!) }
      : { min: r[0]!, max: r[1]! };
  }
  return range;
}

/** The price most stations on this route charged this week (the DOE "common price"). */
export const DIESEL_COMMON_PHP_PER_L = (() => {
  const commons = Object.values(pricesJson.cities).map((c) => c.diesel.common);
  return Math.round((commons.reduce((a, b) => a + b, 0) / commons.length) * 100) / 100;
})();
export const DIESEL_WEEK = pricesJson.week;
export const DIESEL_SOURCE = pricesJson.source;

type RawStation = (typeof stationsJson.stations)[number];

/** Stations further than this from a route are not its (the area its map covers). */
export const STATION_AREA_M = 4000;

/**
 * Every station of the Metro Manila network (public/data, loaded with the
 * network); until then, the bundled ones around the Tungko route.
 */
let allStations: RawStation[] = stationsJson.stations as RawStation[];
export function setStationData(raw: readonly RawStation[]): void {
  allStations = [...raw];
  measured = new WeakMap();
}

/**
 * Each route's stations, as measured for the stations known then: measuring
 * every station in Metro Manila against a route is not for every time a
 * driver checks their diesel. Cleared when the stations change.
 */
let measured = new WeakMap<Route, FuelStation[]>();

/** The stations near a route, placed in its local metres and against its line. */
export function stationsFor(route: Route): FuelStation[] {
  const known = measured.get(route);
  if (known) return known;
  const near = measureStations(route);
  measured.set(route, near);
  return near;
}

function measureStations(route: Route): FuelStation[] {
  const projection = route.projection;
  if (!projection) return [];
  const local = ([lng, lat]: number[]) => projection.toLocal({ lat: lat!, lng: lng! });
  // Only stations in the route's box (plus the area) are measured against its line.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of route.polyline.points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const near: FuelStation[] = [];
  for (const raw of allStations) {
    const at = local(raw.at);
    if (at.x < minX - STATION_AREA_M || at.x > maxX + STATION_AREA_M) continue;
    if (at.z < minZ - STATION_AREA_M || at.z > maxZ + STATION_AREA_M) continue;
    const foot = route.polyline.project(at);
    if (foot.offset > STATION_AREA_M) continue;
    // Right of travel is (sin h, cos h) for heading h (see lanes.ts).
    const right =
      (at.x - foot.x) * Math.sin(foot.heading) + (at.z - foot.z) * Math.cos(foot.heading) > 0;
    near.push({
      id: raw.id,
      name: raw.name,
      brand: raw.brand,
      at,
      outline: raw.outline ? (raw.outline as number[][]).map(local) : null,
      fuels: raw.fuels,
      hours: raw.hours,
      s: foot.s,
      roadM: foot.offset,
      side: right ? 'right' : 'left',
    });
  }
  return near;
}

/** Whether a jeepney driving `direction` can pull straight into `st`. */
export function canPullIn(st: FuelStation, direction: 1 | -1): boolean {
  return st.roadM <= PULL_IN_M && st.side === (direction === 1 ? 'right' : 'left');
}

/**
 * A jeepney's way through a forecourt: it turns off the road at `inS`, drives
 * along the pumps `depthM` off its lane (one lane of pumps more, further in,
 * for each of `bays` beyond the first), and comes back out at `outS`. Both
 * along-route, in its direction of travel; `lengthM` apart.
 */
export interface Forecourt {
  inS: number;
  outS: number;
  lengthM: number;
  depthM: number;
  bays: number;
}

/** The shortest stretch of road a jeepney turns in and back out over (metres). */
const FORECOURT_MIN_M = 24;
/** No stop in a forecourt, nor within this of its ends (a jeepney never skips a stop in there). */
const STOP_CLEAR_M = 8;
/**
 * Every station is built the same (scene/world/FuelStations.tsx): this long
 * beside the road and this deep from its edge, with two lanes of pumps this far
 * in, an island between them. Room for four or five jeepneys or buses at once.
 */
export const STATION_LENGTH_M = 46;
export const STATION_DEPTH_M = 30;
export const STATION_LANES_M = [8.5, 13] as const;
/** Between two lanes of pumps (metres). */
export const BAY_APART_M = STATION_LANES_M[1] - STATION_LANES_M[0];

/** Where a station a route's vehicles use stands: on the kerb their way through runs along. */
export function placeOnRoute(route: Route, st: FuelStation): RoadEdge | null {
  if (st.side !== 'right' || st.roadM > PULL_IN_M) return null;
  const p = route.polyline.pointAt(st.s);
  const h = route.polyline.headingAt(st.s, STATION_LENGTH_M / 2);
  const nx = Math.sin(h);
  const nz = Math.cos(h);
  const kerb = kerbAt(route, st.s);
  return {
    x: p.x + nx * kerb,
    z: p.z + nz * kerb,
    ux: Math.cos(h),
    uz: -Math.sin(h),
    nx,
    nz,
  };
}

/** The ground to clear of the map's buildings for each station on `route`: as paths 10 m wide. */
export function stationClearancePaths(route: Route): LocalPoint[][] {
  return stationsFor(route).flatMap((st) => {
    const edge = placeOnRoute(route, st);
    if (!edge) return [];
    const half = STATION_LENGTH_M / 2;
    return [5, 13, 21, 27].map((inM) => [
      {
        x: edge.x - edge.ux * half + edge.nx * inM,
        z: edge.z - edge.uz * half + edge.nz * inM,
      },
      {
        x: edge.x + edge.ux * half + edge.nx * inM,
        z: edge.z + edge.uz * half + edge.nz * inM,
      },
    ]);
  });
}

/**
 * The way through `st`'s forecourt for a jeepney driving `direction`: along
 * the station as built (cut to be clear of the stops), by the two lanes of
 * pumps (`laneAt`: the lane's metres from the route line). Null when no
 * stretch long enough is clear of the stops.
 */
export function forecourtAlong(
  route: Route,
  st: FuelStation,
  direction: 1 | -1,
  laneAt: (s: number) => number,
  /** Where it stands as fitted among the map's roads, when that is known. */
  fit?: Pick<StationFit, 'back' | 'slide' | 'length'>,
): Forecourt | null {
  const L = route.polyline.length;
  const near = (s: number) => (route.loop ? s + Math.round((st.s - s) / L) * L : s);
  const middle = st.s + (fit?.slide ?? 0);
  const half = (fit?.length ?? STATION_LENGTH_M) / 2;
  let lo = middle - half;
  let hi = middle + half;
  for (const stop of route.stops) {
    const s = near(stop.s);
    if (s < lo - STOP_CLEAR_M || s > hi + STOP_CLEAR_M) continue;
    // Keep the longer side of the stop.
    if (s - lo >= hi - s) hi = Math.min(hi, s - STOP_CLEAR_M);
    else lo = Math.max(lo, s + STOP_CLEAR_M);
  }
  if (!route.loop && (lo < 0 || hi > L)) return null;
  if (hi - lo < FORECOURT_MIN_M) return null;
  const depthM = kerbAt(route, st.s) + (fit?.back ?? 0) + STATION_LANES_M[0] - laneAt(st.s);
  const wrap = (s: number) => (route.loop ? ((s % L) + L) % L : s);
  return {
    inS: wrap(direction === 1 ? lo : hi),
    outS: wrap(direction === 1 ? hi : lo),
    lengthM: hi - lo,
    depthM,
    bays: STATION_LANES_M.length,
  };
}

/**
 * How far around the driver their map shows gas stations: a few minutes'
 * drive. Further ones are not drawn for them, but still known: the advice
 * (fuelAhead, and the assistant) looks FUEL_LOOKAHEAD_M ahead and says
 * which stations are on the map and which are further on.
 */
export const DRIVER_MAP_RADIUS_M = 2500;

/** Stations within `radiusM` of a point, in a straight line (what the map shows). */
export function stationsNear(
  stations: readonly FuelStation[],
  x: number,
  z: number,
  radiusM = DRIVER_MAP_RADIUS_M,
): FuelStation[] {
  return stations.filter((st) => Math.hypot(st.at.x - x, st.at.z - z) <= radiusM);
}

/** Where a jeepney is: along the route, which way, and on the map. */
export interface Whereabouts {
  s: number;
  direction: 1 | -1;
  x: number;
  z: number;
}

export interface FuelStop {
  station: FuelStation;
  /** Driving distance to it along the route. */
  distanceM: number;
  /** Straight-line distance, which decides whether it is on the driver's map. */
  straightM: number;
  /** Within DRIVER_MAP_RADIUS_M: drawn on the driver's map. */
  onMap: boolean;
  price: PriceRange | null;
  /**
   * What diesel probably costs there: the middle of the brand's range. The
   * DOE gives ranges, not each pump's price, so this is an estimate.
   */
  expectedPhpPerL: number | null;
  /** The lowest expected price among the stops offered. */
  cheapest: boolean;
}

/** How far ahead stations are offered: about half the loop. */
export const FUEL_LOOKAHEAD_M = 10_000;
/**
 * A typical top-up: about a day's diesel for a jeepney on this route
 * (~200 km at ~0.15 L/km). The saving of a cheaper station is quoted on it.
 */
export const TOP_UP_LITRES = 30;

/**
 * Stations a jeepney can pull into within `withinM` ahead, nearest first:
 * the ones a driver can actually use without leaving the route, those on
 * their map and those further on.
 */
export function fuelAhead(
  route: Route,
  stations: readonly FuelStation[],
  at: Whereabouts,
  withinM = FUEL_LOOKAHEAD_M,
  max = 6,
): FuelStop[] {
  const stops = stations
    .filter((st) => canPullIn(st, at.direction))
    .map((station): FuelStop => {
      const price = dieselPrice(station.brand);
      const straightM = Math.hypot(station.at.x - at.x, station.at.z - at.z);
      return {
        station,
        distanceM: route.loop ? aheadOf(route, at.s, station.s) : (station.s - at.s) * at.direction,
        straightM,
        onMap: straightM <= DRIVER_MAP_RADIUS_M,
        price,
        expectedPhpPerL: price ? Math.round(((price.min + price.max) / 2) * 100) / 100 : null,
        cheapest: false,
      };
    })
    .filter((x) => x.distanceM > 0 && x.distanceM <= withinM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, max);
  const lowest = Math.min(...stops.map((x) => x.expectedPhpPerL ?? Infinity));
  for (const x of stops) x.cheapest = x.expectedPhpPerL === lowest;
  return stops;
}

export interface FuelAdvice {
  /** Fill up now: the first station ahead. */
  nearest: FuelStop | null;
  /** If the tank can wait: the cheapest ahead (null when that is the nearest). */
  cheaper: FuelStop | null;
  /** What waiting for `cheaper` saves on a TOP_UP_LITRES top-up, pesos. */
  savingPhp: number;
}

/**
 * The decision a driver actually has. Every station offered is on the way
 * (no detour, no U-turn), so the choice is "the next one" or "a cheaper one
 * further on", and how much the wait is worth. How full the tank is, only
 * the driver knows.
 */
export function fuelAdvice(stops: readonly FuelStop[]): FuelAdvice {
  const nearest = stops[0] ?? null;
  const best = stops.find((x) => x.cheapest) ?? null;
  if (!nearest || !best || best === nearest || nearest.expectedPhpPerL === null)
    return { nearest, cheaper: null, savingPhp: 0 };
  const savingPhp =
    Math.round((nearest.expectedPhpPerL - best.expectedPhpPerL!) * TOP_UP_LITRES * 100) / 100;
  return savingPhp > 0
    ? { nearest, cheaper: best, savingPhp }
    : { nearest, cheaper: null, savingPhp: 0 };
}
