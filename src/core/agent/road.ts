/**
 * What the Sakay Agent can find out about the road, for a driver or a
 * commuter: plain functions of the twin's state, so every number Muse says
 * comes from here, not from the model. The questions are the ones people ask:
 *
 *   trafficAhead      is the road ahead slow, and how slow?
 *   vehiclesAhead     are there too many ahead of me to be worth following?
 *   seatsForNextStops will my seats be enough for who is waiting?
 *   lateRiders        who will reach a stop just after I pass it?
 *   nextRides         when is the next ride, by the clock, for this commuter?
 *   leaveOrWait       at the terminal: go now, or wait for who is coming?
 *   whoIsWaiting      who is at the next stop: anyone who needs more time?
 *   handOver          pass my riders on and go back for a bigger crowd?
 *   walkOrStay        stuck on board: is walking the rest quicker?
 */

import { commuterView, type CommuterView } from '../advisory/commuter';
import type { Dispatch } from '../advisory/dispatch';
import type { DriverView } from '../advisory/driver';
import { ADVISORY, distanceTo, serves, type TwinState } from '../advisory/model';
import { discountedKind, FARE_BY_VEHICLE, fareFor, RIDER_KINDS, type RiderKind } from '../fare';
import { aheadOf } from '../geo/routes';
import { FUEL, KIND_WORD, stopsByTheRoad, type FleetKind } from '../vehicles/specs';

/** Looking this far along the road (metres). */
const TRAFFIC_LOOK_M = 1000;
/** Slower than this, a vehicle not at a stop is stuck in traffic (m/s; about 5 km/h). */
const STUCK_MPS = 1.5;
/** This many stuck ahead, or the road taking this many times as long as it should: heavy. */
const HEAVY_STUCK = 3;
const HEAVY_TIMES = 2;
const SLOW_STUCK = 1;
const SLOW_TIMES = 1.4;
/** Stops compared against how long the road should take. */
const LEGS_LOOKED_AT = 3;

const min = (s: number) => Math.round(s / 6) / 10;

export interface TrafficAhead {
  level: 'clear' | 'slow' | 'heavy';
  stuckAhead: number;
  /** Of the road to the next few stops, how many times longer than it should be taking. */
  timesLonger: number;
  extraMin: number;
  source: string;
}

export function trafficAhead(state: TwinState, vehicle: number): TrafficAhead {
  const { route, vehicles, stopToStopS } = state;
  const v = vehicles[vehicle]!;
  const stuck = vehicles.filter((o) => {
    if (o === v || o.inService === false || o.direction !== v.direction || o.atStop !== null)
      return false;
    const d = distanceTo(route, v, o.s);
    return d > 0 && d <= TRAFFIC_LOOK_M && o.speedMps < STUCK_MPS;
  }).length;

  const ahead = route.stops
    .map((st, i) => ({ i, d: distanceTo(route, v, st.s) }))
    .filter((x) => x.d > 0)
    .sort((a, b) => a.d - b.d)
    .slice(0, LEGS_LOOKED_AT);
  let seen = 0;
  let should = 0;
  ahead.forEach(({ i, d }, k) => {
    const taken = stopToStopS?.[i] ?? 0;
    if (taken <= 0) return;
    seen += taken;
    should += (d - (ahead[k - 1]?.d ?? 0)) / ADVISORY.cruiseMps + ADVISORY.dwellS;
  });
  const timesLonger = should > 0 ? seen / should : 1;
  // A stretch known to be crawling, whether or not anyone is in it yet.
  const jam = (state.slowRoad ?? []).find((z) => {
    const d = distanceTo(route, v, z.s);
    // Behind it by this much (a line route: a negative distance): still in it, if near.
    const past = route.loop ? route.polyline.length - d : -d;
    return (d >= 0 && d <= TRAFFIC_LOOK_M + z.halfM) || (past >= 0 && past <= z.halfM);
  });
  const jamS = jam ? (2 * jam.halfM) / jam.mps - (2 * jam.halfM) / ADVISORY.cruiseMps : 0;
  const level =
    jam || stuck >= HEAVY_STUCK || timesLonger >= HEAVY_TIMES
      ? 'heavy'
      : stuck >= SLOW_STUCK || timesLonger >= SLOW_TIMES
        ? 'slow'
        : 'clear';
  return {
    level,
    stuckAhead: stuck,
    timesLonger: Math.round(timesLonger * 10) / 10,
    extraMin: min(Math.max(0, seen - should, jamS)),
    source: 'the vehicles ahead and how long the road has been taking; simulated',
  };
}

export interface VehiclesAhead {
  /** On the road ahead within the driver's horizon. */
  count: number;
  plates: string[];
  freeSeatsAhead: number;
  waitingAhead: number;
  /** Waiting ahead that no one before you will take: yours to pick up. */
  leftForYou: number;
  yourFreeSeats: number;
  advice: 'hold_back' | 'pass_when_clear' | 'carry_on';
  why: string;
}

/**
 * Whether the vehicles in front leave any riders for this one. A driver
 * behind a line of half-empty jeepneys runs out of riders with seats to spare:
 * dropping back spreads the fleet out, and passing only helps when the ones
 * ahead are full and riders would otherwise be left.
 */
export function vehiclesAhead(
  state: TwinState,
  plan: Dispatch,
  view: DriverView,
  vehicle: number,
): VehiclesAhead {
  const { route, vehicles } = state;
  const v = vehicles[vehicle]!;
  const ahead = vehicles.filter((o) => {
    if (o === v || o.inService === false || o.direction !== v.direction) return false;
    const d = distanceTo(route, v, o.s);
    return d > 0 && d <= ADVISORY.horizonM;
  });
  const freeSeatsAhead = ahead.reduce((n, o) => n + Math.max(0, o.capacity - o.occupancy), 0);
  const waitingAhead = view.ahead.reduce((n, s) => n + s.waiting, 0);
  const leftForYou = view.ahead.reduce((n, s) => n + plan.claimedAt(vehicle, s.stop), 0);
  const yourFreeSeats = view.seats.free;
  const base = {
    count: ahead.length,
    plates: ahead.slice(0, 3).map((o) => o.plate),
    freeSeatsAhead,
    waitingAhead,
    leftForYou,
    yourFreeSeats,
  };
  if (ahead.length === 0)
    return { ...base, advice: 'carry_on', why: 'Nobody is in front of you within sight.' };
  if (leftForYou === 0 && yourFreeSeats > 0 && freeSeatsAhead >= waitingAhead)
    return {
      ...base,
      advice: freeSeatsAhead === 0 ? 'pass_when_clear' : 'hold_back',
      why: `${ahead.length} ahead have ${freeSeatsAhead} free seats for the ${waitingAhead} waiting, so none are left for you. Dropping back spreads the line out; passing would only race them for the same riders.`,
    };
  if (freeSeatsAhead < waitingAhead && yourFreeSeats > 0)
    return {
      ...base,
      advice: 'pass_when_clear',
      why: `Those ahead have ${freeSeatsAhead} free seats for ${waitingAhead} waiting. Where a stopped one leaves the road clear, going past reaches the riders they cannot take.`,
    };
  return { ...base, advice: 'carry_on', why: `${leftForYou} of the riders ahead are yours.` };
}

export interface SeatsAtStop {
  stop: string;
  etaMin: number;
  freeOnArrival: number;
  waiting: number;
  approaching: number;
  enough: boolean;
  short: number;
}

/** Stop by stop ahead: the seats it will have there, against who wants one. */
export function seatsForNextStops(
  plan: Dispatch,
  view: DriverView,
  vehicle: number,
): SeatsAtStop[] {
  return view.ahead.map((s) => {
    const freeOnArrival = plan.freeSeatsAt(vehicle, s.stop);
    const wanting = s.waiting + s.arrivingBeforeYou;
    return {
      stop: s.name,
      etaMin: min(s.etaS),
      freeOnArrival,
      waiting: s.waiting,
      approaching: s.arrivingBeforeYou,
      enough: wanting <= freeOnArrival,
      short: Math.max(0, wanting - freeOnArrival),
    };
  });
}

export interface LateRiders {
  stop: string;
  /** Reach the stop up to `withinMin` after this vehicle. */
  count: number;
  soonestLateMin: number | null;
  latestLateMin: number | null;
  byTricycle: number;
  note: string;
}

/**
 * The stop the vehicle stands at, if any (the view's stops ahead leave it
 * out), then the stops ahead.
 */
function hereAndAhead(
  state: TwinState,
  view: DriverView,
  vehicle: number,
): Array<{ stop: number; name: string; etaS: number }> {
  const here = state.vehicles[vehicle]!.atStop;
  if (here === null || here === undefined) return view.ahead;
  return [
    { stop: here, name: state.route.stops[here]!.name, etaS: 0 },
    ...view.ahead.filter((s) => s.stop !== here),
  ];
}

/**
 * Who will miss this vehicle by a whisker: on their way to a stop ahead, and
 * due there within `withinMin` minutes after it. Reported, never an
 * instruction to wait: that is the driver's call, with riders on board.
 */
export function lateRiders(
  state: TwinState,
  view: DriverView,
  vehicle: number,
  withinMin = 3,
): LateRiders[] {
  const v = state.vehicles[vehicle]!;
  return hereAndAhead(state, view, vehicle).map((s) => {
    const late = state.passengers
      .filter(
        (p) =>
          p.phase === 'approaching' &&
          p.originStop === s.stop &&
          serves(state.route, v, p.direction) &&
          Number.isFinite(p.arrivalInS),
      )
      .map((p) => ({ by: p.arrivalInS! - s.etaS, mode: p.approachMode }))
      .filter((p) => p.by > 0 && p.by <= withinMin * 60)
      .sort((a, b) => a.by - b.by);
    return {
      stop: s.name,
      count: late.length,
      soonestLateMin: late[0] ? min(late[0].by) : null,
      latestLateMin: late.length ? min(late[late.length - 1]!.by) : null,
      byTricycle: late.filter((p) => p.mode === 'tricycle').length,
      note: 'simulated estimates; seats are not reserved and nobody has been told to wait',
    };
  });
}

/** A rider just come is on board in about this long (seconds). */
const ON_BOARD_S = 15;
/** Due this long after the wait is up, a rider is still waited for: nobody drives off from someone a few steps away (seconds). */
const ALMOST_S = 20;

export interface WaitForRiders {
  /** The stop, its index in the route's stops. */
  stop: number;
  name: string;
  /** Riders on their way who make it within the wait. */
  riders: number;
  /** Standing at the stop for them, at most (seconds). */
  waitS: number;
  /** The longest it may wait there, being what it is (seconds). */
  mostS: number;
  /** From now until it may go (seconds): the drive there and the wait. */
  untilS: number;
  /** Still on their way, and too late even for the wait. */
  tooLate: number;
}

/**
 * The longest a vehicle waits at an ordinary stop for riders on their way, by
 * what it is (seconds): a jeepney or modern jeepney a minute or two; a bus,
 * big and holding up the lane, a minute, and later ones run for it; a UV
 * Express takes on only at its terminal. At a terminal, WAIT_LOOK_S for all.
 */
const WAIT_AT_A_STOP_BY_KIND: Record<FleetKind, number> = {
  jeepney: 120,
  modern: 120,
  bus: 60,
  uv: 0,
};

/**
 * Waiting at the next stop for the riders on their way to it: those who reach
 * it within the wait its kind allows (WAIT_AT_A_STOP_BY_KIND; WAIT_LOOK_S at
 * a terminal), and how long that holds it there. Null when nobody is coming.
 */
export function waitForRiders(
  state: TwinState,
  view: DriverView,
  vehicle: number,
): WaitForRiders | null {
  const v = state.vehicles[vehicle]!;
  const next = hereAndAhead(state, view, vehicle)[0];
  if (!next) return null;
  const most = state.route.stops[next.stop]!.terminal
    ? WAIT_LOOK_S
    : WAIT_AT_A_STOP_BY_KIND[v.kind ?? 'jeepney'];
  if (most === 0) return null;
  const coming = state.passengers
    .filter(
      (p) =>
        p.phase === 'approaching' &&
        p.originStop === next.stop &&
        serves(state.route, v, p.direction) &&
        Number.isFinite(p.arrivalInS),
    )
    .map((p) => p.arrivalInS!);
  const inTime = coming.filter((s) => s - next.etaS <= most + ALMOST_S);
  if (inTime.length === 0) return null;
  const latest = Math.max(...inTime);
  const untilS = Math.min(next.etaS + most + ALMOST_S, latest + ON_BOARD_S);
  return {
    stop: next.stop,
    name: next.name,
    riders: inTime.length,
    waitS: Math.round(Math.max(0, untilS - next.etaS)),
    mostS: most,
    untilS: Math.round(untilS),
    tooLate: coming.length - inTime.length,
  };
}

/**
 * Worth waiting for riders due within this long (seconds): at a terminal, in
 * its line off the road; at an ordinary stop, pulled in at the kerb, a minute
 * or two, as drivers do; more than that holds up the road.
 */
const WAIT_LOOK_S = 300;
const WAIT_AT_A_STOP_S = 120;
/**
 * A minute on the road earns about this: ₱3,000 of fares over nine hours,
 * what a wait at the terminal gives up. An assumption to replace with a
 * driver's own days.
 */
const ROAD_PHP_PER_MIN = 5.5;
/** A typical ride, for what riders still to come will pay (km): trips are about 5 km. */
const TYPICAL_RIDE_KM = 5;
const peso = (php: number) => Math.round(php * 100) / 100;

export interface LeaveOrWait {
  /** At a stop: the only place to wait for riders, by the kerb. */
  atStop: boolean;
  atTerminal: boolean;
  why?: string;
  stop?: string;
  /** Waiting longer than this holds up the road (minutes). */
  waitAtMostMin?: number;
  onBoard?: number;
  freeSeats?: number;
  waitingNow?: number;
  /** On their way here, due within WAIT_LOOK_S. */
  coming?: number;
  /** Of those, how many will fit. */
  worthWaitingFor?: number;
  waitMin?: number;
  extraFaresPhp?: number;
  /** What the wait costs: time off the road, and diesel standing. */
  waitCostPhp?: number;
  /** The vehicles in line behind, who take whoever this one leaves. */
  linedUpBehind?: number;
  advice?: 'wait' | 'leave';
  assumption?: string;
}

/**
 * At a terminal, whether the fares of who is on their way are worth the
 * minutes of waiting for them. The driver's call: this is the sum, in pesos.
 */
export function leaveOrWait(state: TwinState, view: DriverView, vehicle: number): LeaveOrWait {
  const { route, vehicles, passengers } = state;
  const v = vehicles[vehicle]!;
  const next = view.ahead[0];
  const here = v.atStop ?? (next && next.distanceM <= 60 ? next.stop : null);
  if (here === null)
    return {
      atStop: false,
      atTerminal: false,
      why: 'Not at a stop: waiting in the road between stops holds up the traffic behind.',
    };
  const terminal = route.stops[here]!.terminal === true;
  const lookS = terminal ? WAIT_LOOK_S : WAIT_AT_A_STOP_S;
  const free = Math.max(0, v.capacity - v.occupancy);
  const waitingNow = passengers.filter(
    (p) => p.phase === 'waiting' && p.originStop === here,
  ).length;
  const coming = passengers
    .filter(
      (p) =>
        p.phase === 'approaching' && p.originStop === here && (p.arrivalInS ?? Infinity) <= lookS,
    )
    .map((p) => p.arrivalInS!)
    .sort((a, b) => a - b);
  const room = Math.max(0, free - waitingNow);
  const worth = Math.min(room, coming.length);
  const waitS = worth > 0 ? coming[worth - 1]! : 0;
  const rule = FARE_BY_VEHICLE[v.kind ?? 'jeepney'];
  const extraFaresPhp = peso(worth * fareFor(TYPICAL_RIDE_KM, false, rule));
  // Its own kind's idling: a bus burns two and a half times a jeepney's an hour.
  const standing =
    (waitS / 3600) * FUEL[v.kind ?? 'jeepney'].idleLPerH * ADVISORY.fuel.dieselPhpPerL;
  const waitCostPhp = peso((waitS / 60) * ROAD_PHP_PER_MIN + standing);
  const linedUpBehind = vehicles.filter((o) => {
    if (o === v || o.inService === false || o.direction !== v.direction) return false;
    const d = distanceTo(route, o, route.stops[here]!.s);
    return d >= 0 && d <= ADVISORY.horizonM / 3;
  }).length;
  return {
    atStop: true,
    atTerminal: terminal,
    stop: route.stops[here]!.name,
    waitAtMostMin: lookS / 60,
    onBoard: v.occupancy,
    freeSeats: free,
    waitingNow,
    coming: coming.length,
    worthWaitingFor: worth,
    waitMin: min(waitS),
    extraFaresPhp,
    waitCostPhp,
    linedUpBehind,
    advice: worth > 0 && extraFaresPhp > waitCostPhp ? 'wait' : 'leave',
    assumption: `a ride of ${TYPICAL_RIDE_KM} km each, and ₱${ROAD_PHP_PER_MIN} a minute earned on the road`,
  };
}

export interface WhoIsWaiting {
  stop: string;
  metresAhead: number;
  total: number;
  /** How many of each kind, the kinds with anyone. */
  byKind: Partial<Record<RiderKind, number>>;
  /** Seniors, persons with disability and the pregnant: slower to get on, and first to a seat. */
  needTimeToBoard: number;
  /** On a jeepney's benches, riders move along to make them room (on a bus, its priority seats). */
  askRidersToMakeRoom: boolean;
  /** Paying the 20% discount. */
  discounted: number;
  source: string;
}

/** Riders who need a seat with room, and time to get on. */
const NEED_ROOM: readonly string[] = ['senior', 'pwd', 'pregnant'];
/** On a jeepney's bench, a place to sit in comfort is this many of its places. */
const ROOMY_PLACES = 2;

/** Who is at the next stop, as far as the app knows them. */
export function whoIsWaiting(
  state: TwinState,
  view: DriverView,
  vehicle: number,
): WhoIsWaiting | null {
  const next = view.ahead[0];
  if (!next) return null;
  const here = state.passengers.filter((p) => p.phase === 'waiting' && p.originStop === next.stop);
  const byKind: Partial<Record<RiderKind, number>> = {};
  for (const kind of RIDER_KINDS) {
    const n = here.filter((p) => (p.kind ?? 'regular') === kind).length;
    if (n > 0) byKind[kind] = n;
  }
  return {
    stop: next.name,
    metresAhead: Math.round(next.distanceM),
    total: here.length,
    byKind,
    needTimeToBoard: here.filter((p) => NEED_ROOM.includes(p.kind ?? '')).length,
    askRidersToMakeRoom:
      stopsByTheRoad(state.vehicles[vehicle]!.kind ?? 'jeepney') &&
      here.some((p) => NEED_ROOM.includes(p.kind ?? '')),
    discounted: here.filter((p) => discountedKind(p.kind ?? 'regular')).length,
    source: 'simulated; a real app knows only riders who told it',
  };
}

/** A vehicle behind within this takes riders passed on to it (metres). */
const HAND_OVER_BEHIND_M = 1000;
/** A crowd across the road: this close as the crow flies, and this far on by the route (metres). */
const ACROSS_ROAD_M = 900;
const FAR_ROUND_M = 3000;
/** Not worth turning back for fewer than this. */
const CROWD_AT_LEAST = 5;

export interface HandOver {
  possible: boolean;
  why?: string;
  riders?: number;
  /** The vehicle behind that can take them. */
  nextVehicle?: { plate: string; metresBehind: number; freeSeats: number };
  /** What those riders pay for the whole of their rides. */
  ridersPayPhp?: number;
  /** What the rest of their rides is worth, to the driver who finishes them. */
  payNextDriverPhp?: number;
  youKeepPhp?: number;
  /** The crowd across the road, otherwise reached only by going round. */
  /** `at` is the stop's index in the route's stops. */
  crowd?: { stop: string; at: number; waiting: number; youCanTake: number; faresPhp: number };
  /** Reaching them the long way, by the route, if the driver does not turn back. */
  ifNotTurningBack?: { km: number; minutes: number };
  /** Fares there, less what the next driver is paid. */
  gainPhp?: number;
  note?: string;
}

/**
 * The sum behind passing riders on to the jeepney behind and going back for a
 * crowd: what the next driver is owed by distance, against the fares waiting.
 * Jeepneys only: a bus or a UV Express carries too many, on a fixed run.
 */
export function handOver(state: TwinState, vehicle: number): HandOver {
  const { route, vehicles, passengers } = state;
  const v = vehicles[vehicle]!;
  const kind = v.kind ?? 'jeepney';
  if (!stopsByTheRoad(kind))
    return {
      possible: false,
      why: `A ${KIND_WORD[kind]} carries its riders to the end of its run.`,
    };
  const aboard = passengers.filter((p) => p.vehicle === vehicle && p.phase === 'seated');
  if (aboard.length === 0) return { possible: false, why: 'Nobody is on board to pass on.' };
  const next = vehicles
    .filter((o) => o !== v && o.inService !== false && o.direction === v.direction)
    .map((o) => ({ o, d: distanceTo(route, o, v.s) }))
    .filter(({ d }) => d > 0 && d <= HAND_OVER_BEHIND_M)
    .sort((a, b) => a.d - b.d)
    .find(({ o }) => o.capacity - o.occupancy >= aboard.length);
  if (!next)
    return { possible: false, why: `No jeepney close behind has ${aboard.length} free seats.` };
  const rule = FARE_BY_VEHICLE[kind];
  const fare = (m: number) => fareFor(m / 1000, false, rule);
  const ride = (from: number, to: number) => aheadOf(route, from, to);
  const ridersPayPhp = aboard.reduce(
    (sum, p) => sum + fare(ride(route.stops[p.originStop]!.s, route.stops[p.destinationStop]!.s)),
    0,
  );
  const payNextDriverPhp = aboard.reduce(
    (sum, p) => sum + fare(ride(v.s, route.stops[p.destinationStop]!.s)),
    0,
  );
  const crowd = route.stops
    .map((st, i) => {
      const at = route.polyline.pointAt(st.s);
      return {
        st,
        at: i,
        waiting: passengers.filter((p) => p.phase === 'waiting' && p.originStop === i).length,
        across: Math.hypot(at.x - v.x, at.z - v.z),
        roundM: ride(v.s, st.s),
      };
    })
    .filter(
      (c) => c.across <= ACROSS_ROAD_M && c.roundM >= FAR_ROUND_M && c.waiting >= CROWD_AT_LEAST,
    )
    .sort((a, b) => b.waiting - a.waiting)[0];
  if (!crowd) return { possible: false, why: 'No crowd across the road worth turning back for.' };
  const youCanTake = Math.min(crowd.waiting, v.capacity);
  const faresPhp = peso(youCanTake * fareFor(TYPICAL_RIDE_KM, false, rule));
  return {
    possible: true,
    riders: aboard.length,
    nextVehicle: {
      plate: next.o.plate,
      metresBehind: Math.round(next.d),
      freeSeats: next.o.capacity - next.o.occupancy,
    },
    ridersPayPhp: peso(ridersPayPhp),
    payNextDriverPhp: peso(payNextDriverPhp),
    youKeepPhp: peso(ridersPayPhp - payNextDriverPhp),
    crowd: { stop: crowd.st.name, at: crowd.at, waiting: crowd.waiting, youCanTake, faresPhp },
    ifNotTurningBack: {
      km: Math.round(crowd.roundM / 100) / 10,
      minutes: Math.round(crowd.roundM / (v.paceMps ?? ADVISORY.cruiseMps) / 60),
    },
    gainPhp: peso(faresPhp - payNextDriverPhp),
    note: 'Only if the riders agree, at no extra fare. Check with the operator or LTFRB first: leaving a trip unfinished can count as trip cutting.',
  };
}

const WALK_MPS = 1.3;
/** Walking has to save this much to be worth getting down (seconds). */
const WALK_SAVES_S = 60;

export interface WalkOrStay {
  onBoard: boolean;
  metresLeft?: number;
  rideMin?: number;
  walkMin?: number;
  /** Riding is held up by traffic on what is left. */
  inTraffic?: boolean;
  advice?: 'walk' | 'stay';
  note?: string;
}

/** On board and stuck: how the rest compares on foot. */
export function walkOrStay(state: TwinState, view: CommuterView): WalkOrStay {
  const riding = view.riding;
  if (!riding) return { onBoard: false };
  const { route } = state;
  const v = state.vehicles[riding.vehicle]!;
  const left = riding.remainingM;
  const pace = v.paceMps ?? ADVISORY.cruiseMps;
  // Traffic on the road left to ride: how much of it, at its speed instead of the usual pace.
  const heldS = (state.slowRoad ?? []).reduce((most, z) => {
    const from = distanceTo(route, v, z.s) - z.halfM;
    const inIt = Math.min(left, from + 2 * z.halfM) - Math.max(0, from);
    return Math.max(most, inIt > 0 ? inIt / z.mps - inIt / pace : 0);
  }, 0);
  const rideS = riding.etaS + heldS;
  const walkS = left / WALK_MPS;
  return {
    onBoard: true,
    metresLeft: Math.round(left),
    rideMin: min(rideS),
    walkMin: min(walkS),
    inTraffic: heldS > 0,
    advice: walkS + WALK_SAVES_S < rideS ? 'walk' : 'stay',
    note: 'Say "para" at a safe place by the kerb, never in the middle of the road.',
  };
}

/** The clock time `etaS` from now, as people say it: "7:42 AM". */
export function clockTime(clockS: number, etaS: number): string {
  const t = (clockS + etaS) % 86_400;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export interface NextRide {
  plate: string;
  vehicle: string;
  etaMin: number;
  atClock: string;
  freeSeats: number;
  seatsForYou: number;
  canBoard: boolean;
  /** For someone who needs room (pregnant, PWD, senior): space to sit in comfort, not a squeeze. */
  roomy?: boolean;
}

/** The next rides to `stop`, by the clock, after the queue ahead of this commuter. */
export function nextRides(
  state: TwinState,
  plan: Dispatch,
  stop: number,
  destination: number,
  clockS: number,
  /** Who is asking, when they are in the twin: nobody counts themselves in the queue. */
  rider?: number,
): { stop: string; queueAhead: number; rides: NextRide[]; yours: string | null } {
  const view = commuterView(
    state,
    plan,
    rider === undefined ? { stop, destination } : { passenger: rider },
  );
  const asking = state.passengers.find((p) => p.id === rider);
  const needsRoom = NEED_ROOM.includes(asking?.kind ?? '');
  return {
    stop: view.stop.name,
    queueAhead: view.queueAhead,
    rides: view.arrivals.map((a) => ({
      plate: a.plate,
      vehicle: KIND_WORD[a.kind],
      etaMin: min(a.etaS),
      atClock: clockTime(clockS, a.etaS),
      freeSeats: a.freeSeats,
      seatsForYou: a.seatsForYou,
      canBoard: a.catchable && a.seatsForYou > 0,
      ...(needsRoom && {
        roomy: a.catchable && a.seatsForYou >= (a.kind === 'bus' ? 1 : ROOMY_PLACES),
      }),
    })),
    yours: view.pickup?.plate ?? null,
  };
}
