/**
 * The driver's app: only what is in front of the jeepney.
 *
 *   ahead      the next stops, up to ADVISORY.horizonM or horizonStops
 *              (always at least the next one): who waits there, who is
 *              getting off, and whether this jeepney should stop or pass
 *   leader     the jeepney directly in front, which gets first pick
 *   eyesight   anyone within ADVISORY.eyesightM of the jeepney, even just
 *              behind it: someone running for it can still flag it down.
 *              Further back, they are gone from the driver's screen.
 *   fuel       to the next terminal: this plan versus stopping everywhere
 *
 * Nothing behind the jeepney beyond eyesight, and no jeepneys behind it.
 */

import { isTerminal } from '../geo/routes';
import { stopsByTheRoad, type FleetKind } from '../vehicles/specs';
import type { Dispatch } from './dispatch';
import { incomingAtStop, type IncomingPassenger } from './approach';
import {
  ADVISORY,
  carries,
  distanceTo,
  litresPerKm,
  serves,
  type PassengerState,
  type TwinState,
  type VehicleState,
} from './model';

export interface StopAhead {
  stop: number;
  name: string;
  /** On a loop: the terminal this stop's riders head to. */
  towards?: string;
  distanceM: number;
  etaS: number;
  /** Everyone queuing there in this jeepney's direction. */
  waiting: number;
  /** People still travelling to this stop, within 500 m; no seats reserved. */
  incoming: IncomingPassenger[];
  /** Expected to reach the stop before this jeepney, subject to traffic. */
  arrivingBeforeYou: number;
  /** Of those, how many this jeepney picks up. */
  forYou: number;
  /** Jeepneys ahead that already take some of the queue. */
  coveredBy: Array<{ plate: string; count: number }>;
  /** Riders getting off here. */
  dropOffs: number;
  /** A rider is calling "para" for this stop right now. */
  para: boolean;
  action: 'stop' | 'pass';
  reason: string;
}

export interface DriverView {
  plate: string;
  kind: FleetKind;
  seats: { onBoard: number; capacity: number; free: number };
  ahead: StopAhead[];
  /** People waiting by the road ahead, not at a stop, nearest first: wave and they board. */
  roadside: Array<{ passenger: number; distanceM: number; etaS: number; canTake: boolean }>;
  leader: { plate: string; distanceM: number; freeSeats: number } | null;
  eyesight: Array<{ passenger: number; distanceM: number; behind: boolean; phase: string }>;
  fuel: {
    km: number;
    stopsPlanned: number;
    stopsAll: number;
    litres: number;
    litresStopEverywhere: number;
    savedLitres: number;
    savedPhp: number;
  };
}

/** Stops in front of `v` in driving order, with how far each is. */
function stopsInFront(state: TwinState, v: VehicleState) {
  return state.route.stops
    .map((st, stop) => ({ stop, st, d: distanceTo(state.route, v, st.s) }))
    .filter((x) => x.d >= 0 && x.stop !== v.atStop)
    .sort((a, b) => a.d - b.d);
}

export function driverView(state: TwinState, vehicle: number, plan: Dispatch): DriverView {
  const { route, vehicles, passengers } = state;
  const v = vehicles[vehicle]!;
  const onBoard = passengers.filter((p) => p.vehicle === vehicle && p.phase !== 'alighting');
  const front = stopsInFront(state, v);

  // Everything up to the next terminal: the horizon is the first part of it.
  const toTerminal: typeof front = [];
  for (const x of front) {
    toTerminal.push(x);
    if (isTerminal(route, x.stop)) break;
  }

  const queueAt = (stop: number) =>
    passengers.filter(
      (p) =>
        p.phase === 'waiting' &&
        p.flagS === undefined &&
        p.originStop === stop &&
        serves(route, v, p.direction),
    ).length;
  const byTheRoad = new Set(passengers.filter((p) => p.flagS !== undefined).map((p) => p.id));

  const decisions = toTerminal.map(({ stop, st, d }, i): StopAhead => {
    const waiting = queueAt(stop);
    const incoming = incomingAtStop(state, stop, v.direction).filter(
      (p) => !byTheRoad.has(p.passenger),
    );
    const etaS = plan.etaS(vehicle, stop);
    const forYou = plan.claimedAt(vehicle, stop);
    const dropOffs = onBoard.filter((p) => p.destinationStop === stop).length;
    const coveredBy = plan.claims
      .filter((c) => c.stop === stop && c.vehicle !== vehicle && c.distanceM < d)
      .map((c) => ({ plate: vehicles[c.vehicle]!.plate, count: c.passengers.length }));
    const terminal = isTerminal(route, stop);
    const action = terminal || dropOffs > 0 || forYou > 0 ? 'stop' : 'pass';
    const reason = terminal
      ? 'Terminal: everyone gets off'
      : dropOffs > 0 && forYou > 0
        ? `${dropOffs} off, ${forYou} on`
        : dropOffs > 0
          ? `${dropOffs} getting off`
          : forYou > 0
            ? `${forYou} waiting for you`
            : coveredBy.length > 0
              ? `Covered by ${coveredBy.map((c) => c.plate).join(', ')} ahead`
              : waiting > 0
                ? 'No free seats'
                : 'No one waiting or getting off';

    return {
      stop,
      name: st.name,
      towards: st.towards,
      distanceM: d,
      etaS,
      waiting,
      incoming,
      arrivingBeforeYou: incoming.filter((p) => p.etaS <= etaS).length,
      forYou,
      coveredBy,
      dropOffs,
      para: i === 0 && dropOffs > 0 && d <= ADVISORY.paraM,
      action,
      reason,
    };
  });

  const ahead = decisions.filter(
    (x, i) => i === 0 || (i < ADVISORY.horizonStops && x.distanceM <= ADVISORY.horizonM),
  );

  const roadside = passengers
    .filter(
      (p) =>
        p.flagS !== undefined &&
        p.phase === 'waiting' &&
        stopsByTheRoad(v.kind ?? 'jeepney') &&
        serves(route, v, p.direction) &&
        carries(route, v, p.originStop, p.destinationStop),
    )
    .map((p) => ({ p, d: distanceTo(route, v, p.flagS!) }))
    .filter(
      ({ p, d }) =>
        d >= 0 && d <= ADVISORY.horizonM && d <= distanceTo(route, v, route.stops[p.originStop]!.s),
    )
    .sort((a, b) => a.d - b.d)
    .map(({ p, d }) => ({
      passenger: p.id,
      distanceM: d,
      etaS: d / Math.max(v.paceMps ?? 0, 1),
      canTake: onBoard.length < v.capacity,
    }));

  // The jeepney directly in front, going the same way, within sight: on a
  // loop the one right behind is "ahead" by almost a lap, which is not ahead.
  const sight = Math.min(ADVISORY.horizonM, toTerminal[toTerminal.length - 1]?.d ?? 0);
  let leader: DriverView['leader'] = null;
  for (const o of vehicles) {
    if (o.index === vehicle || o.direction !== v.direction || o.inService === false) continue;
    const d = distanceTo(route, v, o.s);
    if (d > 0 && d <= sight && (!leader || d < leader.distanceM))
      leader = { plate: o.plate, distanceM: d, freeSeats: Math.max(0, o.capacity - o.occupancy) };
  }

  // Within eyesight: not on a jeepney, near enough to be seen and to wave it down.
  const forward = { x: Math.cos(v.heading), z: -Math.sin(v.heading) };
  const eyesight = passengers
    .filter(
      (p: PassengerState) =>
        p.vehicle === null &&
        (p.phase === 'approaching' || p.phase === 'waiting') &&
        serves(route, v, p.direction),
    )
    .map((p) => {
      const dx = p.x - v.x;
      const dz = p.z - v.z;
      return {
        passenger: p.id,
        distanceM: Math.hypot(dx, dz),
        behind: dx * forward.x + dz * forward.z < 0,
        phase: p.phase,
      };
    })
    .filter((x) => x.distanceM <= ADVISORY.eyesightM)
    .sort((a, b) => a.distanceM - b.distanceM);

  // Fuel to the next terminal: driving plus one stop-and-go per stop made.
  const f = ADVISORY.fuel;
  const km = (toTerminal[toTerminal.length - 1]?.d ?? 0) / 1000;
  const cruise = km * litresPerKm(v.kind, v.occupancy);
  const stopsPlanned = decisions.filter((x) => x.action === 'stop').length;
  const stopsAll = decisions.length;
  const litres = cruise + stopsPlanned * f.stopGoL;
  const litresStopEverywhere = cruise + stopsAll * f.stopGoL;
  const savedLitres = litresStopEverywhere - litres;

  return {
    plate: v.plate,
    kind: v.kind ?? 'jeepney',
    seats: {
      onBoard: v.occupancy,
      capacity: v.capacity,
      free: Math.max(0, v.capacity - v.occupancy),
    },
    ahead,
    roadside,
    leader,
    eyesight,
    fuel: {
      km,
      stopsPlanned,
      stopsAll,
      litres,
      litresStopEverywhere,
      savedLitres,
      savedPhp: savedLitres * f.dieselPhpPerL,
    },
  };
}

/** A live, deterministic heads-up; approaching riders are never an instruction to wait. */
export function arrivalHeadsUp(stop: StopAhead): string {
  const first = stop.incoming[0];
  if (!first)
    return `${stop.name}: ${stop.waiting} waiting now; no approaching commuters reported within 500 m.`;
  const tricycle = stop.incoming.filter((p) => p.mode === 'tricycle').length;
  const walking = stop.incoming.length - tricycle;
  const modes = [walking ? `${walking} walking` : '', tricycle ? `${tricycle} by tricycle` : '']
    .filter(Boolean)
    .join(', ');
  const timing =
    stop.arrivingBeforeYou > 0
      ? `${stop.arrivingBeforeYou} may reach the stop before you.`
      : 'You are expected to reach the stop first.';
  return `${stop.name}: ${stop.waiting} waiting now, ${stop.incoming.length} approaching (${modes}). Nearest arrival in about ${Math.max(1, Math.ceil(first.etaS / 60))} min, ${Math.round(first.distanceM)} m from the stop. ${timing} Recheck on arrival; seats are not reserved.`;
}
