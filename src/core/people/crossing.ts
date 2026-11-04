/**
 * Someone crossing the road. Whoever's way goes over the route's road comes to
 * the kerb and waits there; every vehicle that can still stop stops, on both
 * sides, and one too close to stop goes first. They step out once nothing is
 * on the line or too close to stop. A vehicle waits while they are in its
 * lane or coming to it, and goes on once they are past it and walking away:
 * the other side waits for them still. With a vehicle standing on their line (at a stop, in a queue) they
 * walk along the kerb to the nearest gap and cross there, as anyone would.
 * A way's crossings are found one at a time, from where they are on it: a
 * long walk is not looked over to its end again each time it changes.
 */

import type { LocalPoint } from '../geo/projection';
import { kerbAt, type Route } from '../geo/routes';
import { newRiderPose, type RiderMotion } from './riderMotion';

/** Along a way, a look this often (seconds of it). */
const SAMPLE_S = 0.4;
/** Over a road: no more of the way on it than this many times its width. */
const MOST_ON_ROAD = 2.5;
/** Passes of a route further apart along it than this (metres) are two. */
const SAME_PASS_M = 30;
const CELL_M = 40;

/** One time the route passes a crossing: from `s`, this far along it (a slanted way covers some). */
export interface CrossingPass {
  s: number;
  alongM: number;
}

export interface Crossing {
  /** Seconds into the way: on to the road, and off it. */
  t0: number;
  t1: number;
  /** Each time the route passes here: both ways of a two-way road. */
  passes: CrossingPass[];
  /** The strip of road, for the traffic the simulation does not drive. */
  x: number;
  z: number;
  heading: number;
  length: number;
  /** At the kerb, asking. */
  hailing: boolean;
  /** Out on the road. */
  stepped: boolean;
  /** How long they have stood at the kerb (seconds). */
  heldS: number;
  /** Other routes' traffic is on the strip now (told by the map, which has it). */
  flowBusy: boolean;
  /** Vehicles that have begun to stop for them: they do not think again. */
  giving: Set<number>;
  /** Where they are now, while at the kerb or out on the road. */
  at?: LocalPoint;
}

interface Hit {
  s: number;
  /** How far from the middle of the road, and on which side of it: right of the way along it. */
  off: number;
}

/** Where the route's road is, to ask of any point of the map. */
export class RoadIndex {
  private readonly cells = new Map<number, number[]>();

  constructor(readonly route: Route) {
    const { points } = route.polyline;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / CELL_M);
      for (let k = 0; k <= steps; k++) {
        const t = k / Math.max(1, steps);
        const key = this.key(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
        const list = this.cells.get(key);
        if (!list) this.cells.set(key, [i]);
        else if (list[list.length - 1] !== i) list.push(i);
      }
    }
  }

  private key(x: number, z: number): number {
    return Math.floor(x / CELL_M) * 100_003 + Math.floor(z / CELL_M);
  }

  /** Each pass of the route with `p` between its kerbs. */
  at(p: LocalPoint): Hit[] {
    const { points, cumulative } = this.route.polyline;
    const seen = new Set<number>();
    const hits: Hit[] = [];
    const cx = Math.floor(p.x / CELL_M);
    const cz = Math.floor(p.z / CELL_M);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const i of this.cells.get((cx + dx) * 100_003 + (cz + dz)) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const a = points[i]!;
          const ex = points[i + 1]!.x - a.x;
          const ez = points[i + 1]!.z - a.z;
          const len = Math.hypot(ex, ez);
          if (len === 0) continue;
          const along = Math.max(0, Math.min(len, ((p.x - a.x) * ex + (p.z - a.z) * ez) / len));
          const d = Math.hypot(a.x + (ex * along) / len - p.x, a.z + (ez * along) / len - p.z);
          const s = cumulative[i]! + along;
          if (d > kerbAt(this.route, s)) continue;
          const off = ((-ez * (p.x - a.x) + ex * (p.z - a.z)) / len >= 0 ? 1 : -1) * d;
          const same = hits.find((h) => Math.abs(h.s - s) < SAME_PASS_M);
          if (!same) hits.push({ s, off });
          else if (d < Math.abs(same.off)) [same.s, same.off] = [s, off];
        }
    return hits;
  }

  /** Which side of the road at `s` point `p` is on: right of the way along it is +. */
  sideAt(p: LocalPoint, s: number): number {
    const c = this.route.polyline.pointAt(s);
    return (p.x - c.x) * Math.sin(c.heading) + (p.z - c.z) * Math.cos(c.heading);
  }
}

/** Where `motion` goes over the road from `fromS` seconds into it, soonest first: at most `most` of them. */
export function crossingsOf(
  motion: RiderMotion,
  road: RoadIndex,
  fromS = 0,
  most = Infinity,
): Crossing[] {
  const out: Crossing[] = [];
  const pose = newRiderPose();
  const at = (t: number): LocalPoint => {
    motion.poseAt(t, pose);
    return { x: pose.x, z: pose.z };
  };
  let before: { t: number; p: LocalPoint } | null = null;
  let onFrom = -1;
  /** Every pass of the route anywhere on the way over: its first and last metre under them. */
  let passes: Array<{ from: number; to: number }> = [];
  const note = (hits: readonly { s: number }[]) => {
    for (const { s } of hits) {
      const known = passes.find((p) => s > p.from - SAME_PASS_M && s < p.to + SAME_PASS_M);
      if (!known) passes.push({ from: s, to: s });
      else [known.from, known.to] = [Math.min(known.from, s), Math.max(known.to, s)];
    }
  };
  const span = (t: number, p: LocalPoint) => {
    const from = before!;
    const first = passes[0]?.from;
    if (first === undefined) return;
    const length = Math.hypot(p.x - from.p.x, p.z - from.p.z);
    const width = 2 * kerbAt(road.route, first);
    // Along the road is no crossing, nor out on to it and back.
    if (length > width * MOST_ON_ROAD) return;
    if (road.sideAt(from.p, first) * road.sideAt(p, first) >= 0) return;
    out.push({
      t0: from.t,
      t1: t,
      passes: passes.map((p) => ({ s: p.from, alongM: p.to - p.from })),
      x: (from.p.x + p.x) / 2,
      z: (from.p.z + p.z) / 2,
      heading: Math.atan2(-(p.z - from.p.z), p.x - from.p.x),
      length,
      hailing: false,
      stepped: false,
      heldS: 0,
      flowBusy: false,
      giving: new Set(),
    });
  };
  for (let t = fromS; ; t = Math.min(t + SAMPLE_S, motion.duration)) {
    const p = at(t);
    const hits = road.at(p);
    if (hits.length > 0) {
      if (onFrom < 0) [onFrom, passes] = [t, []];
      note(hits);
    } else {
      if (onFrom >= 0 && before) span(t, p);
      onFrom = -1;
      before = { t, p };
    }
    if (t >= motion.duration || out.length >= most) break;
  }
  return out;
}
