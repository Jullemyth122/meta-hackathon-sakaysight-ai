/**
 * What the assistant (/api/assist) is told, in the server planner's format
 * (RawSnapshot in api/_lib/planner.ts).
 *
 * The planner thinks in one straight line: stops at km marks, jeepneys at km
 * marks, everyone driving towards higher km, stops found by name. Our route
 * is a loop, so it is cut open at a point that suits the question:
 *
 *   driver     at the jeepney, so it is at 0 km.
 *   commuter   just after their destination, so the destination is the last
 *              stop and their stop comes before it.
 *   operator   at the start of the route.
 *
 * Only what the person's own screen is about goes in: what is sent to Meta
 * grows with every jeepney and stop in here.
 *
 *   driver     their jeepney and the next stops on their screen (3 stops or
 *              1.5 km, as driver.ts), with the jeepneys between them, which
 *              get to those stops first and take their riders.
 *   commuter   the jeepney they ride, or the next ones coming to their stop
 *              (the arrivals on their screen), and the stops from there to
 *              their destination.
 *
 * Leaving the rest out changes no number: a jeepney further ahead has
 * already passed those stops, one further behind gets there after.
 *
 *   operator   (the Live twin, no jeepney selected) the whole route and
 *              fleet, at their real positions; /api/assist sends Meta only
 *              the fleet totals and the busiest stops from it.
 *
 * Names are made unique ("Name → towards", then a number), because the
 * planner matches stops by name and a loop passes some names twice.
 */

import { aheadOf, isTerminal, type Route } from '../geo/routes';
import type { FleetKind } from '../vehicles/specs';
import { dispatch } from './dispatch';
import { ADVISORY, serves, type TwinState } from './model';
import { tripRouteFor, type TripRoute, type TripBudgetInputs } from './tripBudget';

/** The fields of api/_lib/planner.ts RawSnapshot we fill. */
export interface PlannerSnapshot {
  tripRoute: TripRoute;
  route: {
    name: string;
    source: string;
    lengthKm: number;
    stops: Array<{ name: string; sKm: number; waiting: number; terminal: boolean }>;
  };
  simulatedFleet: Array<{
    plate: string;
    kind: FleetKind;
    occupancy: number;
    capacity: number;
    kmh: number;
    nextStop?: string;
    sKm: number;
    dropOffs?: Record<string, number>;
    /** Seconds to each stop ahead, as the person's screen shows them. */
    etaS?: Record<string, number>;
  }>;
}

/** The request body /api/assist and /api/plan accept, minus the question. */
export interface PlannerRequest {
  tripBudgetInputs?: Partial<TripBudgetInputs>;
  dieselPriceBasis?: string;
  snapshot: PlannerSnapshot;
  role: 'driver' | 'commuter' | 'operator';
  driverPlate?: string;
  commuterStop?: string;
  destinationStop?: string;
  /** What the person's phone shows (screen.ts); the assistant must agree with it. */
  screen?: object;
  /** This week's DOE price, so the planner's peso figures match the app's. */
  dieselPricePhpPerLiter: number;
}

export type PlannerFocus =
  | { role: 'driver'; vehicle: number }
  /** The Live twin with nothing selected: every stop and jeepney, real positions. */
  | { role: 'operator' }
  | {
      role: 'commuter';
      stop: number;
      destination: number;
      direction: 1 | -1;
      /** The jeepneys on their screen: the one they ride, or the arrivals. */
      jeepneys: readonly number[];
    };

/**
 * One unique, readable name per stop. The number goes before the arrow so
 * no label is a substring of another (the planner matches with includes()).
 */
export function stopLabels(route: Route): string[] {
  const seen = new Map<string, number>();
  return route.stops.map((st) => {
    const key = `${st.name}|${st.towards ?? ''}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return `${st.name}${n > 1 ? ` (${n})` : ''}${st.towards ? ` → ${st.towards}` : ''}`;
  });
}

const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;

export function plannerRequest(state: TwinState, focus: PlannerFocus): PlannerRequest {
  const { route, vehicles, passengers } = state;
  const L = route.polyline.length;
  const labels = stopLabels(route);

  // Where the line is cut, and which way it runs.
  const direction =
    focus.role === 'driver'
      ? vehicles[focus.vehicle]!.direction
      : focus.role === 'commuter'
        ? focus.direction
        : 1;
  const s0 =
    focus.role === 'driver'
      ? vehicles[focus.vehicle]!.s - direction
      : focus.role === 'commuter' && route.loop
        ? route.stops[focus.destination]!.s + 1
        : direction === 1
          ? 0
          : L;
  /** Position on the cut-open line, metres; negative = not on it. */
  const at = (s: number) => (route.loop ? aheadOf(route, s0, s) : (s - s0) * direction);

  let stops = route.stops
    .map((st, i) => ({ i, m: at(st.s) }))
    .filter((x) => x.m >= 0)
    .sort((a, b) => a.m - b.m);
  let fleet = vehicles
    .filter((v) => v.inService !== false && serves(route, v, direction))
    .map((v) => ({ v, m: at(v.s) }))
    .filter((x) => x.m >= 0);
  if (focus.role === 'driver') {
    // The stops on the driver's screen: up to the next terminal, then the
    // horizon (driver.ts; m is 1 m more than its distance). The stop it is
    // standing at is not ahead of it.
    const here = vehicles[focus.vehicle]!.atStop;
    stops = stops.filter((x) => x.i !== here);
    const end = stops.findIndex((x) => isTerminal(route, x.i));
    if (end >= 0) stops = stops.slice(0, end + 1);
    stops = stops.filter(
      (x, i) => i === 0 || (i < ADVISORY.horizonStops && x.m <= ADVISORY.horizonM + 1),
    );
    const me = at(vehicles[focus.vehicle]!.s);
    const last = stops[stops.length - 1]?.m ?? me;
    fleet = fleet.filter((x) => x.m >= me && x.m <= last);
  } else if (focus.role === 'commuter') {
    const shown = new Set(focus.jeepneys);
    fleet = fleet.filter((x) => shown.has(x.v.index));
    // From the stop the furthest of them is at (a jeepney stopped there is
    // a few metres past it) or their own stop, whichever is first.
    const first = Math.min(at(route.stops[focus.stop]!.s), ...fleet.map((x) => x.m)) - 5;
    stops = stops.filter((x) => x.m >= first);
  }
  // The operator sees every jeepney, also those past the last stop on
  // their way round to the first one (only the loop's length holds them).
  const lengthM = focus.role === 'operator' && route.loop ? L : (stops[stops.length - 1]?.m ?? 0);
  fleet = fleet.filter((x) => x.m <= lengthM);

  /** Riders on jeepney `vehicle`, by the stop they get off at. */
  const dropOffsOf = (vehicle: number) => {
    const out: Record<string, number> = {};
    for (const p of passengers) {
      if (p.vehicle !== vehicle || p.phase === 'alighting') continue;
      const name = labels[p.destinationStop]!;
      out[name] = (out[name] ?? 0) + 1;
    }
    return out;
  };

  const waiting = (stop: number) =>
    passengers.filter(
      (p) => p.phase === 'waiting' && p.originStop === stop && p.direction === direction,
    ).length;

  // Not for the operator: every stop of every vehicle would not fit either.
  const plan = focus.role === 'operator' ? null : dispatch(state);
  const etasOf = (vehicle: number, m: number) =>
    Object.fromEntries(
      stops
        .filter((x) => x.m >= m)
        .map((x) => [labels[x.i]!, Math.round(plan!.etaS(vehicle, x.i))]),
    );

  const snapshot: PlannerSnapshot = {
    tripRoute: tripRouteFor(route),
    route: {
      name: route.name,
      source: route.source,
      lengthKm: round(lengthM / 1000),
      stops: stops.map((x) => ({
        name: labels[x.i]!,
        sKm: round(x.m / 1000),
        waiting: waiting(x.i),
        terminal: isTerminal(route, x.i),
      })),
    },
    simulatedFleet: fleet.map(({ v, m }) => {
      const next = stops.find((x) => x.m > m + 1);
      return {
        plate: v.plate,
        kind: v.kind ?? 'jeepney',
        occupancy: v.occupancy,
        capacity: v.capacity,
        kmh: round(v.speedMps * 3.6, 1),
        nextStop: next ? labels[next.i] : undefined,
        sKm: round(m / 1000),
        // Every rider's stop for the whole fleet would not fit /api/assist's
        // size limit; for the operator the planner estimates them instead.
        ...(plan && { dropOffs: dropOffsOf(v.index), etaS: etasOf(v.index, m) }),
      };
    }),
  };

  const dieselPricePhpPerLiter = ADVISORY.fuel.dieselPhpPerL;
  if (focus.role === 'operator') return { snapshot, role: 'operator', dieselPricePhpPerLiter };
  return focus.role === 'driver'
    ? {
        snapshot,
        role: 'driver',
        driverPlate: vehicles[focus.vehicle]!.plate,
        dieselPricePhpPerLiter,
      }
    : {
        snapshot,
        role: 'commuter',
        commuterStop: labels[focus.stop],
        destinationStop: labels[focus.destination],
        dieselPricePhpPerLiter,
      };
}
