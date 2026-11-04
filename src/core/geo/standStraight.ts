/**
 * Where a vehicle standing still on `route` stands: not in the middle of a
 * sharp bend (a U-turn at its terminal, a corner), where it would sit across
 * the road, but just short of it, straight in its lane. It takes the bend once
 * it moves.
 */

import type { Route } from './routes';

/** A bend sharper than this over STRAIGHT_SPAN_M is one to wait short of (radians). */
const BEND_RAD = (25 * Math.PI) / 180;
const STRAIGHT_SPAN_M = 24;
/** Looked back for a straight stretch this far, this often (metres). */
const LOOK_BACK_M = 80;
const STEP_M = 5;

function bendAt(route: Route, s: number): number {
  const line = route.polyline;
  const L = line.length;
  const at = (x: number) => (route.loop ? ((x % L) + L) % L : Math.max(0, Math.min(L, x)));
  const a = line.headingAt(at(s - STRAIGHT_SPAN_M / 2), 4);
  const b = line.headingAt(at(s + STRAIGHT_SPAN_M / 2), 4);
  return Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
}

/** `s` itself if it is on a straight; else the nearest straight just behind it. */
export function standStraight(route: Route, s: number): number {
  if (bendAt(route, s) < BEND_RAD) return s;
  const L = route.polyline.length;
  for (let back = STEP_M; back <= LOOK_BACK_M; back += STEP_M) {
    const x = route.loop ? (((s - back) % L) + L) % L : Math.max(0, s - back);
    if (bendAt(route, x) < BEND_RAD) return x;
  }
  return s;
}
