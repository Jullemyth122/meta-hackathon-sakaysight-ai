/**
 * Real roads are curves, but a route from OpenStreetMap is straight pieces
 * with square corners, and a vehicle driving one would pivot on the spot. So
 * a route's line is smoothed: every point becomes the average of the road a
 * little way either side of it, twice. Straight road stays exactly as it was;
 * corners become curves, however many short pieces they are made of.
 *
 * Everything else about a route (stops, kerbs) is given in metres along the
 * line, so toSmooth carries those over to the new line, which is a little
 * shorter: it no longer goes right into its corners.
 */

import { Polyline } from './polyline';
import type { LocalPoint } from './projection';
import { simplify } from './simplify';

/** Sampled this often before averaging (metres). */
const STEP_M = 3;
/** Points that add less than this to the shape are dropped afterwards (metres). */
const KEEP_M = 0.1;
/** Two averages at this share of the reach: together, about the reach's own smoothing. */
const PASS_SHARE = 0.7;

/** A turn is judged over about a vehicle's length (metres). */
const JUDGE_OVER_M = 12;
const JUDGE_EVERY_M = 6;

/** Where `line` still turns tighter than `radiusM`, as metres along it. */
export function tightSpots(line: Polyline, radiusM: number): number[] {
  const out: number[] = [];
  const half = JUDGE_OVER_M / 2;
  for (let s = half; s < line.length - half; s += JUDGE_EVERY_M) {
    const a = line.headingAt(s - half / 2, half);
    const b = line.headingAt(s + half / 2, half);
    const turn = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
    if (turn * radiusM > half) out.push(s);
  }
  return out;
}

export interface SmoothLine {
  polyline: Polyline;
  /** Where a place `s` metres along the original line is along the new one. */
  toSmooth(s: number): number;
}

/** One average over `reach(i)` samples either side of each sample. */
function averaged(xs: Float64Array, loop: boolean, reach: Int32Array): Float64Array {
  const n = xs.length;
  const sum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i]! + xs[i]!;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (loop) {
      const k = Math.min(reach[i]!, (n - 1) >> 1);
      const a = i - k;
      const b = i + k + 1;
      // Round the seam: the part past either end comes from the other end.
      const whole = sum[n]!;
      const below = a < 0 ? whole - sum[n + a]! : 0;
      const above = b > n ? sum[b - n]! : 0;
      out[i] = (sum[Math.min(b, n)]! - sum[Math.max(a, 0)]! + below + above) / (2 * k + 1);
    } else {
      // The ends stay put: the window shrinks to fit.
      const k = Math.min(reach[i]!, i, n - 1 - i);
      out[i] = (sum[i + k + 1]! - sum[i - k]!) / (2 * k + 1);
    }
  }
  return out;
}

/**
 * `line` with its corners rounded, each place smoothed over `reachM(s)` metres
 * of road either side (a wider road's kerb lane needs a wider curve).
 */
export function smoothTurns(
  line: Polyline,
  loop: boolean,
  reachM: (s: number) => number,
): SmoothLine {
  const L = line.length;
  const parts = Math.max(2, Math.ceil(L / STEP_M));
  const step = L / parts;
  // A loop's last sample would repeat its first.
  const n = loop ? parts : parts + 1;
  let xs: Float64Array = new Float64Array(n);
  let zs: Float64Array = new Float64Array(n);
  const reach = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * step;
    const p = line.pointAt(s);
    xs[i] = p.x;
    zs[i] = p.z;
    reach[i] = Math.round((PASS_SHARE * reachM(s)) / step);
  }
  for (let pass = 0; pass < 2; pass++) {
    xs = averaged(xs, loop, reach);
    zs = averaged(zs, loop, reach);
  }

  const points: LocalPoint[] = Array.from(xs, (x, i) => ({ x, z: zs[i]! }));
  if (loop) points.push({ ...points[0]! });
  // How far along the new line each sample is.
  const along = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    along[i] = along[i - 1]! + Math.sqrt(dx * dx + dz * dz);
  }
  const polyline = new Polyline(simplify(points, KEEP_M));
  const fit = polyline.length / Math.max(1e-9, along[along.length - 1]!);
  return {
    polyline,
    toSmooth(s) {
      const at = Math.max(0, Math.min(parts, s / step));
      const i = Math.min(parts - 1, Math.floor(at));
      return (along[i]! + (along[i + 1]! - along[i]!) * (at - i)) * fit;
    },
  };
}
