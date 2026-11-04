/**
 * Waiting by the road. Stops are not the only place to catch a jeepney: people
 * stand where their street meets the road, and whatever is going their way
 * pulls over. So a spot the commuter chose by a road a route runs on is where
 * they board, on the side of the road going their way, with no stop to reach.
 * Only buses and jeepneys: a UV Express loads at its terminals.
 */

import type { LocalPoint } from '../geo/projection';
import { aheadOf, isTerminal, kerbAt, type Route } from '../geo/routes';
import { roadsidePoint } from '../people/stopLayout';
import { stopsByTheRoad } from '../vehicles/specs';

/** A spot this far past a road's kerb, at most, is by that road (metres). */
export const ROADSIDE_M = 20;
/** This close to a stop along the road, the spot is that stop (metres). */
const AT_STOP_M = 30;
/** What the phone calls it: it has no name of its own. */
export const YOUR_SPOT = 'your spot by the road';

export interface Roadside {
  /** Where along the route (metres). */
  s: number;
  /** Where to stand, on the kerb a vehicle going this way pulls in to. */
  at: LocalPoint;
  /** The spot chosen is on the far side of the road: going this way means crossing it first. */
  across: boolean;
}

/** A way to board route `route` from a spot: at a stop, or (`flag`) right there by the road. */
export interface RoadsideBoarding {
  /** The stop it is at, or the next one after the spot. */
  stop: number;
  flag: Roadside | null;
}

/** Each time the route passes `p`: how far along, and whether `p` is on its right. */
function passes(route: Route, p: LocalPoint): Array<{ s: number; right: boolean }> {
  const { points, cumulative } = route.polyline;
  const out: Array<{ s: number; right: boolean }> = [];
  let best: { s: number; right: boolean; d: number } | null = null;
  const close = () => {
    if (best) out.push({ s: best.s, right: best.right });
    best = null;
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const ex = points[i + 1]!.x - a.x;
    const ez = points[i + 1]!.z - a.z;
    const len = Math.hypot(ex, ez);
    if (len === 0) continue;
    const along = Math.max(0, Math.min(len, ((p.x - a.x) * ex + (p.z - a.z) * ez) / len));
    const s = cumulative[i]! + along;
    const d = Math.hypot(a.x + (ex * along) / len - p.x, a.z + (ez * along) / len - p.z);
    if (d > kerbAt(route, s) + ROADSIDE_M) {
      close();
      continue;
    }
    if (!best || d < best.d)
      // Right of a direction (dx, dz) is (−dz, dx), as in stopLayout.ts.
      best = { s, d, right: -ez * (p.x - a.x) + ex * (p.z - a.z) >= 0 };
  }
  close();
  return out;
}

/** Where someone at `p` can board `route`: nowhere when the route does not pass by it. */
export function roadsideBoardings(route: Route, p: LocalPoint): RoadsideBoarding[] {
  if (!route.loop || !stopsByTheRoad(route.kind ?? 'jeepney')) return [];
  return passes(route, p).flatMap(({ s, right }): RoadsideBoarding[] => {
    const n = route.stops.length;
    const after = route.stops.findIndex((st) => st.s >= s);
    const next = after < 0 ? 0 : after;
    const before = (next - 1 + n) % n;
    if (aheadOf(route, s, route.stops[next]!.s) <= AT_STOP_M) return [{ stop: next, flag: null }];
    if (aheadOf(route, route.stops[before]!.s, s) <= AT_STOP_M)
      return [{ stop: before, flag: null }];
    // Just short of a terminal everyone gets off: there is no riding on from there.
    if (isTerminal(route, next)) return [];
    // Where they chose, when that is by the kerb this way pulls in to.
    const c = route.polyline.pointAt(s);
    const clear = Math.hypot(p.x - c.x, p.z - c.z) >= kerbAt(route, s);
    const at = right && clear ? p : roadsidePoint(route, s, 1);
    return [{ stop: next, flag: { s, at, across: !right } }];
  });
}
