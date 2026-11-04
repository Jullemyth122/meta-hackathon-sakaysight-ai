/**
 * A way drawn from street corners, as a vehicle would drive it: the little
 * jogs of the map's points taken out, and every corner a curve.
 */

import type { LocalPoint } from './projection';
import { simplify } from './simplify';

/** Jogs smaller than this are the map's, not the road's (metres). */
const JOG_M = 3;
/** A corner's curve is sampled this many times. */
const CORNER_STEPS = 10;
const SAME_POINT_M = 0.01;

const towards = (from: LocalPoint, to: LocalPoint, metres: number): LocalPoint => {
  const len = Math.hypot(to.x - from.x, to.z - from.z) || 1;
  return {
    x: from.x + ((to.x - from.x) * metres) / len,
    z: from.z + ((to.z - from.z) * metres) / len,
  };
};

/** `points` with each corner rounded off, starting up to `reachM` before it. */
export function curveWay(points: readonly LocalPoint[], reachM: number): LocalPoint[] {
  const line = simplify(points, JOG_M);
  if (line.length < 3) return line;
  const out: LocalPoint[] = [line[0]!];
  for (let i = 1; i + 1 < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const c = line[i + 1]!;
    const reach = Math.min(
      reachM,
      Math.hypot(a.x - b.x, a.z - b.z) / 2,
      Math.hypot(c.x - b.x, c.z - b.z) / 2,
    );
    const p = towards(b, a, reach);
    const q = towards(b, c, reach);
    for (let k = 0; k <= CORNER_STEPS; k++) {
      const t = k / CORNER_STEPS;
      const u = 1 - t;
      const on = {
        x: u * u * p.x + 2 * u * t * b.x + t * t * q.x,
        z: u * u * p.z + 2 * u * t * b.z + t * t * q.z,
      };
      // Two curves can meet at a point: it is one point.
      const last = out[out.length - 1]!;
      if (Math.hypot(on.x - last.x, on.z - last.z) > SAME_POINT_M) out.push(on);
    }
  }
  out.push(line[line.length - 1]!);
  return out;
}
