/**
 * A route as a polyline in local metres, addressed by along-route distance `s`.
 *
 * Everything that moves on a route (simulated fleet, the GPS-driven live jeep)
 * stores only `s`. Position and heading are derived from it, so a vehicle can
 * never leave the road by accident.
 */

import type { LocalPoint } from './projection';

export interface PointOnPolyline extends LocalPoint {
  /** Along-route distance in metres. */
  s: number;
  /** Heading in radians, measured from +X toward -Z (i.e. a Three.js yaw). */
  heading: number;
}

export interface Projected extends PointOnPolyline {
  /** Perpendicular distance from the query point to the polyline, metres. */
  offset: number;
}

/** Segments in a chunk, for `project` to skip those too far away to matter. */
const CHUNK = 32;

export class Polyline {
  readonly points: readonly LocalPoint[];
  /** cumulative[i] = distance from points[0] to points[i]. */
  readonly cumulative: Float64Array;
  readonly length: number;
  /** Each chunk's bounding box: minX, maxX, minZ, maxZ (made on first use). */
  private chunks: Float64Array | null = null;

  constructor(points: readonly LocalPoint[]) {
    if (points.length < 2) throw new Error('Polyline needs at least 2 points');
    this.points = points;
    this.cumulative = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      this.cumulative[i] = this.cumulative[i - 1]! + Math.hypot(b.x - a.x, b.z - a.z);
    }
    this.length = this.cumulative[points.length - 1]!;
  }

  /** Index i such that cumulative[i] <= s < cumulative[i+1] (binary search). */
  private segmentAt(s: number): number {
    let lo = 0;
    let hi = this.points.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cumulative[mid]! <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  pointAt(sIn: number): PointOnPolyline {
    const s = Math.max(0, Math.min(this.length, sIn));
    const i = this.segmentAt(s);
    const a = this.points[i]!;
    const b = this.points[i + 1]!;
    const segLen = this.cumulative[i + 1]! - this.cumulative[i]!;
    const t = segLen > 0 ? (s - this.cumulative[i]!) / segLen : 0;
    return {
      s,
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      heading: Math.atan2(-(b.z - a.z), b.x - a.x),
    };
  }

  /**
   * Heading of a vehicle of length `span` centred at s: the direction from
   * its rear (s - span/2) to its front (s + span/2). Unlike the segment
   * heading of pointAt, this turns smoothly through every corner, the way a
   * real vehicle's body does.
   */
  headingAt(s: number, span: number): number {
    const rear = this.pointAt(Math.max(0, s - span / 2));
    const front = this.pointAt(Math.min(this.length, s + span / 2));
    const dx = front.x - rear.x;
    const dz = front.z - rear.z;
    return dx === 0 && dz === 0 ? rear.heading : Math.atan2(-dz, dx);
  }

  /**
   * Nearest point on the polyline to `p`.
   *
   * Pass `window` = [sMin, sMax] to only consider segments overlapping that
   * range. Map matching does this so a fix is never snapped to a parallel lane
   * or to the return leg of a loop route that happens to be closer.
   */
  project(p: LocalPoint, window?: readonly [number, number]): Projected {
    let best: Projected | null = null;
    const [sMin, sMax] = window ?? [0, this.length];
    // The nearest point can be no further than the far corner of any chunk's
    // box, so a chunk whose box is further off than that has nothing to offer.
    const boxes = window ? null : this.chunkBoxes();
    let reach = Infinity;
    for (let c = 0; boxes && c < boxes.length; c += 4) {
      const dx = Math.max(p.x - boxes[c]!, boxes[c + 1]! - p.x);
      const dz = Math.max(p.z - boxes[c + 2]!, boxes[c + 3]! - p.z);
      reach = Math.min(reach, Math.hypot(dx, dz));
    }

    for (let i = 0; i < this.points.length - 1; i++) {
      if (boxes && i % CHUNK === 0) {
        const c = (i / CHUNK) * 4;
        const dx = Math.max(boxes[c]! - p.x, 0, p.x - boxes[c + 1]!);
        const dz = Math.max(boxes[c + 2]! - p.z, 0, p.z - boxes[c + 3]!);
        if (Math.hypot(dx, dz) > reach) {
          i += CHUNK - 1;
          continue;
        }
      }
      const s0 = this.cumulative[i]!;
      const s1 = this.cumulative[i + 1]!;
      if (s1 < sMin || s0 > sMax) continue;

      const a = this.points[i]!;
      const b = this.points[i + 1]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const segLen = s1 - s0;
      // Clamp to the part of this segment that lies inside the window.
      const tMin = segLen > 0 ? Math.max(0, (sMin - s0) / segLen) : 0;
      const tMax = segLen > 0 ? Math.min(1, (sMax - s0) / segLen) : 0;
      const tRaw = len2 > 0 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2 : 0;
      const t = Math.max(tMin, Math.min(tMax, tRaw));
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const offset = Math.hypot(p.x - x, p.z - z);

      if (!best || offset < best.offset) {
        best = { s: s0 + (s1 - s0) * t, x, z, offset, heading: Math.atan2(-dz, dx) };
      }
    }
    // Window excluded every segment: fall back to an unconstrained search.
    return best ?? this.project(p);
  }

  private chunkBoxes(): Float64Array {
    if (this.chunks) return this.chunks;
    const segments = this.points.length - 1;
    const boxes = new Float64Array(Math.ceil(segments / CHUNK) * 4);
    for (let c = 0; c * CHUNK < segments; c++) {
      let [minX, maxX, minZ, maxZ] = [Infinity, -Infinity, Infinity, -Infinity];
      const end = Math.min(segments, (c + 1) * CHUNK);
      for (let i = c * CHUNK; i <= end; i++) {
        const { x, z } = this.points[i]!;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
      boxes.set([minX, maxX, minZ, maxZ], c * 4);
    }
    return (this.chunks = boxes);
  }
}
