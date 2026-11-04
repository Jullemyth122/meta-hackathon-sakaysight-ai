/**
 * The digital jeepney that follows one phone's GPS.
 *
 * Pipeline per fix:  project to local metres → map-match onto the route
 * (windowed, so it cannot jump to the other side of a loop) → new target.
 * Per frame:         ease the rendered pose toward the target, extrapolating
 * along the road for at most MAX_EXTRAPOLATION_S so 1 Hz fixes do not look
 * like teleports. After STALE_MS without a fix we say so instead of pretending.
 */

import type { Route } from '../geo/routes';
import { createProjection, type LocalPoint, type Projection } from '../geo/projection';
import type { GpsFix } from './types';

export type LinkStatus = 'live' | 'stale' | 'lost';

const STALE_MS = 8_000;
const LOST_MS = 30_000;
/** Not heard from for this long, a phone has gone: it leaves the map (a real one just stopped). */
const GONE_MS = 60_000;
const MAX_EXTRAPOLATION_S = 2;
/** Rendered pose closes ~63% of the gap to the target every this many seconds. */
const SMOOTHING_S = 0.5;
/** How far back / ahead of the last match the next match may land, metres. */
const MATCH_BACK_M = 60;
const MATCH_AHEAD_M = 250;
const MAX_TRACE_POINTS = 4_000;

/** Whether a phone last heard from at `lastFixAt` has gone (see GONE_MS). */
export const phoneGone = (lastFixAt: number, now: number): boolean => now - lastFixAt > GONE_MS;

export interface Pose {
  x: number;
  z: number;
  /** Three.js yaw, radians. */
  heading: number;
}

export class LiveVehicle {
  readonly route: Route | null;
  /** Raw projected fixes, for drawing the breadcrumb trail. */
  readonly trace: LocalPoint[] = [];
  /** Rendered pose. Mutated in place every frame, so read, do not keep. */
  readonly pose: Pose = { x: 0, z: 0, heading: 0 };

  matched = false;
  /** Distance from the fix to the road, metres (NaN before the first fix). */
  offsetM = Number.NaN;
  speedMps = 0;
  lastFix: GpsFix | null = null;

  private projection: Projection | null;
  private targetS = 0;
  private direction: 1 | -1 = 1;
  private target: Pose = { x: 0, z: 0, heading: 0 };
  private hasPose = false;

  constructor(route: Route | null) {
    this.route = route;
    // Without a geographic route the first fix becomes the scene origin.
    this.projection = route?.projection ?? null;
  }

  ingest(fix: GpsFix): void {
    if (this.lastFix && fix.timestamp <= this.lastFix.timestamp) return;
    this.projection ??= createProjection(fix);
    const p = this.projection.toLocal(fix);

    this.trace.push(p);
    if (this.trace.length > MAX_TRACE_POINTS) this.trace.shift();
    this.speedMps = fix.speedMps ?? this.speedMps;

    const polyline = this.route?.projection ? this.route.polyline : null;
    if (polyline) {
      const window: [number, number] | undefined = this.matched
        ? [this.targetS - MATCH_BACK_M, this.targetS + MATCH_AHEAD_M]
        : undefined;
      const hit = polyline.project(p, window);
      this.offsetM = hit.offset;
      this.matched = hit.offset <= Math.max(25, fix.accuracyM * 1.5);
      if (this.matched) {
        if (Math.abs(hit.s - this.targetS) > 1) this.direction = hit.s >= this.targetS ? 1 : -1;
        this.targetS = hit.s;
        this.target = {
          x: hit.x,
          z: hit.z,
          heading: hit.heading + (this.direction === 1 ? 0 : Math.PI),
        };
      }
    }

    if (!this.matched) {
      this.target = { x: p.x, z: p.z, heading: this.headingFromFix(fix, p) };
    }
    if (!this.hasPose) {
      Object.assign(this.pose, this.target);
      this.hasPose = true;
    }
    this.lastFix = fix;
  }

  /** Per-frame update. Allocation-free. */
  update(dtS: number, now: number): void {
    if (!this.lastFix) return;

    let tx = this.target.x;
    let tz = this.target.z;
    const ageS = Math.min((now - this.lastFix.timestamp) / 1000, MAX_EXTRAPOLATION_S);
    if (this.matched && this.route && ageS > 0 && this.speedMps > 0.5) {
      const ahead = this.route.polyline.pointAt(
        this.targetS + this.direction * this.speedMps * ageS,
      );
      tx = ahead.x;
      tz = ahead.z;
    }

    const k = 1 - Math.exp(-dtS / SMOOTHING_S);
    this.pose.x += (tx - this.pose.x) * k;
    this.pose.z += (tz - this.pose.z) * k;
    this.pose.heading += shortestAngle(this.pose.heading, this.target.heading) * k;
  }

  status(now: number): LinkStatus {
    if (!this.lastFix) return 'lost';
    const age = now - this.lastFix.timestamp;
    return age > LOST_MS ? 'lost' : age > STALE_MS ? 'stale' : 'live';
  }

  /** The projection the trace is expressed in; needed to turn it back into lat/lng. */
  get projectionInUse(): Projection | null {
    return this.projection;
  }

  private headingFromFix(fix: GpsFix, p: LocalPoint): number {
    // Compass degrees (clockwise from north) → Three.js yaw (counter-clockwise from +X).
    if (fix.headingDeg !== null && Number.isFinite(fix.headingDeg)) {
      return Math.PI / 2 - (fix.headingDeg * Math.PI) / 180;
    }
    const prev = this.trace[this.trace.length - 2];
    if (prev && Math.hypot(p.x - prev.x, p.z - prev.z) > fix.accuracyM) {
      return Math.atan2(-(p.z - prev.z), p.x - prev.x);
    }
    return this.target.heading;
  }
}

/** Signed difference b - a wrapped to (-π, π]. */
export function shortestAngle(a: number, b: number): number {
  const d = (((b - a) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI);
  return d - Math.PI;
}
