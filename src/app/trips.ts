/**
 * A planned trip, between the planner and the app: the same whether it was
 * chosen in the panel (ui/network/TripPlanner.tsx) or by asking the agent.
 */

import type { LocalPoint } from '@/core/geo/projection';
import type { Network } from '@/core/network/network';
import type { TripOption } from '@/core/network/plan';
import { focusRoute, getNetwork, routeIndex } from './network';
import { useApp, type TripEnd, type TripLeg } from './store';
import type { TwinRuntime } from './twinRuntime';

/** A trip option as the legs the app keeps (store.TripLeg), starting from `from`. */
export function legsOf(
  o: TripOption,
  from: LocalPoint | undefined,
  via: LocalPoint | undefined,
): TripLeg[] {
  return o.legs.map((l, k) => ({
    route: l.route,
    board: l.board,
    alight: l.alight,
    walkM: k === 0 ? o.walkToM : o.transferWalkM,
    approachMode: k === 0 ? o.toBy : 'walk',
    ...(k === 0 && from && { from }),
    ...(k === 0 && via && { via }),
    ...(l.flag && { flag: l.flag }),
  }));
}

/** Every point of a trip worth framing: its ends, and where each jeepney is boarded and left. */
export function tripPoints(
  network: Network,
  legs: readonly TripLeg[],
  ends: readonly TripEnd[],
): LocalPoint[] {
  return [
    ...ends.map((e) => e.at),
    ...legs.flatMap((l) => {
      const r = network.routes[l.route]!.route;
      return [r.polyline.pointAt(r.stops[l.board]!.s), r.polyline.pointAt(r.stops[l.alight]!.s)];
    }),
  ];
}

/** Set out on `o`: its first route focused, and "you" joining it as a rider. */
export function takeTrip(o: TripOption, twin: TwinRuntime): void {
  const app = useApp.getState();
  const first = o.legs[0]!;
  const { home, from } = app.tripEnds;
  // Already the focused route: keep its live jeepneys (the one just offered).
  if (routeIndex(twin.route.id) !== first.route) app.setFocus(focusRoute(first.route, twin), true);
  app.setCommuter({ stop: first.board, destination: first.alight });
  app.setTripLegs(legsOf(o, home?.at, from?.at));
  // From this trip's own start, not a spot picked on the map before.
  app.setMe({ place: null });
  // "You" set out in the twin from where the trip starts; the app follows you.
  app.startLeg(0, getNetwork()!.routes[first.route]!.route.id);
}
