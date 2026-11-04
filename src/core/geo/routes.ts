/**
 * Route sources. A route always ends up as a Polyline in local metres; what
 * differs is where it came from and therefore how much we may claim about it.
 *
 *   synthetic  generated for offline development. NOT a real road.
 *   osm        Road geometry from OpenStreetMap (see scripts/fetch-route.mjs).
 *   recorded   simplified GPS trace from a real ride.
 *
 * Only geographic routes (osm, recorded) carry a projection, and only those
 * can be map-matched against live GPS.
 */

import type { FleetKind } from '../vehicles/specs';
import { Polyline } from './polyline';
import {
  createProjection,
  haversineM,
  type LatLng,
  type LocalPoint,
  type Projection,
} from './projection';
import { simplify } from './simplify';
import { LANE_M, ROADS, ROUTE_ROAD_WIDTH_M, roadWidth } from '../map/style';
import { smoothTurns, tightSpots, type SmoothLine } from './smoothTurns';
import defaultRouteJson from '@/data/tungko-fairview.route.json';

export type RouteSource = 'synthetic' | 'osm' | 'recorded';

export interface Stop {
  name: string;
  /** Along-route distance, metres. */
  s: number;
  /** Everyone gets off here, the jeepney waits, and the next trip loads. */
  terminal?: boolean;
  /** On a loop: the terminal this stop's riders are heading to (for display). */
  towards?: string;
}

/**
 * Two shapes of route:
 *
 *   line  one path, driven out and back: jeepneys turn around at the first
 *         and last stop (the terminals).
 *   loop  out one way and back another (one-way roads, a turnaround loop at
 *         the end). The polyline closes on itself, jeepneys only ever drive
 *         forward and wrap around, and terminals can be anywhere on it.
 */
export interface Route {
  id: string;
  name: string;
  source: RouteSource;
  polyline: Polyline;
  loop: boolean;
  /** What runs it: jeepneys (with a few modern ones; the default), buses or UV Express vans. */
  kind?: FleetKind;
  stops: Stop[];
  /**
   * 'osm' = OpenStreetMap bus stops; 'gtfs' = the DOTC GTFS feed (network
   * routes); 'placeholder' = evenly spaced stand-ins, not real stop locations.
   */
  stopsSource: 'osm' | 'gtfs' | 'placeholder';
  /** Present only for geographic routes. */
  projection: Projection | null;
  /** Caveat about the geometry, shown in the UI (e.g. "routed, verify by riding"). */
  note?: string;
  /**
   * Distance from the route line to the kerb on the right, sampled along the
   * route (see kerbAt). Known when the route file records its roads
   * (scripts/route-roads.mjs); otherwise the fallback road width applies.
   */
  kerbs?: { s: number[]; m: number[]; room: number[]; lineUp?: number[] };
  /** This route's own share of each kind of vehicle (core/network/fleetSize.ts). */
  mix?: { modern: number; bus: number; uv: number };
}

/** Kerb distances are averaged over this much road, so lanes never jump. */
const KERB_SMOOTH_M = 25;

/** Metres from the route line to the right-hand kerb at along-route s. */
export function kerbAt(route: Route, s: number): number {
  return kerbFrom(route.kerbs, route.polyline.length, route.loop, s);
}

function kerbFrom(k: Route['kerbs'], L: number, loop: boolean, s: number): number {
  return !k || k.s.length === 0 ? ROUTE_ROAD_WIDTH_M / 2 : sampled(k.s, k.m, L, loop, s);
}

/** `values` (at along-route `at`) read at along-route s. */
function sampled(
  at: readonly number[],
  values: readonly number[],
  L: number,
  loop: boolean,
  s: number,
): number {
  const x = loop ? ((s % L) + L) % L : Math.max(0, Math.min(L, s));
  // Binary search for the sample at or before x, then interpolate.
  let lo = 0;
  let hi = at.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (at[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  const next = Math.min(lo + 1, at.length - 1);
  const span = at[next]! - at[lo]!;
  const t = span > 0 ? (x - at[lo]!) / span : 0;
  return values[lo]! + (values[next]! - values[lo]!) * t;
}

/**
 * How much of its offset from the line a vehicle keeps at s, 0–1: all of it,
 * but for where the line doubles back (see hairpins).
 */
export function lineUpAt(route: Route, s: number): number {
  const k = route.kerbs;
  if (!k?.lineUp) return 1;
  return sampled(k.s, k.lineUp, route.polyline.length, route.loop, s);
}

/** The lane a vehicle keeps to, in from the kerb (its centre, metres). */
export const KERB_LANE_M = 1.75;
/** Room to spread with no road data: from the kerb lane to the line, not over it. */
const UNKNOWN_ROAD_ROOM_M = ROUTE_ROAD_WIDTH_M / 2 - KERB_LANE_M;

/**
 * Metres of road beyond the kerb lane going this way at s, for vehicles to
 * spread into. A route that does not know its road (kerbs unknown) keeps to
 * its side of the line.
 */
export function laneRoomAt(route: Route, s: number): number {
  const k = route.kerbs;
  if (!k) return UNKNOWN_ROAD_ROOM_M;
  return sampled(k.s, k.room, route.polyline.length, route.loop, s);
}
/**
 * How far either side a corner is rounded, given how far out the road's kerb
 * is: no more than the road has room for. A vehicle turning a street corner
 * stays on the street; rounded any wider, it cuts across the block, through
 * whatever is built there. Its lane round the bend is the drive line's to keep.
 */
const turnReachM = (kerbM: number) => Math.max(MIN_TURN_REACH_M, kerbM * TURN_REACH_PER_KERB);
const MIN_TURN_REACH_M = 10;
const TURN_REACH_PER_KERB = 1.8;
/** A turn still tighter than this after rounding is rounded again, a little more (metres of radius). */
const TIGHT_TURN_M = 8;
const TIGHT_TURN_REACH = 2;
/** Road either side of a tight turn that the harder smoothing covers (metres). */
const TIGHT_TURN_SPAN_M = 45;

/** Around a loop's seam, kerbs ease to one value over this much road either side. */
const SEAM_EASE_M = 40;

/** A loop's kerbs, meeting where its end joins its start. */
function closeKerbs(k: NonNullable<Route['kerbs']>, L: number): NonNullable<Route['kerbs']> {
  const meet = (values: readonly number[]) => {
    const first = values[0]!;
    const last = values[values.length - 1]!;
    const seam = (first + last) / 2;
    return values.map((v, i) => {
      const s = k.s[i]!;
      const fromStart = Math.max(0, 1 - s / SEAM_EASE_M);
      const fromEnd = Math.max(0, 1 - (L - s) / SEAM_EASE_M);
      return v + (seam - first) * fromStart + (seam - last) * fromEnd;
    });
  };
  return { s: k.s, m: meet(k.m), room: meet(k.room) };
}

/** A route's line with its corners rounded, and its kerbs carried over to the new line. */
export function smoothRoute(
  line: Polyline,
  loop: boolean,
  kerbs: Route['kerbs'],
): SmoothLine & { kerbs: Route['kerbs'] } {
  const reach = (s: number) => turnReachM(kerbFrom(kerbs, line.length, loop, s));
  let smooth = smoothTurns(line, loop, reach);
  // What is left is the road really doubling back: give those stretches more room.
  const tight = tightSpots(smooth.polyline, TIGHT_TURN_M);
  if (tight.length > 0) {
    const scale = line.length / smooth.polyline.length;
    // In steps of the span: each tight spot marks its own step and those either side.
    const near = new Uint8Array(Math.ceil(line.length / TIGHT_TURN_SPAN_M) + 3);
    for (const s of tight) {
      const step = Math.floor((s * scale) / TIGHT_TURN_SPAN_M) + 1;
      near[step - 1] = near[step] = near[step + 1] = 1;
    }
    smooth = smoothTurns(line, loop, (s) =>
      near[Math.floor(s / TIGHT_TURN_SPAN_M) + 1] ? reach(s) * TIGHT_TURN_REACH : reach(s),
    );
  }
  const moved = kerbs && { ...kerbs, s: kerbs.s.map(smooth.toSmooth) };
  return {
    ...smooth,
    kerbs:
      moved &&
      hairpins(
        smooth.polyline,
        loop,
        gentleRoom(
          loop
            ? clearOfOncoming(smooth.polyline, closeKerbs(moved, smooth.polyline.length))
            : moved,
        ),
      ),
  };
}

/** Looking this far either way along the road for how much it turns (metres). */
const TURN_SPAN_M = 18;
/** Up to this turn (radians) a vehicle keeps its lane; by the second it is on the line. */
const KEEPS_LANE_RAD = 1.75;
const ON_THE_LINE_RAD = 2.6;

/**
 * Where the line doubles back (a terminal on a wide road), a vehicle set off
 * to one side of it would swing right across to the other in the few metres
 * the line takes to reverse: a sideways jump of twice the offset. So through
 * a hairpin vehicles close in on the line, and out again after it.
 */
function hairpins(
  line: Polyline,
  loop: boolean,
  kerbs: NonNullable<Route['kerbs']>,
): NonNullable<Route['kerbs']> {
  const L = line.length;
  const at = (s: number) => (loop ? ((s % L) + L) % L : Math.max(0, Math.min(L, s)));
  const lineUp = kerbs.s.map((s) => {
    const before = line.headingAt(at(s - TURN_SPAN_M), 6);
    const after = line.headingAt(at(s + TURN_SPAN_M), 6);
    const turn = Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before)));
    const t = Math.max(
      0,
      Math.min(1, (turn - KEEPS_LANE_RAD) / (ON_THE_LINE_RAD - KEEPS_LANE_RAD)),
    );
    return 1 - t * t * (3 - 2 * t);
  });
  return lineUp.every((u) => u === 1) ? kerbs : { ...kerbs, lineUp };
}

/** Room to spread narrows or widens no faster than this (metres across per metre along). */
const ROOM_CHANGE_PER_M = 0.08;

/**
 * A lane that ends must end gradually. Where the room dropped from one
 * stretch to the next, a vehicle in the lane was moved across at once: it
 * looked like a teleport. Only ever narrows the room, so it stays safe.
 */
function gentleRoom(kerbs: NonNullable<Route['kerbs']>): NonNullable<Route['kerbs']> {
  const room = [...kerbs.room];
  const reach = (i: number, from: number) =>
    room[from]! + Math.abs(kerbs.s[i]! - kerbs.s[from]!) * ROOM_CHANGE_PER_M;
  for (let i = 1; i < room.length; i++) room[i] = Math.min(room[i]!, reach(i, i - 1));
  for (let i = room.length - 2; i >= 0; i--) room[i] = Math.min(room[i]!, reach(i, i + 1));
  return { ...kerbs, room };
}

/** The road's line looked at every this many metres, for the oncoming side. */
const ONCOMING_STEP_M = 15;
/** The other way along a loop counts within this much of the line (metres)… */
const ONCOMING_WITHIN_M = 32;
/** …unless it is this close along the route: only a bend, not the way back. */
const ONCOMING_NOT_WITHIN_S_M = 120;
/** A lane's centre stays this far from the middle between the two ways (metres). */
const OFF_THE_MIDDLE_M = 1.9;

/**
 * A loop runs along many roads both ways, and a road's tagged width says
 * nothing of how far apart its two ways lie on the map. Spread by that width
 * alone, the inner lanes of the two ways meet head on. So each stretch's room
 * is cut to the middle between it and its own way back, measured on the line.
 */
function clearOfOncoming(
  line: Polyline,
  kerbs: NonNullable<Route['kerbs']>,
): NonNullable<Route['kerbs']> {
  const L = line.length;
  const count = Math.ceil(L / ONCOMING_STEP_M);
  const xs = new Float64Array(count);
  const zs = new Float64Array(count);
  const hs = new Float64Array(count);
  const cells = new Map<number, number[]>();
  const size = ONCOMING_WITHIN_M;
  const cellOf = (cx: number, cz: number) => cx * 100_003 + cz;
  for (let i = 0; i < count; i++) {
    const s = (i * L) / count;
    const p = line.pointAt(s);
    xs[i] = p.x;
    zs[i] = p.z;
    hs[i] = line.headingAt(s, ONCOMING_STEP_M);
    const key = cellOf(Math.round(p.x / size), Math.round(p.z / size));
    const here = cells.get(key);
    if (here) here.push(i);
    else cells.set(key, [i]);
  }
  // How far left of the line each stretch may go.
  const leftRoom = new Float64Array(count).fill(Infinity);
  const apart = Math.floor(ONCOMING_NOT_WITHIN_S_M / ONCOMING_STEP_M);
  for (let i = 0; i < count; i++) {
    const c = Math.cos(hs[i]!);
    const n = Math.sin(hs[i]!);
    const cx = Math.round(xs[i]! / size);
    const cz = Math.round(zs[i]! / size);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const j of cells.get(cellOf(cx + dx, cz + dz)) ?? []) {
          const along = Math.abs(i - j);
          if (Math.min(along, count - along) < apart) continue;
          if (Math.cos(hs[i]! - hs[j]!) > -0.7) continue; // the same way, or a crossing
          const x = xs[j]! - xs[i]!;
          const z = zs[j]! - zs[i]!;
          if (x * x + z * z > ONCOMING_WITHIN_M * ONCOMING_WITHIN_M) continue;
          // Right of the way of travel is (sin h, cos h): negative is to its left.
          const left = -(x * n + z * c);
          leftRoom[i] = Math.min(leftRoom[i]!, left / 2 - OFF_THE_MIDDLE_M);
        }
  }
  // A kerb sample holds for the road out to the samples either side of it.
  const room = kerbs.room.map((r, i) => {
    const from = Math.floor((kerbs.s[Math.max(0, i - 1)]! / L) * count);
    const to = Math.ceil((kerbs.s[Math.min(kerbs.s.length - 1, i + 1)]! / L) * count);
    let left = Infinity;
    for (let n = from; n <= to && n < count; n++) left = Math.min(left, leftRoom[n]!);
    if (left === Infinity) return r;
    const cruise = Math.max(0, kerbs.m[i]! - KERB_LANE_M);
    return Math.max(0, Math.min(r, cruise + left));
  });
  return { ...kerbs, room };
}

/**
 * Kerb distance at each polyline vertex from the file's road stretches
 * ([fromIndex, class, oneway]): half the width the map draws that road at,
 * averaged along the road so a change of road eases in.
 */
function kerbProfile(polyline: Polyline, roads: ReadonlyArray<[number, string, number]>) {
  const pts = polyline.points;
  const s = [...polyline.cumulative];
  // Half the road's width; and how much of it is lanes going this way past
  // the kerb lane: a one-way carriageway's whole width, a two-way road's half.
  const kerb: number[] = [];
  const room: number[] = [];
  pts.forEach((_, i) => {
    let r = roads[0]!;
    for (const stretch of roads) if (stretch[0] <= i) r = stretch;
    const style = ROADS[r[1]] ?? ROADS.minor!;
    const oneway = r[2] === 1;
    const width = roadWidth(style, oneway);
    kerb.push(width / 2);
    room.push(Math.max(0, (oneway ? width : width / 2) - LANE_M));
  });
  const eased = (raw: readonly number[]) =>
    raw.map((_, i) => {
      let sum = 0;
      let n = 0;
      for (let j = i; j >= 0 && s[i]! - s[j]! <= KERB_SMOOTH_M; j--, n++) sum += raw[j]!;
      for (let j = i + 1; j < pts.length && s[j]! - s[i]! <= KERB_SMOOTH_M; j++, n++)
        sum += raw[j]!;
      return sum / n;
    });
  return { s, m: eased(kerb), room: eased(room) };
}

/**
 * Kerbs from road stretches given by metres along the line ([fromS, class,
 * oneway]), as the network's corridor routes record them: the line's points
 * can change when spurs are cut, its metres along do not.
 */
export function kerbsAlong(polyline: Polyline, roads: ReadonlyArray<[number, string, number]>) {
  const s = polyline.cumulative;
  return kerbProfile(
    polyline,
    roads.map(([from, cls, oneway]): [number, string, number] => {
      let i = 0;
      while (i < s.length - 1 && s[i]! < from) i++;
      return [i, cls, oneway];
    }),
  );
}

/** A bus stop that is further than this from the line is on another road. */
const STOP_MAX_OFFSET_M = 40;
/** Stops closer than this are the same stop (often one per side of the road). */
const STOP_MERGE_M = 120;

/** Evenly spaced stops; good enough until real stop data is loaded. */
function evenStops(polyline: Polyline, spacingM: number): Stop[] {
  const count = Math.max(2, Math.round(polyline.length / spacingM) + 1);
  return Array.from({ length: count }, (_, i) => ({
    name: `Stop ${i + 1}`,
    s: (polyline.length * i) / (count - 1),
    terminal: i === 0 || i === count - 1,
  }));
}

/** Whether stop i is a terminal (everyone off, the next trip loads). */
export function isTerminal(route: Route, i: number): boolean {
  return route.stops[i]?.terminal === true;
}

/**
 * Stops a rider boarding at `from`, travelling in `direction`, can get off
 * at: every stop after it up to and including the next terminal. On a loop
 * the direction is always +1 and the list wraps past the end of the line.
 */
export function stopsAhead(route: Route, from: number, direction: 1 | -1): number[] {
  const n = route.stops.length;
  const out: number[] = [];
  if (!route.loop) {
    for (let i = from + direction; i >= 0 && i < n; i += direction) out.push(i);
    return out;
  }
  for (let k = 1; k < n; k++) {
    const i = (from + k) % n;
    out.push(i);
    if (isTerminal(route, i)) break;
  }
  return out;
}

/** Forward distance along the route from s0 to s1 (wrapping on a loop). */
export function aheadOf(route: Route, s0: number, s1: number): number {
  const d = s1 - s0;
  if (!route.loop) return d;
  const L = route.polyline.length;
  return ((d % L) + L) % L;
}

/**
 * A ~3 km winding road for developing without data or network.
 * Deterministic, so screenshots and tests are stable.
 */
export function syntheticDemoRoute(): Route {
  const points: LocalPoint[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    points.push({
      x: -1400 + 2800 * t,
      z: 260 * Math.sin(t * Math.PI * 2.2) + 90 * Math.sin(t * Math.PI * 7),
    });
  }
  const polyline = new Polyline(points);
  return {
    id: 'demo',
    name: 'Synthetic demo route (not a real road)',
    source: 'synthetic',
    polyline,
    loop: false,
    stops: evenStops(polyline, 400),
    stopsSource: 'placeholder',
    projection: null,
  };
}

/** Build a geographic route. The first coordinate becomes the scene origin. */
export function geographicRoute(
  id: string,
  name: string,
  source: Exclude<RouteSource, 'synthetic'>,
  coords: readonly LatLng[],
  simplifyToleranceM = 0,
): Route {
  if (coords.length < 2) throw new Error(`Route "${name}" needs at least 2 coordinates`);
  const projection = createProjection(coords[0]!);
  const local = coords.map((c) => projection.toLocal(c));
  const points = simplifyToleranceM > 0 ? simplify(local, simplifyToleranceM) : local;
  const polyline = new Polyline(points);
  return {
    id,
    name,
    source,
    polyline,
    loop: false,
    stops: evenStops(polyline, 400),
    stopsSource: 'placeholder',
    projection,
  };
}

/**
 * Snap named stop locations onto a line route and order them by distance.
 * Stops off the road are dropped; stops on both sides of the road merge into
 * one. The two ends are always stops, named after the terminals.
 */
export function stopsAlong(
  polyline: Polyline,
  projection: Projection,
  points: ReadonlyArray<{ name: string | null; at: LatLng }>,
  terminals: { from?: string | null; to?: string | null } = {},
): Stop[] {
  const snapped = points
    .map((p) => ({ name: p.name, hit: polyline.project(projection.toLocal(p.at)) }))
    .filter((p) => p.hit.offset <= STOP_MAX_OFFSET_M)
    .sort((a, b) => a.hit.s - b.hit.s);

  const stops: Stop[] = [{ name: terminals.from ?? 'Start', s: 0, terminal: true }];
  for (const { name, hit } of snapped) {
    if (hit.s - stops[stops.length - 1]!.s < STOP_MERGE_M) continue;
    if (polyline.length - hit.s < STOP_MERGE_M) continue;
    stops.push({ name: name ?? `Stop ${stops.length + 1}`, s: hit.s });
  }
  stops.push({ name: terminals.to ?? 'End', s: polyline.length, terminal: true });
  return stops;
}

/**
 * Stops for a loop route. The first terminal is the start of the loop (s = 0);
 * the others are snapped onto it. Bus stops snap to the nearest part of the
 * loop, which is the carriageway on their own side of the road, so the two
 * stops of a pair (one per direction) both survive. Stops close to a terminal
 * are part of it. Each stop records the terminal it is heading towards.
 */
export function loopStops(
  polyline: Polyline,
  projection: Projection,
  points: ReadonlyArray<{ name: string | null; at: LatLng }>,
  terminals: ReadonlyArray<{ name: string; at: LatLng }>,
): Stop[] {
  const L = polyline.length;
  const ahead = (s0: number, s1: number) => (((s1 - s0) % L) + L) % L;
  const near = (a: number, b: number) => Math.min(ahead(a, b), ahead(b, a)) < STOP_MERGE_M;

  const fixed: Stop[] = terminals.map((t, i) => ({
    name: t.name,
    s: i === 0 ? 0 : polyline.project(projection.toLocal(t.at)).s,
    terminal: true,
  }));
  const snapped = points
    .map((p) => ({ name: p.name, hit: polyline.project(projection.toLocal(p.at)) }))
    .filter((p) => p.hit.offset <= STOP_MAX_OFFSET_M)
    .sort((a, b) => a.hit.s - b.hit.s);

  const stops = [...fixed];
  for (const { name, hit } of snapped) {
    if (stops.some((st) => near(st.s, hit.s))) continue;
    stops.push({ name: name ?? `Stop ${stops.length + 1}`, s: hit.s });
  }
  stops.sort((a, b) => a.s - b.s);
  // Label each stop with the next terminal ahead, for "Lagro → SM" vs "Lagro → Tungko".
  stops.forEach((st, i) => {
    for (let k = 1; k <= stops.length; k++) {
      const next = stops[(i + k) % stops.length]!;
      if (next.terminal) {
        st.towards = next.name;
        break;
      }
    }
  });
  return stops;
}

interface GeoJsonFeature {
  properties?: {
    name?: string | null;
    from?: string | null;
    to?: string | null;
    geometry?: string;
    loop?: boolean;
    kind?: string;
    roads?: Array<[number, string, number]>;
  };
  geometry?: { type: string; coordinates: unknown };
}

/** Parse the first LineString / MultiLineString feature of a GeoJSON document. */
export function parseGeoJsonRoute(geojson: unknown, fallbackName: string): Route {
  const features = (geojson as { features?: GeoJsonFeature[] }).features ?? [];
  const feature = features.find(
    (f) => f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString',
  );
  if (!feature?.geometry) throw new Error('GeoJSON has no LineString feature');

  const raw =
    feature.geometry.type === 'LineString'
      ? (feature.geometry.coordinates as number[][])
      : (feature.geometry.coordinates as number[][][]).flat();

  // GeoJSON order is [lng, lat], not [lat, lng].
  const toLatLng = ([lng, lat]: number[]): LatLng => ({ lat: lat!, lng: lng! });
  const props = feature.properties ?? {};
  const coords = raw.map(toLatLng);
  const loop = props.loop === true;
  // A loop must close exactly, so driving off its end continues at its start.
  if (loop && haversineM(coords[0]!, coords[coords.length - 1]!) > 0.5) coords.push(coords[0]!);
  const route = geographicRoute('osm', props.name ?? fallbackName, 'osm', coords);
  route.loop = loop;
  route.note = props.geometry;
  // One road stretch per file point; a closing point added above repeats the first.
  if (Array.isArray(props.roads) && props.roads.length > 0)
    route.kerbs = kerbProfile(route.polyline, props.roads);
  // Corners into curves, before anything is placed along the line.
  const smooth = smoothRoute(route.polyline, loop, route.kerbs);
  route.polyline = smooth.polyline;
  if (smooth.kerbs) route.kerbs = smooth.kerbs;

  const points = (kind: string) =>
    features
      .filter((f) => f.geometry?.type === 'Point' && (f.properties?.kind ?? 'stop') === kind)
      .map((f) => ({
        name: f.properties?.name ?? null,
        at: toLatLng(f.geometry!.coordinates as number[]),
      }));
  const stopPoints = points('stop');
  const terminalPoints = points('terminal').map((t) => ({ name: t.name ?? 'Terminal', at: t.at }));

  if (loop) {
    if (terminalPoints.length === 0) throw new Error('A loop route needs at least one terminal');
    route.stops = loopStops(route.polyline, route.projection!, stopPoints, terminalPoints);
    route.stopsSource = 'osm';
  } else if (stopPoints.length > 0) {
    route.stops = stopsAlong(route.polyline, route.projection!, stopPoints, props);
    route.stopsSource = 'osm';
  }
  return route;
}

/**
 * The route the dashboard opens with: Tungko – SM City Fairview along
 * Quirino Highway, through Malaria, with its OpenStreetMap bus stops. A
 * loop: jeepneys turn round only at the two terminals, around the block at
 * the Tungko jeepney station and through the SM terminal, never on the road.
 * Bundled with the app (generated by scripts/fetch-route.mjs), so it needs
 * no network.
 */
export const DEFAULT_ROUTE_ID = 'tungko-fairview';

export function defaultRoute(): Route {
  return {
    ...parseGeoJsonRoute(defaultRouteJson, 'Tungko – SM City Fairview'),
    id: DEFAULT_ROUTE_ID,
  };
}

/** Export a geographic route back to GeoJSON, e.g. to keep a recorded trace. */
export function routeToGeoJson(route: Route): object {
  const { projection } = route;
  if (!projection) throw new Error('Only geographic routes can be exported');
  const lngLat = (p: LocalPoint) => {
    const g = projection.toGeo(p);
    return [g.lng, g.lat];
  };
  // Stops go out as points (terminals marked), so a reload rebuilds the same route.
  const stops = route.stops.map((st) => ({
    type: 'Feature',
    properties: { name: st.name, kind: st.terminal ? 'terminal' : 'stop' },
    geometry: { type: 'Point', coordinates: lngLat(route.polyline.pointAt(st.s)) },
  }));
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: route.name, source: route.source, loop: route.loop },
        geometry: { type: 'LineString', coordinates: route.polyline.points.map(lngLat) },
      },
      ...(route.stopsSource === 'osm' ? stops : []),
    ],
  };
}
