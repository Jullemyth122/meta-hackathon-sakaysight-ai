/**
 * First come, first served: which jeepney picks up whom.
 *
 * Every jeepney heading to a stop where people wait is a "visit". Visits are
 * handled nearest first, so the jeepney that gets there first claims the
 * queue, up to the seats it will have free on arrival (its riders getting off
 * on the way free seats; people it has already claimed at earlier stops take
 * them). Whoever is left waits for the next jeepney. No two jeepneys are ever
 * sent for the same people, and a driver can see that a crowd is covered.
 */

import { isTerminal } from '../geo/routes';
import {
  ADVISORY,
  distanceTo,
  serves,
  takingRiders,
  loadsAt,
  carries,
  travelSeconds,
  type PassengerState,
  type TwinState,
} from './model';

export interface Claim {
  vehicle: number;
  stop: number;
  /** Passengers this vehicle will pick up there, in queue order. */
  passengers: number[];
  /** How far the vehicle is from the stop, metres. */
  distanceM: number;
}

export interface Dispatch {
  claims: readonly Claim[];
  /** Waiting at each stop that no jeepney in range can take yet. */
  unclaimed: readonly number[];
  /** Passengers vehicle `vehicle` will pick up at `stop`. */
  claimedAt(vehicle: number, stop: number): number;
  /** The vehicle that will pick up waiting passenger `id`, if any. */
  vehicleFor(id: number): number | null;
  /** Seats vehicle `vehicle` will have free when it reaches `stop`, before boarding there. */
  freeSeatsAt(vehicle: number, stop: number): number;
  /**
   * Seconds until vehicle `vehicle` reaches `stop`: its current speed to the
   * next stop, cruising after that, and a dwell at every stop it makes on the
   * way (someone getting off, someone it picks up, a terminal).
   */
  etaS(vehicle: number, stop: number): number;
}

/** Where riders on board get off: one entry per rider, with how far ahead. */
function dropsOf(state: TwinState, vehicle: number): Array<{ stop: number; d: number }> {
  const v = state.vehicles[vehicle]!;
  return state.passengers
    .filter((p) => p.vehicle === vehicle && p.phase !== 'alighting')
    .map((p) => ({
      stop: p.destinationStop,
      d: distanceTo(state.route, v, state.route.stops[p.destinationStop]!.s),
    }));
}

export function dispatch(state: TwinState): Dispatch {
  const { route, vehicles, passengers } = state;

  // Queues per stop, earliest arrival first.
  const queues = new Map<number, PassengerState[]>();
  for (const p of passengers) {
    // Someone by the road is picked up on sight, by whatever comes with a seat.
    if (p.phase !== 'waiting' || p.flagS !== undefined) continue;
    (queues.get(p.originStop) ?? queues.set(p.originStop, []).get(p.originStop)!).push(p);
  }
  for (const q of queues.values()) q.sort((a, b) => a.queuedAt - b.queuedAt || a.id - b.id);

  // Every (vehicle, stop) where that vehicle could take someone, nearest first.
  const visits: Array<{ vehicle: number; stop: number; distanceM: number }> = [];
  for (const v of vehicles) {
    if (!takingRiders(v)) continue;
    for (const stop of queues.keys()) {
      if (!loadsAt(route, v, stop)) continue;
      const d = distanceTo(route, v, route.stops[stop]!.s);
      if (d < 0) continue;
      visits.push({ vehicle: v.index, stop, distanceM: d });
    }
  }
  visits.sort((a, b) => a.distanceM - b.distanceM);

  const drops = vehicles.map((v) => dropsOf(state, v.index));
  const claimedSoFar = vehicles.map(() => 0);
  const taken = new Set<number>();
  const owner = new Map<number, number>();
  const claims: Claim[] = [];

  /** Free seats on reaching a point `distanceM` ahead: riders off by then, claims so far on. */
  const freeOnArrival = (vehicle: number, distanceM: number) => {
    const v = vehicles[vehicle]!;
    const off = drops[vehicle]!.filter((x) => x.d <= distanceM + 1).length;
    return Math.max(0, v.capacity - v.occupancy + off - claimedSoFar[vehicle]!);
  };

  for (const visit of visits) {
    const v = vehicles[visit.vehicle]!;
    const queue = queues.get(visit.stop)!;
    let free = freeOnArrival(visit.vehicle, visit.distanceM);
    const mine: number[] = [];
    for (const p of queue) {
      if (free === 0) break;
      if (taken.has(p.id) || !serves(route, v, p.direction)) continue;
      if (!carries(route, v, visit.stop, p.destinationStop)) continue;
      taken.add(p.id);
      owner.set(p.id, visit.vehicle);
      mine.push(p.id);
      free--;
    }
    if (mine.length === 0) continue;
    claimedSoFar[visit.vehicle]! += mine.length;
    claims.push({ ...visit, passengers: mine });
  }

  const unclaimed = route.stops.map(
    (_, stop) => (queues.get(stop) ?? []).filter((p) => !taken.has(p.id)).length,
  );

  const claimedAt = (vehicle: number, stop: number) =>
    claims.find((c) => c.vehicle === vehicle && c.stop === stop)?.passengers.length ?? 0;

  return {
    claims,
    unclaimed,
    claimedAt,
    vehicleFor: (id) => owner.get(id) ?? null,

    freeSeatsAt(vehicle, stop) {
      const v = vehicles[vehicle]!;
      const d = distanceTo(route, v, route.stops[stop]!.s);
      const off = drops[vehicle]!.filter((x) => x.d <= d + 1).length;
      // Claims picked up before this stop take seats; claims at it do not yet.
      const before = claims
        .filter((c) => c.vehicle === vehicle && c.distanceM < d - 1)
        .reduce((n, c) => n + c.passengers.length, 0);
      return Math.max(0, v.capacity - v.occupancy + off - before);
    },

    etaS(vehicle, stop) {
      const v = vehicles[vehicle]!;
      const d = Math.max(0, distanceTo(route, v, route.stops[stop]!.s));
      let first = d;
      let made = 0;
      const between: Array<{ i: number; x: number }> = [];
      route.stops.forEach((st, i) => {
        const x = distanceTo(route, v, st.s);
        if (i === v.atStop || i === stop || x <= 0 || x >= d) return;
        first = Math.min(first, x);
        between.push({ i, x });
        const stops =
          isTerminal(route, i) ||
          claimedAt(vehicle, i) > 0 ||
          drops[vehicle]!.some((y) => y.stop === i);
        if (stops) made++;
      });
      // Road the fleet has just driven goes by how long it really took, queues
      // and stops and all; only road nobody has driven lately goes by pace.
      if (state.stopToStopS) {
        between.push({ i: stop, x: d });
        between.sort((a, b) => a.x - b.x);
        let seconds = travelSeconds(first, v.speedMps);
        let taken = between.length > 0 ? 1 : 0;
        for (let k = 1; k < between.length; k++, taken++) {
          const seen = state.stopToStopS[between[k]!.i] ?? 0;
          seconds +=
            seen > 0
              ? seen
              : travelSeconds(between[k]!.x - between[k - 1]!.x, v.paceMps) + ADVISORY.dwellS;
        }
        if (taken > 0) return seconds;
      }
      // To the next stop at its speed now; on from there at its pace in this
      // hour's traffic (not a clear road's: a rush hour takes twice as long).
      return (
        travelSeconds(first, v.speedMps) +
        travelSeconds(d - first, v.paceMps) +
        made * ADVISORY.dwellS
      );
    },
  };
}
