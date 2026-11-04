/**
 * Pedestrian crossings: the white stripes over the road at each stop, kerb to
 * kerb over both sides of it, where people walking to or from the stop cross.
 * A way that goes over the road near one is taken to it and over it instead,
 * so nobody crosses mid-block, and everyone can see which side they come out on.
 * Far from any, it goes straight over, kerb to kerb, never slanting through
 * the traffic.
 */

import type { LocalPoint } from '../geo/projection';
import type { Route } from '../geo/routes';
import type { RoadIndex } from './crossing';

/** A stop's crossing is this far before it, where vehicles have not pulled in yet (metres). */
const BEFORE_STOP_M = 14;
/** The road is looked for this far out to either side (metres). */
const LOOK_M = 60;
const STEP_M = 0.5;
/** A gap narrower than this between two sides of the road is its median: crossed too. */
const MEDIAN_M = 25;
/** Two stops' crossings closer than this are one (a stop each way across the road). */
const SAME_ZEBRA_M = 40;
/** A way that goes over the road this close to a crossing takes it (metres). */
const USE_WITHIN_M = 150;
/** A way is looked at this often along it for the road (metres). */
const LOOK_EVERY_M = 2;
/** Stripes: this wide, this far apart, this long along the road (metres). */
export const STRIPE_M = 0.55;
export const STRIPE_EVERY_M = 1.1;
export const STRIPE_LENGTH_M = 3.2;

export interface Zebra {
  /** Its two ends, at the kerbs: `right` on the right of the route's way along it. */
  right: LocalPoint;
  left: LocalPoint;
  /** Along the road, for the stripes. */
  heading: number;
}

type Point3 = readonly [number, number, number];

const add = (p: LocalPoint, n: LocalPoint, d: number) => ({ x: p.x + n.x * d, z: p.z + n.z * d });

/** The crossings of `route`, one at each stop (or pair of stops facing each other). */
export function zebrasOf(route: Route, road: RoadIndex): Zebra[] {
  const L = route.polyline.length;
  const out: Zebra[] = [];
  for (const stop of route.stops) {
    const raw = stop.s - BEFORE_STOP_M;
    const s = route.loop ? ((raw % L) + L) % L : Math.max(0, raw);
    const heading = route.polyline.headingAt(s, 8);
    const across = kerbToKerb(route, road, s);
    if (!across) continue;
    const zebra = { ...across, heading };
    const middle = (z: Zebra) => ({ x: (z.right.x + z.left.x) / 2, z: (z.right.z + z.left.z) / 2 });
    const m = middle(zebra);
    if (out.some((o) => Math.hypot(middle(o).x - m.x, middle(o).z - m.z) < SAME_ZEBRA_M)) continue;
    out.push(zebra);
  }
  return out;
}

/** Straight over the road at `s`, kerb to kerb (over any median); null where `s` is not on it. */
function kerbToKerb(
  route: Route,
  road: RoadIndex,
  s: number,
): { right: LocalPoint; left: LocalPoint } | null {
  const p = route.polyline.pointAt(s);
  const heading = route.polyline.headingAt(s, 8);
  const n = { x: Math.sin(heading), z: Math.cos(heading) };
  const onRoad = (d: number) => road.at(add(p, n, d)).length > 0;
  if (!onRoad(0)) return null;
  // Out to each kerb, over any median.
  const edge = (sign: 1 | -1) => {
    let last = 0;
    for (let d = STEP_M; d <= LOOK_M; d += STEP_M) {
      if (onRoad(sign * d)) last = d;
      else if (d - last > MEDIAN_M) break;
    }
    return sign * last;
  };
  return { right: add(p, n, edge(1)), left: add(p, n, edge(-1)) };
}

/**
 * `path` looked at every LOOK_EVERY_M (so a step over the road is seen): each
 * point, and the corner of `path` it comes after. Only to find where the way
 * meets the road: the way drawn keeps its own corners.
 */
function densely(path: readonly Point3[]): { points: Point3[]; corner: number[] } {
  const points: Point3[] = [path[0]!];
  const corner = [0];
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1]!, path[i]!];
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / LOOK_EVERY_M);
    for (let k = 1; k < steps; k++) {
      points.push([a[0] + ((b[0] - a[0]) * k) / steps, 0, a[2] + ((b[2] - a[2]) * k) / steps]);
      corner.push(i - 1);
    }
    points.push(b);
    corner.push(i);
  }
  return { points, corner };
}

/** The stripes of `zebra`: each a quad of four corners, on the road only. */
export function stripesOf(zebra: Zebra, road: RoadIndex): LocalPoint[][] {
  const { right, left, heading } = zebra;
  const width = Math.hypot(left.x - right.x, left.z - right.z);
  if (width === 0) return [];
  const across = { x: (left.x - right.x) / width, z: (left.z - right.z) / width };
  const along = { x: Math.cos(heading), z: -Math.sin(heading) };
  const quads: LocalPoint[][] = [];
  for (let d = STRIPE_EVERY_M / 2; d + STRIPE_M <= width; d += STRIPE_EVERY_M) {
    const a = add(right, across, d);
    if (road.at(add(a, across, STRIPE_M / 2)).length === 0) continue; // the median
    const b = add(a, across, STRIPE_M);
    const back = -STRIPE_LENGTH_M / 2;
    const front = STRIPE_LENGTH_M / 2;
    quads.push([
      add(a, along, back),
      add(b, along, back),
      add(b, along, front),
      add(a, along, front),
    ]);
  }
  return quads;
}

/**
 * `path`, crossing the road at the nearest crossing instead of where it does:
 * along the kerb to it, over it, and on from the far side. With no crossing
 * near, straight over where it meets the road, kerb to kerb. As it was if it
 * does not cross the road (or starts or ends on it).
 */
export function viaZebra(
  given: readonly Point3[],
  road: RoadIndex,
  zebras: readonly Zebra[],
): Point3[] {
  if (given.length < 2) return [...given];
  const { points: path, corner } = densely(given);
  const on = path.map(([x, , z]) => road.at({ x, z }).length > 0);
  const first = on.indexOf(true);
  if (first <= 0) return [...given];
  const last = on.lastIndexOf(true);
  if (last >= path.length - 1) return [...given];
  const before = path[first - 1]!;
  const after = path[last + 1]!;
  const mid = { x: (before[0] + after[0]) / 2, z: (before[2] + after[2]) / 2 };
  let best: Zebra | null = null;
  let bestD = USE_WITHIN_M;
  for (const z of zebras) {
    const d = Math.hypot((z.right.x + z.left.x) / 2 - mid.x, (z.right.z + z.left.z) / 2 - mid.z);
    if (d < bestD) [best, bestD] = [z, d];
  }
  // None near: straight over where the way meets the road.
  const hit = road.at({ x: path[first]![0], z: path[first]![2] })[0];
  const over = best ?? (hit ? kerbToKerb(road.route, road, hit.s) : null);
  if (!over) return [...given];
  // Which end they come to: the one on their side of the road.
  const near = (p: Point3, e: LocalPoint) => Math.hypot(p[0] - e.x, p[2] - e.z);
  const fromRight =
    near(before, over.right) + near(after, over.left) <=
    near(before, over.left) + near(after, over.right);
  const [start, end] = fromRight ? [over.right, over.left] : [over.left, over.right];
  return [
    ...given.slice(0, corner[first - 1]! + 1),
    before,
    [start.x, 0, start.z],
    [end.x, 0, end.z],
    after,
    ...given.slice(corner[last + 1]! + 1),
  ].filter(
    (q, k, all): q is Point3 => k === 0 || q[0] !== all[k - 1]![0] || q[2] !== all[k - 1]![2],
  );
}
