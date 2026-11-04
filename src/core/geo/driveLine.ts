/**
 * The line a route's vehicles drive. A vehicle's place used to be worked out
 * each time as the road's line plus a shift to its lane, and that is not a
 * path: on a bend the shift folds back on itself, on a tight corner it jumps,
 * and where the road changes width the vehicle slides sideways. This is the
 * path itself, made once for each route and kept: the lane, with its loops cut
 * out, its corners rounded and its metres evened out, so that a vehicle going
 * along it is always going the way it is pointing. The map's route band is
 * this same line (scene/world/lanes.ts laneLine): what is drawn is what is driven.
 *
 * Going `s` metres along the route is a place on this line; other lanes are a
 * few metres to the side of it.
 */

import type { GroundPose } from '@/scene/jeepney/JeepneyInstances';
import { KERB_LANE_M, kerbAt, lineUpAt, type Route } from './routes';

/** A point of the line this often (metres). */
const STEP_M = 2.5;
/** Where the road doubles back, vehicles swing out at least this far either side to turn (metres). */
const U_TURN_OUT_M = 4.5;
/** The road's way at a place, from this far either side of it (metres): it may turn right round there. */
const WAY_SPAN_M = 4;
/** A loop in the lane is looked for this many points ahead… */
const LOOP_WINDOW = 48;
/** …where the road turns this much over that many points either side (radians). */
const LOOP_TURN = 0.5;
const LOOP_SPAN = 12;
/** Corners turning more than this in one step are eased (radians, about a 7 m radius). */
const SHARPEST = 0.35;
/** Each is eased with the points this far either side of it. */
const EASE_REACH = 4;
const EASE_SHARE = 0.5;
const EASE_PASSES = 40;
/**
 * Metres of road are matched to metres of lane over this many points either
 * side: the lane round a bend is longer or shorter than the road, and without
 * this a vehicle would race or stall going round it.
 */
const EVEN_REACH = 20;

export interface DriveLine {
  x: Float32Array;
  z: Float32Array;
  /** Metres of route between two points of the line. */
  step: number;
  loop: boolean;
}

/** Where stretches a–b and c–d of the points meet, as (x, z), if they do. */
function crossing(
  x: ArrayLike<number>,
  z: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
  d: number,
): [number, number] | null {
  const ex = x[b]! - x[a]!;
  const ez = z[b]! - z[a]!;
  const fx = x[d]! - x[c]!;
  const fz = z[d]! - z[c]!;
  const cross = ex * fz - ez * fx;
  if (cross === 0) return null;
  const t = ((x[c]! - x[a]!) * fz - (z[c]! - z[a]!) * fx) / cross;
  const u = ((x[c]! - x[a]!) * ez - (z[c]! - z[a]!) * ex) / cross;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [x[a]! + ex * t, z[a]! + ez * t] : null;
}

/** Where the lane runs into itself on the inside of a bend, all of it between is one point. */
function cutLoops(x: Float64Array, z: Float64Array, heading: Float64Array, loop: boolean): void {
  const n = x.length;
  const at = (i: number) => (loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
  for (let i = 0; i < n; i++) {
    const d = heading[at(i + LOOP_SPAN)]! - heading[at(i - LOOP_SPAN)]!;
    if (Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) < LOOP_TURN) continue;
    for (let j = LOOP_WINDOW; j >= 2; j--) {
      if (!loop && i + j + 1 >= n) continue;
      const hit = crossing(x, z, i, at(i + 1), at(i + j), at(i + j + 1));
      if (!hit) continue;
      for (let k = 1; k <= j; k++) {
        x[at(i + k)] = hit[0];
        z[at(i + k)] = hit[1];
      }
      i += j;
      break;
    }
  }
}

/** The points' metres from the first, one more than there are points on a loop. */
function metresAlong(x: ArrayLike<number>, z: ArrayLike<number>, loop: boolean): Float64Array {
  const n = x.length;
  const out = new Float64Array(loop ? n + 1 : n);
  for (let i = 1; i < out.length; i++) {
    const a = i - 1;
    const b = i % n;
    out[i] = out[a]! + Math.hypot(x[b]! - x[a]!, z[b]! - z[a]!);
  }
  return out;
}

/** The place `m` metres along points whose metres are `along`, from the point `from` on. */
function placeAt(
  x: ArrayLike<number>,
  z: ArrayLike<number>,
  along: ArrayLike<number>,
  m: number,
  from: number,
): [number, number, number] {
  const n = x.length;
  let i = from;
  while (i + 2 < along.length && along[i + 1]! < m) i++;
  const span = along[i + 1]! - along[i]!;
  const t = span > 0 ? Math.max(0, Math.min(1, (m - along[i]!) / span)) : 0;
  const a = i % n;
  const b = (i + 1) % n;
  return [x[a]! + (x[b]! - x[a]!) * t, z[a]! + (z[b]! - z[a]!) * t, i];
}

/** Even points along the lane, with its sharp corners eased. */
function eased(x: Float64Array, z: Float64Array, loop: boolean) {
  const along = metresAlong(x, z, loop);
  const total = along[along.length - 1]!;
  const count = Math.max(4, Math.round(total / STEP_M));
  const ex = new Float64Array(count);
  const ez = new Float64Array(count);
  let from = 0;
  for (let i = 0; i < count; i++) {
    const [px, pz, at] = placeAt(x, z, along, (total * i) / (loop ? count : count - 1), from);
    ex[i] = px;
    ez[i] = pz;
    from = at;
  }
  const at = (i: number) => (i + count) % count;
  const hot = new Uint8Array(count);
  for (let pass = 0; pass < EASE_PASSES; pass++) {
    hot.fill(0);
    let any = false;
    for (let i = loop ? 0 : 1; i < (loop ? count : count - 1); i++) {
      const a = at(i - 1);
      const b = at(i + 1);
      const inX = ex[i]! - ex[a]!;
      const inZ = ez[i]! - ez[a]!;
      const outX = ex[b]! - ex[i]!;
      const outZ = ez[b]! - ez[i]!;
      const turn = Math.abs(Math.atan2(inX * outZ - inZ * outX, inX * outX + inZ * outZ));
      if (turn <= SHARPEST) continue;
      any = true;
      for (let k = -EASE_REACH; k <= EASE_REACH; k++) {
        const j = i + k;
        if (loop || (j > 0 && j < count - 1)) hot[at(j)] = 1;
      }
    }
    if (!any) break;
    const nx = ex.slice();
    const nz = ez.slice();
    for (let i = 0; i < count; i++) {
      if (!hot[i]) continue;
      const a = at(i - 1);
      const b = at(i + 1);
      nx[i] = ex[i]! + EASE_SHARE * ((ex[a]! + ex[b]!) / 2 - ex[i]!);
      nz[i] = ez[i]! + EASE_SHARE * ((ez[a]! + ez[b]!) / 2 - ez[i]!);
    }
    ex.set(nx);
    ez.set(nz);
  }
  return { x: ex, z: ez };
}

function build(route: Route): DriveLine {
  const { polyline, loop } = route;
  const L = polyline.length;
  const n = Math.max(4, Math.round(L / STEP_M));
  const count = loop ? n : n + 1;
  const step = L / n;
  const x = new Float64Array(count);
  const z = new Float64Array(count);
  const heading = new Float64Array(count);
  const wrap = (s: number) => (loop ? ((s % L) + L) % L : Math.max(0, Math.min(L, s)));
  let way = polyline.headingAt(0, WAY_SPAN_M);
  for (let i = 0; i < count; i++) {
    const s = i * step;
    const p = polyline.pointAt(s);
    const a = polyline.pointAt(wrap(s - WAY_SPAN_M));
    const b = polyline.pointAt(wrap(s + WAY_SPAN_M));
    // Round the very tip of a road doubling back there is no way: the last one holds.
    if (Math.hypot(b.x - a.x, b.z - a.z) > 0.5) way = Math.atan2(-(b.z - a.z), b.x - a.x);
    // A line both ways along one road has no one lane: the line is its middle.
    const lane = loop ? Math.max(0, kerbAt(route, s) - KERB_LANE_M) : 0;
    const out = loop ? Math.max(lane, U_TURN_OUT_M * (1 - lineUpAt(route, s))) : 0;
    x[i] = p.x + Math.sin(way) * out;
    z[i] = p.z + Math.cos(way) * out;
    heading[i] = way;
  }
  cutLoops(x, z, heading, loop);
  const lane = eased(x, z, loop);
  // How far along the lane each metre of road is, evened out. The eased lane's
  // points stand for even metres of the lane as it was, so nothing is rescaled:
  // however far along the route, s stays the same place on the road.
  const raw = metresAlong(x, z, loop);
  const total = raw[raw.length - 1]!;
  const points = lane.x.length;
  const rawAt = (i: number) =>
    loop
      ? raw[((i % n) + n) % n]! + Math.floor(i / n) * total
      : raw[Math.max(0, Math.min(count - 1, i))]!;
  const outX = new Float32Array(count);
  const outZ = new Float32Array(count);
  let sum = 0;
  for (let k = -EVEN_REACH; k <= EVEN_REACH; k++) sum += rawAt(k);
  for (let i = 0; i < count; i++) {
    const metres = sum / (2 * EVEN_REACH + 1);
    const u = loop
      ? ((((metres / total) * points) % points) + points) % points
      : Math.max(0, Math.min(points - 1, (metres / total) * (points - 1)));
    const a = Math.min(Math.floor(u), loop ? points - 1 : points - 2);
    const b = loop ? (a + 1) % points : a + 1;
    const t = u - a;
    outX[i] = lane.x[a]! + (lane.x[b]! - lane.x[a]!) * t;
    outZ[i] = lane.z[a]! + (lane.z[b]! - lane.z[a]!) * t;
    sum += rawAt(i + EVEN_REACH + 1) - rawAt(i - EVEN_REACH);
  }
  return { x: outX, z: outZ, step, loop };
}

/** How hard a vehicle takes a bend (m/s² across): gentle, with people standing. */
const BEND_MPS2 = 1.4;
/** A bend is read over this many points either side. */
const BEND_SPAN = 2;
/** It is slowed for this hard beforehand (m/s²). */
const BEND_BRAKE_MPS2 = 1;
/** Going no slower than this round the tightest turn (m/s). */
const SLOWEST_MPS = 1.5;

/** How fast to go at each point of `line`, for the bend there and those just ahead. */
function bendSpeeds({ x, z, step, loop }: DriveLine): Float32Array {
  const n = x.length;
  const at = (i: number) => (loop ? (i + n) % n : Math.max(0, Math.min(n - 1, i)));
  const mps = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = at(i - BEND_SPAN);
    const b = at(i + BEND_SPAN);
    const inX = x[i]! - x[a]!;
    const inZ = z[i]! - z[a]!;
    const outX = x[b]! - x[i]!;
    const outZ = z[b]! - z[i]!;
    const turn = Math.abs(Math.atan2(inX * outZ - inZ * outX, inX * outX + inZ * outZ));
    const radius = turn > 1e-4 ? (BEND_SPAN * step) / turn : Infinity;
    mps[i] = Math.max(SLOWEST_MPS, Math.sqrt(BEND_MPS2 * radius));
  }
  // Twice round: a loop's seam.
  for (let pass = 0; pass < 2; pass++)
    for (let i = n - 1; i >= 0; i--) {
      if (!loop && i === n - 1) continue;
      const next = mps[(i + 1) % n]!;
      mps[i] = Math.min(mps[i]!, Math.sqrt(next * next + 2 * BEND_BRAKE_MPS2 * step));
    }
  return mps;
}

const lines = new WeakMap<Route, DriveLine>();
const bends = new WeakMap<Route, Float32Array>();

/** How fast a vehicle goes `s` metres along `route`, for the bends there and ahead (m/s). */
export function bendSpeed(route: Route, s: number): number {
  const line = driveLine(route);
  let mps = bends.get(route);
  if (!mps) bends.set(route, (mps = bendSpeeds(line)));
  const n = mps.length;
  const i = Math.floor(s / line.step);
  return mps[line.loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))]!;
}

/** Route `route`'s line, made the first time it is asked for. */
export function driveLine(route: Route): DriveLine {
  let line = lines.get(route);
  if (!line) lines.set(route, (line = build(route)));
  return line;
}

/**
 * Where a vehicle `s` metres along `route` is, going `direction`, `right`
 * metres right of the line as it faces, pointing along it.
 */
export function drivePose(
  route: Route,
  s: number,
  direction: 1 | -1,
  right: number,
  out: GroundPose,
): GroundPose {
  const { x, z, step, loop } = driveLine(route);
  const n = x.length;
  const u = loop ? (((s / step) % n) + n) % n : Math.max(0, Math.min(n - 1, s / step));
  const i = Math.min(Math.floor(u), loop ? n - 1 : n - 2);
  const t = u - i;
  const at = (k: number) => (loop ? (k + n) % n : Math.max(0, Math.min(n - 1, k)));
  const p0 = at(i - 1);
  const p1 = i;
  const p2 = at(i + 1);
  const p3 = at(i + 2);
  // A curve through the points, not straight from one to the next: no corner at any of them.
  const curve = (v: Float32Array) => {
    const a = 2 * v[p0]! - 5 * v[p1]! + 4 * v[p2]! - v[p3]!;
    const b = -v[p0]! + 3 * v[p1]! - 3 * v[p2]! + v[p3]!;
    const c = v[p2]! - v[p0]!;
    return [v[p1]! + 0.5 * t * (c + t * (a + t * b)), c + t * (2 * a + 3 * t * b)] as const;
  };
  const [px, tx] = curve(x);
  const [pz, tz] = curve(z);
  const forward = Math.atan2(-tz, tx);
  const heading = direction === 1 ? forward : forward + Math.PI;
  // Right of the direction of travel, in the X–Z plane: (sin θ, cos θ).
  out.x = px + Math.sin(heading) * right;
  out.z = pz + Math.cos(heading) * right;
  out.heading = heading;
  return out;
}
