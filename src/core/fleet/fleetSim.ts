/**
 * The simulated part of the hybrid twin: other jeepneys on the same route,
 * riders appearing at stops, boarding and alighting.
 *
 * Deliberately simple and deterministic (seeded). It is a backdrop that makes
 * the one GPS-driven jeepney meaningful, not a traffic model. Anything that
 * claims accuracy (counts, ETAs) has to be validated against field data first.
 */

import { BAY_APART_M, type Forecourt } from '../fuel/stations';
import { FUEL, homeLane, VEHICLES, type FleetKind } from '../vehicles/specs';
import { stopRoles } from '../vehicles/stops';
import { passesNear } from '../geo/near';
import type { Polyline } from '../geo/polyline';
import { bendSpeed } from '../geo/driveLine';
import { aheadOf, isTerminal, laneRoomAt, stopsAhead, type Route } from '../geo/routes';
import { LANE_M } from '../map/style';
import { createRng, poisson, type Rng } from '../math/random';
import { trafficShare } from '../network/flow';
import {
  DAY_ENDS_S,
  expectedArrivals,
  HOME_FROM_S,
  HOME_TO_S,
  LAST_RIDERS_S,
  SERVICE_FROM_S,
  TERMINAL_KEPT_SHARE,
  type SimulationScenario,
} from './scenario';

export type Livery = 'red' | 'yellow' | 'green';
/**
 * Out for the day; on the last trip (on to the next terminal, still taking
 * riders on the way, as they all ride to it at most); driving back from
 * there, empty, not stopping, to where it is kept along the route (an
 * owner's home, an operator's garage); or parked for the night, there or
 * at the terminal.
 */
export type Duty = 'service' | 'homebound' | 'returning' | 'parked';

/** One closed day of the fleet's ledger: each jeepney's totals, by index. */
export interface DayRecord {
  /** 1 for the day the simulation started. */
  day: number;
  totals: DayTotals[];
}

export interface FleetVehicle {
  id: number;
  plate: string;
  livery: Livery;
  /** A traditional jeepney, or one of the few modern jeepneys, UV Express vans and buses. */
  kind: FleetKind;
  /** Along-route distance, metres. */
  s: number;
  direction: 1 | -1;
  cruiseMps: number;
  speedMps: number;
  /** Seconds left at the current stop. */
  dwellS: number;
  /** Everyone it can carry, packed: the seats, then standing or hanging on. */
  capacity: number;
  /** Of those, how many sit: what a driver at the terminal fills up to. */
  seats: number;
  /** True number of riders (the simulation knows; sensors would estimate). */
  occupancy: number;
  /** Index of the next stop in the direction of travel. */
  nextStop: number;
  /** Stop being served; cleared only when passenger movements are finished. */
  currentStop: number | null;
  /**
   * Metres moved over from its lane towards the middle of the road, while
   * overtaking (0 otherwise).
   */
  laneShiftM: number;
  /**
   * Metres over from the kerb lane to the lane it cruises in: its own lane
   * across a wide road, and back to the kerb to stop.
   */
  cruiseLaneM: number;
  /**
   * Which way its nose points across the road: metres towards the middle per
   * metre forward. It eases into however the vehicle moves across, and only
   * as it rolls (standing, it keeps pointing where it was).
   */
  noseAcross: number;
  /** Where it was across the road last tick (metres in from the kerb lane). */
  wasAcrossM: number;
  /**
   * The driver, 0–1: how readily they overtake a slower jeepney. Most
   * drivers sit behind; a few are out the moment they are held up.
   */
  boldness: number;
  /** Today's running totals: what the driver's earnings are worked out from. */
  day: DayTotals;
  duty: Duty;
  /**
   * Where it is kept overnight, metres along the route. An owner-driver's
   * home, or the operator's garage of a boundary driver who collects it
   * there: just off the road, away from the terminals; it pulls out there in
   * the morning and drives back there at night. Or a terminal (see depot).
   */
  garageS: number;
  /** The driver owns the jeepney: no boundary to pay, their own upkeep instead. */
  owner: boolean;
  /**
   * The terminal (route.stops index) where the operator keeps it, for a
   * boundary driver who collects it there; null when kept along the route.
   */
  depot: number | null;
  /** Diesel in the tank (litres): it pulls in at a station on the way when low. */
  tankL: number;
  /** Its tank, full (litres): not every jeepney's is the same. */
  tankCapacityL: number;
  /** Knocking off tonight, its driver fills up on the way home (decided each night). */
  topUpTonight: boolean;
  /** The station it is going to fill up at (`s`: where it turns in), or is in now. */
  refuel: { s: number; name: string; at: FuelStopAt } | null;
  /** Litres to buy there (a plan Muse made); a full tank when not given. */
  refuelLitres?: number | null;
  /** Seconds of filling up left (0 when not at a pump). */
  refuelLeftS: number;
  /** Turned in at a station, off the road: where it is in the forecourt (null on the road). */
  yard: FuelYard | null;
  /** A way off the route it is taking, or about to. */
  detour?: Detour | null;
}

/** Off the route for a while, along a way of its own (a shortcut the driver took). */
export interface Detour {
  line: Polyline;
  /** Along the route: where it comes off, and where it is back on. */
  enterS: number;
  exitS: number;
  /** On the way now, this far along it (metres); until then, driving up to enterS. */
  on: boolean;
  atM: number;
  /** How far in from the kerb lane it was as it came off (metres): eased away. */
  fromAcross: number;
}

/** A jeepney in a station's forecourt. */
export interface FuelYard {
  stop: FuelStopAt;
  /** Its lane of pumps (0 nearest the road). */
  bay: number;
  /** Metres into the forecourt, from where it turned in. */
  u: number;
  /** Cars at its pump before it (one at the pump, one waiting), and seconds left for the one at it. */
  cars: number;
  carLeftS: number;
  /** In line before it for the pump: cars and jeepneys. */
  ahead: number;
  /** Filled up: on its way out. */
  full: boolean;
}

/** Jeepney `id`'s share (0-1) of the TANK_MIN_L to TANK_MAX_L range, fixed by `seed`. */
function tankShare(seed: number, id: number): number {
  let h = Math.imul(seed ^ 0x74616e6b, 0x85ebca6b) ^ Math.imul(id + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 12)) >>> 0) / 4_294_967_296;
}

/**
 * A fuel station a jeepney can pull in at: along-route position, name, side
 * of the road, and its way through the forecourt (see forecourtAlong).
 */
export interface FuelStopAt extends Forecourt {
  s: number;
  name: string;
  /** For a jeepney driving towards higher s; jeepneys keep right. */
  side: 'left' | 'right';
}

/** Where the pumps are, metres into `stop`'s forecourt: on its straight, short of the turn out. */
export function pumpAt(stop: Forecourt, kind: FleetKind = 'jeepney', bay = 0): number {
  const turn = yardTurn(stop, kind, bay);
  const beforeTurnOut = stop.lengthM - turn - 4;
  // Several lanes of pumps: the turn into a further one is over a gap before them.
  return baysOf(stop) > 1 ? Math.min(turn + YARD_GAP_M, beforeTurnOut) : beforeTurnOut;
}

/**
 * Lanes of pumps a jeepney can use: more than one only on a forecourt long
 * enough for the turns in and out (where a jeepney crosses the other lanes)
 * to be a gap clear of the pumps.
 */
export function baysOf(stop: Forecourt): number {
  return stop.lengthM >= 2 * (YARD_TURN_M + YARD_GAP_M) ? stop.bays : 1;
}

/**
 * A way off the road into a lane of pumps `depth` metres over: an S of two
 * arcs of radius `r`, each turning `angle`, with a straight between them.
 * `arcM` is the road each arc takes, `along` the whole S's.
 */
interface Swerve {
  depth: number;
  r: number;
  angle: number;
  arcM: number;
  along: number;
}

function swerveOf(depth: number, r: number, most: number): Swerve {
  if (depth <= 0.01) return { depth: 0, r, angle: 0, arcM: 0, along: 0 };
  const angle = Math.min(most, Math.acos(Math.max(-1, 1 - depth / (2 * r))));
  const straight = Math.max(0, (depth - 2 * r * (1 - Math.cos(angle))) / Math.sin(angle));
  const arcM = r * Math.sin(angle);
  return { depth, r, angle, arcM, along: 2 * arcM + straight * Math.cos(angle) };
}

const swerves = new WeakMap<Forecourt, Map<string, Swerve>>();

/**
 * How `kind` turns into lane of pumps `bay` and back out: never tighter
 * than it can steer (yardRadius), at YARD_ANGLE, steeper only where the
 * forecourt is too short for that and still leaves its own length along the
 * pumps, and only then tighter.
 */
function swerve(stop: Forecourt, kind: FleetKind, bay: number): Swerve {
  let byKind = swerves.get(stop);
  if (!byKind) swerves.set(stop, (byKind = new Map()));
  const key = `${kind}:${bay}`;
  const known = byKind.get(key);
  if (known) return known;
  const depth = stop.depthM + bay * BAY_APART_M;
  const room = (stop.lengthM - lengthOf(kind)) / 2;
  let best = swerveOf(depth, YARD_RADIUS_MIN_M, YARD_STEEPEST);
  search: for (let r = yardRadius(kind); r >= YARD_RADIUS_MIN_M; r *= 0.9) {
    for (let a = YARD_ANGLE; a <= YARD_STEEPEST + 1e-9; a += YARD_STEEPEST_STEP) {
      const c = swerveOf(depth, r, a);
      if (c.along <= room) {
        best = c;
        break search;
      }
    }
  }
  byKind.set(key, best);
  return best;
}

/** How far off the road an S is `x` metres along its road, and its angle to the road there. */
function onSwerve(c: Swerve, x: number): { across: number; angle: number } {
  if (x <= 0 || c.along === 0) return { across: 0, angle: 0 };
  if (x >= c.along) return { across: c.depth, angle: 0 };
  const arc = (w: number) => c.r - Math.sqrt(c.r * c.r - w * w);
  if (x < c.arcM) return { across: arc(x), angle: Math.asin(x / c.r) };
  const w = c.along - x;
  if (w < c.arcM) return { across: c.depth - arc(w), angle: Math.asin(w / c.r) };
  return {
    across: c.r * (1 - Math.cos(c.angle)) + (x - c.arcM) * Math.tan(c.angle),
    angle: c.angle,
  };
}

/** The turn in (and out) of `kind` into lane of pumps `bay` takes this much road, metres. */
function yardTurn(stop: Forecourt, kind: FleetKind = 'jeepney', bay = 0): number {
  return swerve(stop, kind, bay).along;
}

/** Into the forecourt `u` metres in (positive), back out (negative), or along the pumps. */
function yardWay(stop: Forecourt, bay: number, u: number, kind: FleetKind) {
  const c = swerve(stop, kind, bay);
  if (u <= stop.lengthM / 2) return onSwerve(c, u);
  const out = onSwerve(c, stop.lengthM - u);
  out.angle = -out.angle;
  return out;
}

/**
 * Metres off the lane `u` metres into `stop`'s forecourt, in pump lane
 * `bay`: turning off the road, along the pumps, and back onto it, on a way
 * `kind` can steer (swerve).
 */
export function yardShift(
  stop: Forecourt,
  bay: number,
  u: number,
  kind: FleetKind = 'jeepney',
): number {
  return yardWay(stop, bay, u, kind).across;
}

/**
 * Radians `kind` is turned off the road `u` metres into `stop`'s forecourt:
 * towards the pumps turning in, back to the road turning out. Its nose
 * always points along its way, so it never slides sideways.
 */
export function yardAngle(
  stop: Forecourt,
  bay: number,
  u: number,
  kind: FleetKind = 'jeepney',
): number {
  return yardWay(stop, bay, u, kind).angle;
}

/** A jeepney's running totals since the day started. */
export interface DayTotals {
  /** Metres driven. */
  metres: number;
  /** Seconds standing with the engine on (at stops, at terminals, in queues). */
  idleS: number;
  /** Fares collected, centavos (paid as riders get off). */
  fareCentavos: number;
  riders: number;
  /** Driven by its owner that day (no boundary; their own upkeep). */
  owner: boolean;
  /** Diesel: in the tank when the day began, burnt, bought, and how many times. */
  tankStartL: number;
  fuelUsedL: number;
  fuelBoughtL: number;
  refuels: number;
  /** In the tank when the day closed (set as it closes). */
  tankEndL?: number;
}

export interface PassengerService {
  demand(stop: number, count: number): void;
  /** Serve `stop`; `dropOffOnly` when stuck in a queue short of it (riders get off and walk). */
  arrive(vehicle: FleetVehicle, stop: number, dropOffOnly?: boolean): void;
  /** Waiting on at `stop` after serving it: take on whoever has come since (nobody gets off). */
  pickUp(vehicle: FleetVehicle, stop: number): void;
  /** The day is over: anyone still waiting goes home some other way. */
  endOfDay?(): void;
  busy(vehicle: number): boolean;
  /** Whether anyone gets off at `stop`, or anyone there can get on (or it is a terminal). */
  wantsStop(vehicle: FleetVehicle, stop: number): boolean;
  /** Whether anyone on board gets off at `stop`. */
  dropsAt(vehicle: FleetVehicle, stop: number): boolean;
  /** How many are still on their way to `stop` to get on `vehicle` (due within `withinS`, if given). */
  comingTo?(vehicle: FleetVehicle, stop: number, withinS?: number): number;
  /** Where along the route someone by the road, ahead of `vehicle`, waits for it; null if nobody. */
  flagAhead?(vehicle: FleetVehicle): number | null;
  /** Stopped at `s` for them, short of `stop`: take them on (nobody gets off here). */
  pickUpFlag?(vehicle: FleetVehicle, stop: number, s: number): void;
  /** Someone by the side street `vehicle` drives, `fromM` along `line` already: where, and their flagS. */
  streetRiderAhead?(
    vehicle: FleetVehicle,
    line: Polyline,
    fromM: number,
  ): { atM: number; flagS: number } | null;
  /** How far `vehicle` can go before someone crossing the road (metres); Infinity: on it goes. */
  crossingAhead?(vehicle: FleetVehicle): number;
}

export interface FleetConfig {
  count: number;
  capacity: number;
  seed: number;
  /** Riders arriving per stop per minute. */
  demandPerStopPerMin: number;
  scenario?: SimulationScenario;
  /** Drivers overtake slower jeepneys while moving (default true). */
  overtaking?: boolean;
  /** What each vehicle is (see fleetKinds); all traditional jeepneys when not given. */
  kinds?: readonly FleetKind[];
  /** Drivers hang back and wait at stops behind a jeepney too close in front (default true). */
  hangBack?: boolean;
  /**
   * A working day: out in the morning, home at night, a ledger closed every
   * day (see SERVICE_FROM_S). Needs `scenario` for the clock.
   */
  dayCycle?: boolean;
  /** The stations along the route (asked for when a jeepney runs low): it fills up there. */
  fuelStops?: () => readonly FuelStopAt[];
}

export const DEFAULT_FLEET: FleetConfig = {
  count: 10,
  capacity: 22,
  seed: 11,
  demandPerStopPerMin: 0.8,
};

const MIN_GAP_M = 14;
/**
 * A driver's own pace on a clear road, the hour's traffic aside: 13 m/s and
 * up to this much more (47 to 58 km/h), under the 60 km/h of Metro Manila's
 * main roads. See trafficShare for the hour.
 */
const CLEAR_ROAD_MPS = 13;
const CLEAR_ROAD_SPREAD_MPS = 3;
/** Along side streets (m/s, about 20 km/h). */
const SIDE_STREET_MPS = 5.6;
/** A way back on more than this many times its own length further round the route turns back. */
const TURNED_BACK = 4;
/** Closer than this to a detour's end, what is on the road holds it back (metres). */
const ROOM_TO_REJOIN_M = 16;
/** A loaded jeepney pulling away, and comfortable braking (m/s²). */
const ACCEL_MPS2 = 1.2;
export const BRAKE_MPS2 = 1.6;
/** Speed for the last metre into a stop, so the braking curve never stalls short. */
const CREEP_MPS = 0.8;
const TERMINAL_DWELL_S = 20;
/**
 * A jeepney held up in a queue this close to its stop loads where it is:
 * riders walk the few metres to it rather than wait for the one in front to
 * leave. Two jeepneys behind the one at the stop, at the minimum gap.
 */
const STOP_ZONE_M = 30;
/**
 * Stuck in a queue this far before their stop, riders getting off there do
 * not wait: they call "para", get off, and walk. The jeepney still stops
 * at the stop itself afterwards, for whoever is waiting.
 */
const ALIGHT_ZONE_M = 90;
/** Overtaking a stopped jeepney: swing out this far (a jeepney's width and a gap)… */
const PASS_SHIFT_M = 2.4;
/** Swinging out, this much clear beyond where it ends up (metres). */
const SWING_CLEAR_M = 2.2;
/** Swung out past a wider vehicle: this much beyond the two of them side by side (metres). */
const SWING_MARGIN_M = 0.2;
/** …starting this far before it, back in this far after it… */
const PASS_WINDOW_AHEAD_M = 22;
const PASS_WINDOW_BEHIND_M = 10;
/** …at this sideways speed, and past at most this many in a row. */
const LANE_SHIFT_MPS = 1.5;
const PASS_AT_MOST = 3;
/**
 * Overtaking a slower moving jeepney. A driver held up within CATCH_UP_M
 * by one going at least SLOWER_BY_MPS under their own pace may pull out,
 * if the road is straight for STRAIGHT_M, their own stop is not that
 * close, and there is ROOM_AHEAD_M past it to cut back into. They speed up
 * by PASS_BOOST_MPS, cut in MERGE_AHEAD_M ahead of it, and give up after
 * PASS_GIVE_UP_S. Then they settle for about CALM_S (less if bolder).
 */
const CATCH_UP_M = 40;
const SLOWER_BY_MPS = 1.5;
const STRAIGHT_M = 120;
const STRAIGHT_RAD = 0.25;
const OWN_STOP_CLEAR_M = 150;
const ROOM_AHEAD_M = 60;
const PASS_BOOST_MPS = 2.5;
const PASS_TOP_MPS = 17;
const MERGE_AHEAD_M = MIN_GAP_M + 8;
const PASS_GIVE_UP_S = 25;
const CALM_S = 60;
/** Chance per second of pulling out, for the boldest driver (scaled by boldness²). */
const PULL_OUT_PER_S = 0.5;
/** Closer than this across the road (metres), two vehicles cannot pass (a bus is 2.5 m wide). */
const SIDE_BY_SIDE_M = 2.3;
/** This far apart across the road (metres), two vehicles are in different lanes. */
const CLEAR_LANE_M = 2.8;
/** How many vehicles along the road are looked past for the next one in a lane. */
const LOOK_ALONG_LANE = 12;
/** How much each new vehicle's time between two stops counts, against those before it. */
const LEARN_SHARE = 0.3;
/** Closer than this along the road, two jeepneys (7.5 m long) are side by side. */
const ALONGSIDE_M = 9;
/**
 * The traditional jeepney's length, which the gaps above are for (metres).
 * Longer vehicles (a 12 m bus) keep half their extra length more from each
 * other and count as alongside further apart; a shorter van, less.
 */
export const JEEPNEY_LENGTH_M = 6.9;
/** Parked: this far out from its lane (off the road, in a yard or driveway beside it)… */
const PARKED_OFF_M = 4.2;
/** …this far from the next one parked there… */
const PARKED_GAP_M = 1.5;
/** …and at a terminal, the row back from the stop by this much (metres). */
const PARKED_BEHIND_STOP_M = 25;
const lengthOf = (kind: FleetKind) =>
  kind === 'jeepney' ? JEEPNEY_LENGTH_M : VEHICLES[kind].lengthM;
/** A traditional jeepney's axles are this far apart (metres). */
const JEEPNEY_WHEELBASE_M = 4.3;
export const wheelbaseOf = (kind: FleetKind) =>
  kind === 'jeepney' ? JEEPNEY_WHEELBASE_M : VEHICLES[kind].wheelbaseM;
/** A traditional jeepney's body is about this wide (metres). */
const JEEPNEY_WIDTH_M = 2;
const widthOf = (kind: FleetKind) => (kind === 'jeepney' ? JEEPNEY_WIDTH_M : VEHICLES[kind].widthM);
/** Side by side, two vehicles keep at least this much air between them (metres). */
const SIDE_GAP_M = 0.1;
/**
 * How far apart across the road (centre to centre) `a` and `b` must be to go
 * past each other: half of each one's width and a gap. Two jeepneys need 2.1 m;
 * a bus beside a modern jeepney 2.45 m.
 */
const besideM = (a: FleetKind, b: FleetKind) => (widthOf(a) + widthOf(b)) / 2 + SIDE_GAP_M;
/** A parked row of any mix: each place fits the longest (a bus). */
const LONGEST_M = VEHICLES.bus.lengthM;
/** One further out and this much further behind is coming up: wait before moving out. */
const COMING_UP_M = 12;
/**
 * Swung out this far, a jeepney (about 2 m wide) clears one in the lane: only
 * then may it drive on past it. Until then it brakes for it like any other.
 */
const SWUNG_OUT_M = 2.1;
/**
 * Hanging back (nag-aabang): a driver close behind another slows to pick up
 * the riders the one in front has not reached yet, rather than follow it and
 * find every stop empty. Closer than this share of the even spacing, at this
 * share of their pace. It is what keeps a route's jeepneys spread out
 * instead of in platoons.
 */
const HANG_BACK_SHARE = 0.4;
const HANG_BACK_PACE = 0.6;
/**
 * Waiting at a stop for the same reason: at an ordinary stop for up to
 * ABANG_S while the one in front is closer than HANG_BACK_SHARE of the
 * spacing. At a terminal, the pila: the dispatcher holds it until the one
 * before is DISPATCH_SHARE of the spacing away, and on a working day
 * (dayCycle) the head of the line loads until PILA_FILL of the seats are
 * taken; either for up to PILA_WAIT_S. Riders who come meanwhile get on.
 * When riders are few, the line grows and jeepneys stand in it rather than
 * drive round near-empty, as at a real terminal.
 */
const ABANG_S = 20;
const DISPATCH_SHARE = 0.75;
const PILA_FILL = 0.9;
/** How long the head of a terminal's line waits to fill: 2 to 5 minutes, a new draw each time. */
const PILA_WAIT_MIN_S = 120;
const PILA_WAIT_MAX_S = 300;
/**
 * With this many lined up behind, the dispatcher sends the head out after
 * LINE_DISPATCH_S at most once loaded, full or not: the line keeps moving.
 */
const LONG_LINE = 3;
const LINE_DISPATCH_S = 15;
/** Drivers set out over this long from SERVICE_FROM_S, at a new time each day (seconds). */
const SET_OUT_OVER_S = 60 * 60;
/** A home or garage along the route is at least this far from a terminal (metres). */
const HOME_CLEAR_M = 800;
/**
 * The route passing within this of a home or garage (metres) is a way home:
 * at night they drive to whichever such pass comes first, the short way,
 * not round the whole loop to the spot they set out from.
 */
const HOME_ROAD_M = 80;
/**
 * Diesel: each vehicle's own tank, in its type's range, burnt at its type's
 * rate moving and standing with the engine on (FUEL in vehicles/specs.ts: a
 * jeepney's as the profit model has it). The
 * driver pulls in at the next station on their side of the road when below
 * REFUEL_BELOW of a tank, or when what is left would not reach the station
 * after it (with RANGE_MARGIN for traffic): nobody passes the last station
 * they could reach. Knocking off for the night, TOP_UP_SHARE of drivers
 * below TOP_UP_BELOW fill up on the way home (each night, a draw of their
 * own); whatever is left carries into the next day. On the first morning,
 * NIGHT_FILLED_SHARE of tanks were filled the night before (90-100%), the
 * rest anywhere from LOWEST_START to 85%.
 *
 * At the station a jeepney turns off the road into the forecourt and drives
 * along it at YARD_MPS, to the pumps of the lane with the shortest line
 * (bays: one, or more on a deep forecourt), stopping YARD_GAP_M behind any
 * jeepney in front. BUSY_SHARE of the time a car is at that pump first (two,
 * SECOND_CAR_SHARE of those), for CAR_MIN_S to CAR_MAX_S each. Filling up
 * takes HANDLING_MIN_S to HANDLING_MAX_S (nozzle, cap, paying the
 * attendant) plus the litres at PUMP_L_PER_MIN, engine off, and never under
 * REFUEL_MIN_S. Full, it drives on to the exit and back onto the road once
 * nobody is coming.
 */
const REFUEL_BELOW = 0.25;
const RANGE_MARGIN = 1.5;
/** Stations looked for this far ahead, when going for diesel or checking it would last (metres). */
const STATION_LOOK_M = 30_000;
const TOP_UP_SHARE = 0.5;
const TOP_UP_BELOW = 0.6;
const NIGHT_FILLED_SHARE = 0.45;
const LOWEST_START = 0.2;
const YARD_MPS = 2.5;
const YARD_GAP_M = 13;
/** Forecourts at least this long (with YARD_GAP_M) have room to turn across into a further lane of pumps (metres). */
const YARD_TURN_M = 9;
/**
 * Through a forecourt a vehicle turns no tighter than this many of its
 * wheelbases (a comfortable lock: a jeepney's 7.7 m, a bus's 10.8 m), and
 * never under YARD_RADIUS_MIN_M.
 */
const YARD_RADIUS_PER_WHEELBASE = 1.8;
const YARD_RADIUS_MIN_M = 4;
/** It swings off the road this steeply (radians), up to YARD_STEEPEST on a short forecourt. */
const YARD_ANGLE = (45 * Math.PI) / 180;
const YARD_STEEPEST = (75 * Math.PI) / 180;
const YARD_STEEPEST_STEP = (5 * Math.PI) / 180;
const yardRadius = (kind: FleetKind) =>
  Math.max(YARD_RADIUS_MIN_M, YARD_RADIUS_PER_WHEELBASE * wheelbaseOf(kind));
const BUSY_SHARE = 0.3;
const SECOND_CAR_SHARE = 0.35;
const CAR_MIN_S = 90;
const CAR_MAX_S = 180;
/** A car waiting for a pump stands this far behind the one at it (metres). */
export const CAR_GAP_M = 6.5;
const HANDLING_MIN_S = 60;
const HANDLING_MAX_S = 90;
const PUMP_L_PER_MIN = 35;
const REFUEL_MIN_S = 120;
/** Its wait for riders up, a vehicle still waits this long for one a few steps off (seconds). */
const LATE_GRACE_S = 20;
/** A station planned on is this close along the route to the one found (metres). */
const SAME_STATION_M = 30;
/** A jeepney low on diesel with no station near enough looks again this often (seconds). */
const FUEL_LOOK_S = 30;
/** A boundary driver joins the back of the terminal's line if it is within this of the kerb. */
const LINE_REACH_M = 1500;
/** Pulling out of (or into) the side of the road at home: this far off the lane (metres). */
const KERBSIDE_M = 3;
/** A vehicle is back at the kerb this far before a stop it will make (metres). */
const KERB_BY_M = 130;
/** Changing lanes, sideways (m/s): a lane in about four seconds. */
const LANE_CHANGE_MPS = 0.9;
/** At the most, when a stop comes up with no warning. */
const HURRIED_LANE_CHANGE_MPS = 3;
/**
 * Sideways per metre forward, at the most: a vehicle steers across, it does
 * not slide. Standing still it stays in its lane, double-parked if the kerb
 * was taken; about 30 degrees of steering at walking pace.
 */
const MOST_ACROSS_PER_M = 0.6;
/** A driver sees the road narrow this far ahead, looking every NARROWING_STEP_M (metres). */
const NARROWING_SEEN_M = 40;
const NARROWING_STEP_M = 10;
/** An unhurried lane change, sideways per metre forward: about 11 degrees. */
const GENTLE_ACROSS_PER_M = 0.2;
/**
 * How quickly the nose comes round to a move across the road: per metre
 * driven, about half a jeepney's wheelbase to settle (it steers, it does not
 * slide sideways).
 */
const NOSE_EASE_PER_M = 0.5;
/** While waiting, look for newcomers to board this often (seconds). */
const REBOARD_EVERY_S = 5;
/**
 * A terminal draws this many times the riders of an ordinary stop: every
 * trip starts there, and it is where the malls and transfers are.
 */
const TERMINAL_DEMAND = 3;
/** The day starts with this much demand already waiting (about half a headway). */
const START_WAITING_S = 300;
const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';

function plate(rng: Rng): string {
  const letter = () => LETTERS[Math.floor(rng() * LETTERS.length)];
  const digits = String(Math.floor(rng() * 10_000)).padStart(4, '0');
  return `${letter()}${letter()}${letter()} ${digits}`;
}

export class FleetSim {
  elapsedS = 0;
  generatedDemand = 0;
  passengerService: PassengerService | null = null;
  readonly vehicles: FleetVehicle[];
  /** Riders waiting at each stop (route.stops order). */
  readonly waiting: number[];
  readonly route: Route;
  private readonly rng: Rng;
  private readonly demandRng: Rng;
  /** Each stop's share of the route's riders (terminals draw more). */
  /** Each stop's share of the route's riders (terminals draw more). */
  readonly demandShare: number[];
  private cfg: FleetConfig;
  private readonly lanes: [FleetVehicle[], FleetVehicle[]] = [[], []];
  private readonly leaders: Array<FleetVehicle | null> = [];
  /** The jeepney directly behind each one (for finishing an overtake). */
  private readonly followers: Array<FleetVehicle | null> = [];
  /** The even spacing of each direction's jeepneys (metres), from the last indexLeaders. */
  private readonly spacing: [number, number] = [Infinity, Infinity];
  /** Seconds each jeepney has waited at its stop for the one in front to get away. */
  private readonly heldS: number[] = [];
  /** Waiting at a stop for riders on their way, as its driver chose (waitFor), by vehicle id. */
  private readonly holds = new Map<number, { stop: number; untilS: number }>();
  /** Jeepneys letting riders off in a queue, before reaching the stop itself. */
  private readonly dropOffOnly = new Set<number>();
  /** Overtakes under way: passer id → the jeepney being passed, and since when. */
  private readonly overtakes = new Map<number, { of: number; sinceS: number }>();
  /** When each driver may next think about overtaking (elapsedS). */
  private readonly calmUntil: number[] = [];
  /** Drivers' choices: a stream of their own, so riders and plates replay the same. */
  private readonly driverRng: Rng;
  private scanLeaders = false;
  /** Day 1 is the day the simulation started; every closed day is in history. */
  dayNumber = 1;
  readonly history: DayRecord[] = [];
  /** Days since the epoch at which the current ledger day started (see DAY_ENDS_S). */
  private ledgerDay: number;
  /** For each jeepney kept along the route: every place the route passes it (see HOME_ROAD_M). */
  private readonly homeSpots: number[][] = [];
  /**
   * What the rest of the road tells each vehicle, from outside the simulation
   * (the other routes' traffic is not simulated, see NetworkLayer): metres to
   * the nearest thing ahead in its lane, and whether the lane beside it towards
   * the middle of the road is taken. Infinite and 0 when nobody is looking.
   */
  readonly trafficAhead: Float32Array;
  readonly trafficBeside: Uint8Array;
  /**
   * How long the road from the stop before each stop has been taking lately
   * (seconds, stops and queues included; 0 until someone has driven it). What
   * arrival times go by: only this knows how the traffic really is.
   */
  readonly stopToStopS: Float64Array;
  private readonly lastStop: Array<{ next: number; at: number } | null> = [];
  /** When each jeepney low on diesel next looks for a station ahead (elapsedS). */
  private readonly fuelLookAt: number[] = [];
  /** How long the head of a terminal's line waits to fill this time (seconds). */
  private readonly pilaWaitS: number[] = [];
  /** Driven home already today: parked until tomorrow. */
  private readonly doneToday: boolean[] = [];
  /** Traffic now: the share of a clear-road pace the jeepneys can make. */
  private traffic = 1;
  /** Set by emptyRoad: the hour's traffic is left out. */
  private roadEmpty = false;

  /** Riders a day on the route (the scenario's), or 0 without a scenario. */
  get dailyTrips(): number {
    return this.cfg.scenario?.dailyTrips ?? 0;
  }

  constructor(route: Route, cfg: FleetConfig = DEFAULT_FLEET) {
    this.route = route;
    this.cfg = cfg;
    this.rng = createRng(cfg.seed);
    // Fleet size must not change the demand experiment for the same seed.
    this.demandRng = createRng(cfg.seed ^ 0x51ed270b);
    this.driverRng = createRng(cfg.seed ^ 0x2c1b3c6d);
    // Riders turn up where its vehicles take them on (a UV Express route: at
    // its terminals only), more at the terminals.
    this.trafficAhead = new Float32Array(cfg.count).fill(Infinity);
    this.trafficBeside = new Uint8Array(cfg.count);
    this.stopToStopS = new Float64Array(route.stops.length);
    const fleetKindsHere: FleetKind[] = [...new Set(cfg.kinds ?? ['jeepney' as const])];
    const weights = route.stops.map((_, i): number =>
      !fleetKindsHere.some((k) => stopRoles(route, k).loads[i])
        ? 0
        : isTerminal(route, i)
          ? TERMINAL_DEMAND
          : 1,
    );
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    this.demandShare = weights.map((w) => w / total);
    // Started while jeepneys run: the riders of the last few minutes are
    // waiting. Before the day's first riders (or after its last), nobody is.
    const startedAt = this.startTimeOfDay(cfg);
    const riding = !cfg.dayCycle || (startedAt >= SERVICE_FROM_S && startedAt < LAST_RIDERS_S);
    const waitingNow = !riding
      ? 0
      : cfg.scenario
        ? expectedArrivals(cfg.scenario, 0, START_WAITING_S)
        : (cfg.demandPerStopPerMin * route.stops.length * START_WAITING_S) / 60;
    this.waiting = this.demandShare.map((share) => poisson(this.demandRng, waitingNow * share));

    const L = route.polyline.length;
    this.ledgerDay = Math.floor((this.clockS - DAY_ENDS_S) / 86_400);
    const now = this.timeOfDay;
    const ownerShare = cfg.scenario?.ownerShare ?? 0;
    // Each kind's own terminals (a bus's are not the jeepneys': core/vehicles/stops.ts).
    const depotsOf = (kind: FleetKind) => {
      const own = stopRoles(route, kind).terminal.flatMap((t, i) => (t ? [i] : []));
      return own.length > 0 ? own : [0];
    };
    // Boundary drivers' garages: a stream of their own, so the other draws replay the same.
    const garageRng = createRng(cfg.seed ^ 0x7f4a7c15);
    let atTerminals = 0;
    this.vehicles = Array.from({ length: cfg.count }, (_, i) => {
      // On a loop everyone drives the same way round; on a line, alternate.
      const direction: 1 | -1 = route.loop || i % 2 === 0 ? 1 : -1;
      const s = ((i + 0.5) / cfg.count) * L;
      // 47–58 km/h on a clear road; a van a little quicker, a bus a little slower.
      const kind = cfg.kinds?.[i] ?? 'jeepney';
      const cruise =
        (CLEAR_ROAD_MPS + this.rng() * CLEAR_ROAD_SPREAD_MPS) *
        (kind === 'uv' ? 1.05 : kind === 'bus' ? 0.95 : 1);
      // An owner keeps it at home, somewhere along the route away from the
      // terminals; a boundary driver collects it from the operator, at a
      // terminal or at a garage along the route (TERMINAL_KEPT_SHARE).
      const owner = this.driverRng() < ownerShare;
      const atTerminal = !owner && garageRng() < TERMINAL_KEPT_SHARE;
      const depots = depotsOf(kind);
      const depot = atTerminal ? depots[atTerminals++ % depots.length]! : null;
      const rng = owner ? this.driverRng : garageRng;
      let garageS = depot === null ? rng() * L : route.stops[depot]!.s;
      for (let tries = 0; depot === null && tries < 20 && !this.awayFromTerminals(garageS); tries++)
        garageS = rng() * L;
      // Its own tank size, fixed by its number (no draw from the shared stream).
      const [smallestL, largestL] = FUEL[kind].tankL;
      const tankCapacityL = smallestL + (largestL - smallestL) * tankShare(this.cfg.seed, i);
      // In the tank the first morning: filled last night, or whatever was left.
      const night = this.driverRng();
      const tankL =
        tankCapacityL *
        (night < NIGHT_FILLED_SHARE
          ? 0.9 + (0.1 * night) / NIGHT_FILLED_SHARE
          : LOWEST_START +
            ((0.85 - LOWEST_START) * (night - NIGHT_FILLED_SHARE)) / (1 - NIGHT_FILLED_SHARE));
      this.homeSpots[i] =
        depot === null
          ? passesNear(route.polyline, route.polyline.pointAt(garageS), HOME_ROAD_M)
          : [];
      this.doneToday[i] = false;
      // Started during the working day: already out on the road. Before its
      // morning departure (or after knocking off): parked where it is kept.
      const out = !cfg.dayCycle || (now >= this.outAt(i) + 600 && now < this.homeAt(i));
      return {
        id: i,
        plate: plate(this.rng),
        livery: (['red', 'yellow', 'green'] as const)[i % 3]!,
        kind,
        s,
        direction,
        cruiseMps: cruise,
        speedMps: cruise,
        dwellS: 0,
        capacity: cfg.capacity,
        seats: cfg.capacity,
        occupancy: Math.floor(this.rng() * cfg.capacity * 0.6),
        nextStop: this.nextStopIndex(s, direction),
        currentStop: null,
        laneShiftM: 0,
        cruiseLaneM: 0,
        noseAcross: 0,
        wasAcrossM: 0,
        boldness: this.driverRng(),
        day: {
          metres: 0,
          idleS: 0,
          fareCentavos: 0,
          riders: 0,
          owner,
          tankStartL: tankL,
          fuelUsedL: 0,
          fuelBoughtL: 0,
          refuels: 0,
        },
        duty: out ? 'service' : 'parked',
        garageS,
        owner,
        depot,
        tankL,
        tankCapacityL,
        topUpTonight: false,
        refuel: null,
        refuelLeftS: 0,
        yard: null,
        ...(out
          ? {}
          : {
              s: garageS,
              occupancy: 0,
              speedMps: 0,
              nextStop: this.nextStopIndex(garageS, direction),
            }),
      };
    });
  }

  /** Seconds since midnight when the simulation starts (before `this` is set up). */
  private startTimeOfDay(cfg: FleetConfig): number {
    const sc = cfg.scenario;
    const s = sc ? sc.startHour * 3600 + (sc.startOffsetS ?? 0) : 7 * 3600;
    return ((s % 86_400) + 86_400) % 86_400;
  }

  /** Simulated clock: seconds since midnight of the first day. */
  get clockS(): number {
    const sc = this.cfg.scenario;
    return (sc ? sc.startHour * 3600 + (sc.startOffsetS ?? 0) : 7 * 3600) + this.elapsedS;
  }

  /** Seconds since midnight, today. */
  get timeOfDay(): number {
    return ((this.clockS % 86_400) + 86_400) % 86_400;
  }

  /** Every jeepney parked: the night, when nothing moves. */
  get allParked(): boolean {
    return this.vehicles.every((v) => v.duty === 'parked');
  }

  /** A driver's own draw for today, 0–1: a different morning and night every day. */
  private today(id: number, salt: number): number {
    let h = Math.imul(this.cfg.seed ^ 0x6a09e667, 0x85ebca6b) ^ Math.imul(id + 1, 0xc2b2ae35);
    h = Math.imul(h ^ Math.imul(this.dayNumber + salt, 0x27d4eb2f), 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    return ((h ^ (h >>> 12)) >>> 0) / 4_294_967_296;
  }

  /** When driver `id` sets out today, and when they knock off (seconds since midnight). */
  private outAt(id: number): number {
    return SERVICE_FROM_S + this.today(id, 1) * SET_OUT_OVER_S;
  }
  private homeAt(id: number): number {
    return HOME_FROM_S + this.today(id, 2) * (HOME_TO_S - HOME_FROM_S);
  }

  /**
   * Where parked `v` stands (drawn, not driven): off the road beside where it
   * is kept, PARKED_OFF_M out from the lane, in a row back from it with any
   * others kept there; at a terminal, the row starts PARKED_BEHIND_STOP_M
   * back from the stop (clear of the people waiting there).
   */
  parkedSpot(v: FleetVehicle): { s: number; shift: number } {
    let k = 0;
    for (const o of this.vehicles)
      if (o !== v && o.duty === 'parked' && o.id < v.id && this.apartS(o.garageS, v.garageS) < 1)
        k++;
    const back = k * (LONGEST_M + PARKED_GAP_M) + (v.depot !== null ? PARKED_BEHIND_STOP_M : 0);
    const L = this.route.polyline.length;
    const s = v.garageS - v.direction * back;
    return {
      s: this.route.loop ? ((s % L) + L) % L : Math.max(0, Math.min(L, s)),
      shift: PARKED_OFF_M,
    };
  }

  /** Whether `stop` is one of `v`'s terminals (a bus's and a UV Express's are their own). */
  private terminalFor(v: FleetVehicle, stop: number): boolean {
    return stopRoles(this.route, v.kind).terminal[stop] === true;
  }

  /** Whether along-route position `s` is at least HOME_CLEAR_M from every terminal. */
  private awayFromTerminals(s: number): boolean {
    return this.route.stops.every((st) => !st.terminal || this.apartS(s, st.s) >= HOME_CLEAR_M);
  }

  /** Close the day's ledger at DAY_ENDS_S: every jeepney's totals into history. */
  private closeDays(): void {
    const ledger = Math.floor((this.clockS - DAY_ENDS_S) / 86_400);
    while (this.ledgerDay < ledger) {
      this.history.push({
        day: this.dayNumber,
        totals: this.vehicles.map((v) => ({ ...v.day, tankEndL: v.tankL })),
      });
      // The diesel left carries over: the new day starts with it in the tank.
      for (const v of this.vehicles)
        v.day = {
          metres: 0,
          idleS: 0,
          fareCentavos: 0,
          riders: 0,
          owner: v.owner,
          tankStartL: v.tankL,
          fuelUsedL: 0,
          fuelBoughtL: 0,
          refuels: 0,
        };
      this.doneToday.fill(false);
      this.dayNumber++;
      this.ledgerDay++;
      this.passengerService?.endOfDay?.();
    }
  }

  /** Drivers setting out in the morning, and knocking off at night. */
  private changeDuties(): void {
    const now = this.timeOfDay;
    for (const v of this.vehicles) {
      if (v.duty === 'service' && (now >= this.homeAt(v.id) || now < SERVICE_FROM_S)) {
        v.duty = 'homebound';
        // Some fill up on the way home tonight, ready for the morning.
        v.topUpTonight = this.today(v.id, 3) < TOP_UP_SHARE;
      }
      if (
        v.duty !== 'parked' ||
        this.doneToday[v.id] ||
        now < this.outAt(v.id) ||
        now >= this.homeAt(v.id)
      )
        continue;
      if (v.depot === null) {
        if (this.roomAt(v.garageS)) this.setOut(v);
      } else if (this.roomAt(this.route.stops[v.depot]!.s)) this.leaveTerminal(v);
      else this.joinLine(v);
    }
  }

  /** A boundary driver out of the operator's terminal: at its kerb, taking whoever waits. */
  private leaveTerminal(v: FleetVehicle): void {
    const at = v.depot!;
    v.duty = 'service';
    v.s = this.route.stops[at]!.s;
    v.direction = this.route.loop || at < this.route.stops.length - 1 ? 1 : -1;
    v.nextStop = at;
    v.currentStop = at;
    v.dwellS = TERMINAL_DWELL_S;
    v.speedMps = 0;
    v.laneShiftM = 0;
    v.occupancy = 0;
    this.scanLeaders = true;
    this.passengerService?.pickUp(v, at);
  }

  /**
   * A boundary driver out while another loads at the terminal: at the back of
   * its line, on the road into the terminal (a loop's; a line's ends have no
   * road behind them, so there it waits for the kerb to clear).
   */
  private joinLine(v: FleetVehicle): void {
    if (!this.route.loop) return;
    const L = this.route.polyline.length;
    const at = this.route.stops[v.depot!]!.s;
    // Jeepneys standing in line before the terminal, nearest it first.
    const line = this.vehicles
      .filter((o) => o.duty !== 'parked' && o.speedMps < 0.5)
      .map((o) => aheadOf(this.route, o.s, at))
      .map((d) => (d > L - 1 ? 0 : d))
      .filter((d) => d < LINE_REACH_M)
      .sort((a, b) => a - b);
    let tail = -Infinity;
    for (const d of line) {
      if (tail > -Infinity && d > tail + MIN_GAP_M + 12) break;
      tail = Math.max(tail, d);
    }
    if (tail === -Infinity) return;
    // Just over a gap behind the last in line (roomAt asks for that much).
    const spot = (((at - tail - MIN_GAP_M - 9) % L) + L) % L;
    if (!this.roomAt(spot)) return;
    v.duty = 'service';
    v.s = spot;
    v.direction = 1;
    v.nextStop = v.depot!;
    v.currentStop = null;
    v.dwellS = 0;
    v.speedMps = 0;
    v.laneShiftM = 0;
    v.occupancy = 0;
    this.scanLeaders = true;
  }

  /** No jeepney on the road within a gap of along-route position `at`: room to pull out. */
  private roomAt(at: number): boolean {
    return this.vehicles.every((o) => o.duty === 'parked' || this.apartS(at, o.s) > MIN_GAP_M + 8);
  }

  /**
   * Out for the day: pulling out from the side of the road where it was kept,
   * empty, onto the route; its first trip starts from there, picking up
   * whoever is waiting on the way.
   */
  private setOut(v: FleetVehicle): void {
    v.duty = 'service';
    v.s = v.garageS;
    v.nextStop = this.nextStopIndex(v.garageS, v.direction);
    v.currentStop = null;
    v.dwellS = 0;
    v.speedMps = 0;
    v.laneShiftM = KERBSIDE_M; // eases into the lane (steerAround)
    v.occupancy = 0;
    this.scanLeaders = true;
  }

  /** In for the night where it is kept: off the road, not drawn. */
  private park(v: FleetVehicle): void {
    v.duty = 'parked';
    v.refuel = null;
    v.refuelLeftS = 0;
    v.yard = null;
    v.currentStop = null;
    v.dwellS = 0;
    v.speedMps = 0;
    v.laneShiftM = 0;
    v.occupancy = 0;
    this.doneToday[v.id] = true;
    this.heldS[v.id] = 0;
    this.dropOffOnly.delete(v.id);
    this.overtakes.delete(v.id);
    for (const [id, o] of this.overtakes) if (o.of === v.id) this.overtakes.delete(id);
    this.scanLeaders = true;
  }

  /** Diesel burnt: `metres` driven and `idleS` standing with the engine on. */
  private burn(v: FleetVehicle, metres: number, idleS: number): void {
    const { kmPerL, idleLPerH } = FUEL[v.kind ?? 'jeepney'];
    const used = Math.min(v.tankL, metres / 1000 / kmPerL + (idleS / 3600) * idleLPerH);
    v.tankL -= used;
    v.day.fuelUsedL += used;
  }

  /** Diesel to drive `metres`, with RANGE_MARGIN for traffic and idling. */
  private litresFor(v: FleetVehicle, metres: number): number {
    return (metres / 1000 / FUEL[v.kind ?? 'jeepney'].kmPerL) * RANGE_MARGIN;
  }

  /**
   * Whether `v` should go for diesel at the next station: below
   * REFUEL_BELOW of its tank; or with too little to reach the station after
   * it (so it never passes the last one it could reach); or knocking off
   * tonight, its driver one who fills up then and the tank under TOP_UP_BELOW.
   */
  private wantsDiesel(v: FleetVehicle): boolean {
    if (v.tankL < REFUEL_BELOW * v.tankCapacityL) return true;
    if (v.duty === 'homebound' && v.topUpTonight && v.tankL < TOP_UP_BELOW * v.tankCapacityL)
      return true;
    const after = this.stationsAhead(v)[1];
    return v.tankL < this.litresFor(v, after?.d ?? STATION_LOOK_M);
  }

  /** How far ahead along-route position `at` is, in the jeepney's direction. */
  private ahead(v: FleetVehicle, at: number): number {
    return this.route.loop ? aheadOf(this.route, v.s, at) : (at - v.s) * v.direction;
  }

  /** The stations on its side of the road within STATION_LOOK_M ahead (to where it turns in), nearest first. */
  private stationsAhead(v: FleetVehicle): Array<{ at: FuelStopAt; d: number }> {
    const side = v.direction === 1 ? 'right' : 'left';
    const out: Array<{ at: FuelStopAt; d: number }> = [];
    for (const st of this.cfg.fuelStops?.() ?? []) {
      if (st.side !== side) continue;
      const d = this.ahead(v, st.inS);
      if (d > 30 && d < STATION_LOOK_M) out.push({ at: st, d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /** The jeepneys in `stop`'s forecourt. */
  private inYard(stop: FuelStopAt): FleetVehicle[] {
    return this.vehicles.filter((o) => o.yard && o.yard.stop.inS === stop.inS);
  }

  /**
   * At the station's entrance: off the road into the lane of pumps with the
   * shortest line, unless the forecourt is full to its entrance (then it
   * waits in the road). Maybe a car or two at its pump before it.
   */
  private turnIn(v: FleetVehicle): boolean {
    // From its own lane only: not while swung out round a jeepney at a stop.
    if (v.laneShiftM < -0.5) return false;
    const stop = v.refuel!.at;
    const inside = this.inYard(stop);
    if (inside.some((o) => o.yard!.u < YARD_GAP_M)) return false;
    const line = (bay: number) => inside.filter((o) => o.yard!.bay === bay && !o.yard!.full);
    let bay = 0;
    // A bus keeps to the pumps nearest the road: it would sweep across the others.
    const bays = v.kind === 'bus' ? 1 : baysOf(stop);
    for (let b = 1; b < bays; b++) if (line(b).length < line(bay).length) bay = b;
    const cars =
      line(bay).length === 0 && this.driverRng() < BUSY_SHARE
        ? this.driverRng() < SECOND_CAR_SHARE
          ? 2
          : 1
        : 0;
    v.yard = {
      stop,
      bay,
      u: 0,
      cars,
      carLeftS: cars > 0 ? this.carTime() : 0,
      ahead: 0,
      full: false,
    };
    v.s = stop.inS;
    v.speedMps = Math.min(v.speedMps, YARD_MPS);
    this.overtakes.delete(v.id);
    return true;
  }

  /** Seconds a car takes at the pump. */
  private carTime(): number {
    return CAR_MIN_S + this.driverRng() * (CAR_MAX_S - CAR_MIN_S);
  }

  /**
   * In the forecourt: up to its pump (behind whoever is in front), waiting
   * its turn with the engine on, filling up with it off, then on to the
   * exit and back onto the road when nobody is coming.
   */
  private atStation(v: FleetVehicle, dtS: number): void {
    const y = v.yard!;
    const stop = y.stop;
    // The car at its pump.
    if (y.cars > 0) {
      y.carLeftS -= dtS;
      if (y.carLeftS <= 0) y.carLeftS = --y.cars > 0 ? this.carTime() : 0;
    }
    // Who is in front of it: in its lane of pumps, or in any while either is
    // turning in or out (across the other lanes).
    const turn = yardTurn(stop, v.kind, y.bay);
    const turning = (u: number) => u < turn - 0.1 || u > stop.lengthM - turn + 0.1;
    let next = Infinity;
    let jeepneys = 0;
    for (const o of this.inYard(stop)) {
      if (o === v || o.yard!.u <= y.u) continue;
      const lane = o.yard!.bay === y.bay;
      if (!lane && !turning(y.u) && !turning(o.yard!.u)) continue;
      next = Math.min(next, o.yard!.u);
      if (lane && !o.yard!.full) jeepneys++;
    }
    y.ahead = y.cars + jeepneys;
    const pump = pumpAt(stop, v.kind, y.bay);
    const goal = Math.min(
      y.full ? stop.lengthM : pump - y.cars * CAR_GAP_M,
      next - YARD_GAP_M,
      // Out onto the road only once nobody is coming (and held there, standing
      // at the start of the turn out, until then).
      y.full && y.u <= stop.lengthM - turn + 0.05 && !this.roomAround(v)
        ? stop.lengthM - turn
        : Infinity,
    );
    const left = goal - y.u;
    if (left > 0.05) {
      const target = Math.min(YARD_MPS, Math.max(CREEP_MPS, Math.sqrt(2 * BRAKE_MPS2 * left)));
      v.speedMps = target > v.speedMps ? Math.min(target, v.speedMps + ACCEL_MPS2 * dtS) : target;
      const step = Math.min(v.speedMps * dtS, left);
      y.u += step;
      v.day.metres += step;
      this.burn(v, step, 0);
    } else {
      v.speedMps = 0;
      if (!y.full && y.ahead === 0 && y.u >= pump - 0.05) this.fillUp(v, dtS);
      else {
        v.day.idleS += dtS;
        this.burn(v, 0, dtS);
      }
    }
    const L = this.route.polyline.length;
    const s = stop.inS + v.direction * y.u;
    v.s = this.route.loop ? ((s % L) + L) % L : Math.max(0, Math.min(L, s));
    v.laneShiftM = yardShift(stop, y.bay, y.u, v.kind);
    // Pointing along its way through, so it leaves the forecourt pointing along the road.
    v.noseAcross = -Math.tan(yardAngle(stop, y.bay, y.u, v.kind));
    if (y.full && y.u >= stop.lengthM - 0.05) {
      // Back on the road.
      v.yard = null;
      v.laneShiftM = 0;
      this.scanLeaders = true;
    }
  }

  /** At the pump, engine off: the attendant's time and the litres (those planned, or a full tank). */
  private fillUp(v: FleetVehicle, dtS: number): void {
    const litres = Math.min(v.tankCapacityL - v.tankL, v.refuelLitres ?? Infinity);
    if (v.refuelLeftS === 0) {
      const handling = HANDLING_MIN_S + this.driverRng() * (HANDLING_MAX_S - HANDLING_MIN_S);
      v.refuelLeftS = Math.max(REFUEL_MIN_S, handling + (litres / PUMP_L_PER_MIN) * 60);
    }
    v.refuelLeftS = Math.max(0, v.refuelLeftS - dtS);
    if (v.refuelLeftS > 0) return;
    v.day.fuelBoughtL += litres;
    v.day.refuels++;
    v.tankL += litres;
    v.refuelLitres = null;
    v.topUpTonight = false;
    v.refuel = null;
    v.yard!.full = true;
  }

  /**
   * Nobody else on the road within a gap of `v`: room to pull out into the
   * lane. One stopped just behind it has stopped for it (it treats `v` as
   * in the lane once `v` is half out): `v` goes, or both would wait for ever.
   */
  private roomAround(v: FleetVehicle): boolean {
    return this.vehicles.every((o) => {
      if (o === v || o.duty === 'parked' || o.laneShiftM > 0.5) return true;
      if (this.apartS(v.s, o.s) > MIN_GAP_M + 8 + Math.max(0, this.longer(v, o))) return true;
      const behind =
        o.direction === v.direction && this.ahead(o, v.s) < this.route.polyline.length / 2;
      return behind && o.speedMps < 0.5;
    });
  }

  /** Whether a jeepney driving home is there (it passes its spot within a tick's drive). */
  private reachedGarage(v: FleetVehicle): boolean {
    const L = this.route.polyline.length;
    const ahead = this.route.loop
      ? aheadOf(this.route, v.s, v.garageS)
      : (v.garageS - v.s) * v.direction;
    // Just past it (a tick overshoot), or within a couple of metres.
    return ahead <= 2 || (this.route.loop && ahead > L - 2) || (!this.route.loop && ahead < 0);
  }

  /** How far apart two along-route positions are, either way round. */
  private apartS(a: number, b: number): number {
    if (!this.route.loop) return Math.abs(b - a);
    const L = this.route.polyline.length;
    const d = (((b - a) % L) + L) % L;
    return Math.min(d, L - d);
  }

  /** A driver's pace now: their clear-road speed, slowed by the hour's traffic. */
  private paceOf(v: FleetVehicle): number {
    return v.cruiseMps * this.traffic;
  }

  /** Jeepney `id`'s moving pace now (paceOf): what its arrival times are worked out at. */
  /** Traffic standing on the road, for trying out what the app says about it. */
  private readonly slowZones: Array<{ s: number; halfM: number; untilS: number; mps: number }> = [];

  /** A stretch of road `lengthM` long from `s`, crawling at `mps` for `forS` seconds. */
  addSlowZone(s: number, lengthM: number, forS: number, mps: number): void {
    const L = this.route.polyline.length;
    const middle = (((s + lengthM / 2) % L) + L) % L;
    this.slowZones.push({ s: middle, halfM: lengthM / 2, untilS: this.elapsedS + forS, mps });
  }

  /** Traffic on the road now. */
  get slowRoad(): ReadonlyArray<{ s: number; halfM: number; mps: number }> {
    return this.slowZones.filter((z) => z.untilS > this.elapsedS);
  }

  /** The speed the road allows `v` now (Infinity with no traffic on it). */
  private zoneLimit(v: FleetVehicle): number {
    let limit = Infinity;
    for (const z of this.slowZones)
      if (z.untilS > this.elapsedS && this.apartS(v.s, z.s) <= z.halfM)
        limit = Math.min(limit, z.mps);
    return limit;
  }

  pace(id: number): number {
    const v = this.vehicles[id];
    return v ? this.paceOf(v) : 0;
  }

  /**
   * Put jeepney i at along-route position s with this load and plate, as
   * if it had driven there: the hand-over from a network flow when its
   * route becomes the focused one. Before riders are seated (CrewState).
   */
  place(i: number, at: { s: number; occupancy: number; plate: string; inService?: boolean }): void {
    const v = this.vehicles[i]!;
    if (at.inService === false) {
      // Not on the road at this hour: parked where it is kept.
      v.plate = at.plate;
      v.s = v.garageS;
      v.nextStop = this.nextStopIndex(v.garageS, v.direction);
      this.park(v);
      // Knocked off already (night) or still to come out (before its departure).
      this.doneToday[v.id] = this.timeOfDay >= this.homeAt(v.id);
      return;
    }
    v.duty = 'service';
    const L = this.route.polyline.length;
    v.s = this.route.loop ? ((at.s % L) + L) % L : Math.max(0, Math.min(L, at.s));
    v.occupancy = Math.max(0, Math.min(v.capacity, Math.round(at.occupancy)));
    v.plate = at.plate;
    v.nextStop = this.nextStopIndex(v.s, v.direction);
    v.currentStop = null;
    v.dwellS = 0;
    v.laneShiftM = 0;
    v.refuel = null;
    v.refuelLeftS = 0;
    v.yard = null;
    this.scanLeaders = true;
  }

  step(dtS: number): void {
    // Route-wide arrivals this tick, shared out by stop (terminals draw more).
    // With a working day, riders only come while jeepneys run.
    const now = this.timeOfDay;
    const running = !this.cfg.dayCycle || (now >= SERVICE_FROM_S && now < LAST_RIDERS_S);
    const routeMean = !running
      ? 0
      : this.cfg.scenario
        ? expectedArrivals(this.cfg.scenario, this.elapsedS, dtS)
        : (this.cfg.demandPerStopPerMin / 60) * dtS * this.waiting.length;
    this.elapsedS += dtS;
    // The hour's traffic, as the network's flows have it: a clear road at
    // night, slowest in the rush hours.
    if (this.cfg.scenario && !this.roadEmpty) this.traffic = trafficShare(this.timeOfDay / 3600);
    if (this.cfg.dayCycle) {
      this.closeDays();
      this.changeDuties();
    }
    for (let i = 0; i < this.waiting.length; i++) {
      const arrivals = poisson(this.demandRng, routeMean * this.demandShare[i]!);
      this.generatedDemand += arrivals;
      if (this.passengerService) this.passengerService.demand(i, arrivals);
      else this.waiting[i]! += arrivals;
    }
    this.indexLeaders();
    for (const v of this.vehicles) {
      this.stepVehicle(v, dtS);
      this.turnNose(v, dtS);
      this.noteStopToStop(v);
    }
  }

  private stepVehicle(v: FleetVehicle, dtS: number): void {
    if (v.duty === 'parked') return;
    if (v.yard) {
      this.atStation(v, dtS);
      return;
    }
    const detour = v.detour;
    if (detour && !detour.on && v.currentStop === null && this.reached(v, detour.enterS)) {
      detour.on = true;
      detour.fromAcross = this.acrossOf(v);
      v.noseAcross = 0;
      this.overtakes.delete(v.id);
    }
    if (detour?.on) {
      this.onDetour(v, detour, dtS);
      return;
    }
    if (v.currentStop !== null) {
      v.day.idleS += dtS;
      this.burn(v, 0, dtS);
      v.dwellS = Math.max(0, v.dwellS - dtS);
      v.speedMps = 0;
      this.overtakes.delete(v.id);
      // In to the kerb, unless stopped beside one already there (double-parked).
      this.steerAround(v, dtS);
      this.keepLane(v, true, dtS, 0);
      if (v.dwellS > 0 || this.passengerService?.busy(v.id)) return;
      // The last trip done at a terminal, everyone off. A jeepney the
      // operator keeps at a terminal stays there; the rest drive back to
      // the home or garage they came out of.
      if (
        v.duty === 'homebound' &&
        this.terminalFor(v, v.currentStop) &&
        !this.dropOffOnly.has(v.id)
      ) {
        if (v.depot !== null) {
          v.depot = v.currentStop;
          v.garageS = this.route.stops[v.currentStop]!.s;
          this.park(v);
          return;
        }
        // Home the short way: wherever the route next passes the house.
        const ways = this.homeSpots[v.id]!.length > 0 ? this.homeSpots[v.id]! : [v.garageS];
        v.garageS = ways.reduce((best, w) => (this.ahead(v, w) < this.ahead(v, best) ? w : best));
        v.duty = 'returning';
        v.nextStop = this.stopAfter(v.currentStop, v.direction);
        v.currentStop = null;
        return;
      }
      if (this.waitsForGap(v, dtS)) return;
      // On a line, turn around at a terminal once everyone is clear of the
      // vehicle. A loop never turns around: the road takes it back.
      if (!this.passengerService && !this.route.loop && this.terminalFor(v, v.currentStop)) {
        v.direction = v.direction === 1 ? -1 : 1;
        this.scanLeaders = true;
      }
      // The stop after the one served (it may have been served from short of
      // it). Riders let off in a queue: the stop itself is still to come.
      v.nextStop = this.dropOffOnly.delete(v.id)
        ? v.currentStop
        : this.stopAfter(v.currentStop, v.direction);
      v.currentStop = null;
      return;
    }

    const route = this.route;
    const stop = route.stops[v.nextStop];
    const isTerminalNext = this.terminalFor(v, v.nextStop);
    const service = this.passengerService;
    // Driving home, empty: past every stop, and in for the night on reaching home.
    const returning = v.duty === 'returning';
    if (returning && this.reachedGarage(v)) {
      this.park(v);
      return;
    }
    // At the side of the road (out from home):
    // into the lane only once nobody is coming past.
    if (v.laneShiftM > 0.5 && !this.roomAround(v)) {
      v.speedMps = 0;
      v.day.idleS += dtS;
      this.burn(v, 0, dtS);
      return;
    }
    // Diesel needed (see wantsDiesel): the next station on the way (looked
    // at every FUEL_LOOK_S, not every tick).
    if (!v.refuel && this.elapsedS >= (this.fuelLookAt[v.id] ?? 0)) {
      this.fuelLookAt[v.id] = this.elapsedS + FUEL_LOOK_S;
      if (this.wantsDiesel(v)) {
        const next = this.stationsAhead(v)[0];
        v.refuel = next ? { s: next.at.inS, name: next.at.name, at: next.at } : null;
      }
    }
    // Distance to the station it is filling up at (Infinity when not going to one).
    const toFuel = v.refuel ? this.ahead(v, v.refuel.s) : Infinity;
    // Slow for the stop only if someone gets on or off there (or it is a terminal).
    const mayStop =
      !returning &&
      !!stop &&
      (this.holds.get(v.id)?.stop === v.nextStop ||
        (service
          ? service.wantsStop(v, v.nextStop)
          : isTerminalNext || (this.waiting[v.nextStop] ?? 0) > 0 || v.occupancy > 0));
    // Distance still to drive to the stop (around the loop, on a loop).
    const toStop = stop
      ? route.loop
        ? aheadOf(route, v.s, stop.s)
        : Math.abs(stop.s - v.s)
      : Infinity;
    // Someone waving it down by the road, before the stop.
    const flag = returning ? null : (service?.flagAhead?.(v) ?? null);
    const toFlag = flag === null ? Infinity : this.ahead(v, flag);
    const flagged = flag !== null && toFlag <= toStop;
    const toHalt = flagged ? toFlag : mayStop ? toStop : Infinity;
    // Someone crossing: not past the line, whatever else it is doing.
    const toCrossing = service?.crossingAhead?.(v) ?? Infinity;

    this.overtake(v, Math.min(toHalt, toCrossing), dtS);
    const stopping = toHalt < KERB_BY_M;
    this.keepLane(
      v,
      stopping || toFuel < KERB_BY_M || this.passengerService?.busy(v.id) === true,
      dtS,
      // Caught out by someone at the stop: in to the kerb before reaching it.
      stopping ? toHalt / Math.max(v.speedMps, 1) : Infinity,
    );
    // Speed the jeepney wants: cruise (a bit more while overtaking), but able
    // to brake in time for the stop and for the jeepney ahead (v² = 2·a·d).
    const pace = this.overtakes.has(v.id)
      ? Math.min(PASS_TOP_MPS, this.paceOf(v) + PASS_BOOST_MPS)
      : this.hangsBack(v)
        ? this.paceOf(v) * HANG_BACK_PACE
        : this.paceOf(v);
    const room = Math.min(
      toCrossing,
      Math.max(0, Math.min(this.gapAhead(v), this.trafficAhead[v.id]!) - MIN_GAP_M),
    );
    let target = Math.min(
      pace,
      this.zoneLimit(v),
      bendSpeed(route, v.s),
      Math.sqrt(2 * BRAKE_MPS2 * room),
    );
    if (toHalt < Infinity) {
      target = Math.min(target, Math.max(CREEP_MPS, Math.sqrt(2 * BRAKE_MPS2 * toHalt)));
    }
    if (toFuel < toStop || (!mayStop && toFuel < Infinity)) {
      target = Math.min(target, Math.max(CREEP_MPS, Math.sqrt(2 * BRAKE_MPS2 * toFuel)));
    }
    // Accelerate gently; braking follows the curve above, which is smooth.
    v.speedMps = target > v.speedMps ? Math.min(target, v.speedMps + ACCEL_MPS2 * dtS) : target;
    // Never drive through the jeepney ahead in the same direction.
    const step = Math.min(v.speedMps * dtS, room);
    v.day.metres += step;
    const standing = step < 0.1 * dtS;
    if (standing) v.day.idleS += dtS; // standing in a queue
    this.burn(v, step, standing ? dtS : 0);
    // Swung out round someone as it got there: it cannot cut in, so on to the next
    // station. Stopping to wait would hold the road for good: it only moves over rolling.
    if (v.refuel && step >= toFuel && v.laneShiftM < -0.5) v.refuel = null;
    // At the station: in to the pumps (or, its forecourt full, waiting in the road at it).
    if (v.refuel && step >= toFuel) {
      if (!this.turnIn(v)) {
        v.speedMps = 0;
        this.steerAround(v, dtS);
      }
      return;
    }

    this.steerAround(v, dtS);
    if (flagged && step >= toFlag) {
      this.serveFlag(v, flag!);
      return;
    }
    const advance = () => {
      v.s = route.loop ? (v.s + step) % route.polyline.length : v.s + v.direction * step;
    };

    if (step < toStop) {
      advance();
      // Held up just short of someone waving it down: they come to it.
      if (flagged && room < toFlag && v.speedMps < CREEP_MPS && toFlag - step <= STOP_ZONE_M) {
        this.serveFlag(v, flag!, v.s);
        return;
      }
      // Held up behind another jeepney: close enough to the stop for riders
      // to walk to it, open the door here instead of waiting in the queue;
      // further back, let off whoever gets off there.
      const heldUp = room < toStop && v.speedMps < CREEP_MPS;
      if (service && heldUp) {
        const gap = toStop - step;
        if (mayStop && gap <= STOP_ZONE_M) this.serveHere(v, false);
        else if (gap <= ALIGHT_ZONE_M && service.dropsAt(v, v.nextStop)) this.serveHere(v, true);
      }
      return;
    }

    if (!stop) return;
    // Nobody to set down or pick up: drive on past it.
    if (service && !mayStop) {
      advance();
      v.nextStop = this.stopAfter(v.nextStop, v.direction);
      return;
    }
    v.s = stop.s;
    v.speedMps = 0;
    v.currentStop = v.nextStop;
    if (this.passengerService) {
      v.dwellS = isTerminalNext ? TERMINAL_DWELL_S : 3;
      this.passengerService.arrive(v, v.currentStop);
    } else if (isTerminalNext) {
      // Everyone gets off at the terminal; the jeepney turns around.
      v.occupancy = 0;
      v.dwellS = TERMINAL_DWELL_S;
    } else {
      const remaining = stopsAhead(route, v.nextStop, v.direction).length;
      const alighting = binomial(this.rng, v.occupancy, 1 / Math.max(1, remaining));
      v.occupancy -= alighting;
      const boarding = Math.min(this.waiting[v.nextStop]!, v.capacity - v.occupancy);
      this.waiting[v.nextStop]! -= boarding;
      v.occupancy += boarding;
      if (alighting + boarding > 0) v.dwellS = 3 + 1.4 * (alighting + boarding);
    }
  }

  /** Whether `v` has come to `s`, or only just gone past it. */
  private reached(v: FleetVehicle, s: number): boolean {
    const d = this.ahead(v, s);
    return d <= 1 || d > this.route.polyline.length / 2;
  }

  /**
   * Vehicle `index` fills up at the station at `s` along the route (on its side,
   * ahead), `litres` of it (a full tank when not given), instead of at the next
   * one it comes to. False if no such station is ahead of it.
   */
  refuelAt(index: number, s: number, litres?: number): boolean {
    const v = this.vehicles[index];
    if (!v || v.yard) return false;
    const there = this.stationsAhead(v).find(({ at }) => this.apartS(at.s, s) < SAME_STATION_M);
    if (!there) return false;
    v.refuel = { s: there.at.inS, name: there.at.name, at: there.at };
    v.refuelLitres = litres ?? null;
    return true;
  }

  /**
   * The road to themselves from now on (a staged scene's few vehicles): every
   * driver at their clear-road pace, whatever the hour, and none hanging back
   * for one far in front, as a route's spread-out fleet would.
   */
  emptyRoad(): void {
    this.cfg = { ...this.cfg, hangBack: false };
    this.roadEmpty = true;
    this.traffic = 1;
  }

  /**
   * Have `v` leave the route along `line` at `enterS` and come back on at
   * `exitS`. False if it is not on the road to do so, or has passed the turn.
   */
  takeWay(index: number, line: Polyline, enterS: number, exitS: number): boolean {
    const v = this.vehicles[index];
    if (!v || v.duty === 'parked' || v.yard || this.reached(v, enterS)) return false;
    v.detour = { line, enterS, exitS, on: false, atM: 0, fromAcross: 0 };
    return true;
  }

  /** Along its way, off the road: nobody's to wait for, until it comes back on. */
  private onDetour(v: FleetVehicle, d: Detour, dtS: number): void {
    // Stopped by the street for someone waiting there: they get on, then on it goes.
    if (v.currentStop !== null) {
      v.day.idleS += dtS;
      this.burn(v, 0, dtS);
      v.speedMps = 0;
      v.dwellS = Math.max(0, v.dwellS - dtS);
      if (v.dwellS > 0 || this.passengerService?.busy(v.id)) return;
      v.currentStop = null;
      this.dropOffOnly.delete(v.id);
      return;
    }
    const rider = this.passengerService?.streetRiderAhead?.(v, d.line, d.atM) ?? null;
    const L = this.route.polyline.length;
    const span = this.route.loop ? aheadOf(this.route, d.enterS, d.exitS) : d.exitS - d.enterS;
    const left = d.line.length - d.atM;
    // Slows for the road it is coming back to, if there is no room on it.
    const blocked =
      left < ROOM_TO_REJOIN_M &&
      this.vehicles.some(
        (o) =>
          o !== v &&
          o.duty !== 'parked' &&
          !o.detour?.on &&
          this.apartS(o.s, d.exitS) < ROOM_TO_REJOIN_M + Math.max(0, this.longer(v, o)),
      );
    let target = blocked ? 0 : SIDE_STREET_MPS;
    // Slowing for someone waving it down by the street.
    if (rider)
      target = Math.min(
        target,
        Math.max(CREEP_MPS, Math.sqrt(2 * BRAKE_MPS2 * (rider.atM - d.atM))),
      );
    v.speedMps =
      target > v.speedMps
        ? Math.min(target, v.speedMps + ACCEL_MPS2 * dtS)
        : Math.max(target, v.speedMps - BRAKE_MPS2 * 2 * dtS);
    const step = Math.min(
      v.speedMps * dtS,
      Math.max(0, left),
      rider ? rider.atM - d.atM : Infinity,
    );
    d.atM += step;
    v.day.metres += step;
    this.burn(v, step, step < 0.1 * dtS ? dtS : 0);
    // Along the route as it goes, unless it comes back on far round it (a
    // U-turn): sweeping round would put it, for a moment, by every stop on the way.
    const s =
      span > TURNED_BACK * d.line.length ? d.enterS : d.enterS + (span * d.atM) / d.line.length;
    v.s = this.route.loop ? ((s % L) + L) % L : s;
    if (rider && d.atM >= rider.atM - 0.05) {
      v.speedMps = 0;
      v.currentStop = v.nextStop;
      v.dwellS = 3;
      this.dropOffOnly.add(v.id);
      this.passengerService!.pickUpFlag!(v, v.currentStop, rider.flagS);
      return;
    }
    if (d.atM < d.line.length) return;
    // Back on the road, in the kerb lane.
    v.detour = null;
    v.s = d.exitS;
    v.nextStop = this.nextStopIndex(v.s, v.direction);
    v.cruiseLaneM = 0;
    v.laneShiftM = 0;
    v.wasAcrossM = 0;
    this.scanLeaders = true;
  }

  /** Stopped at `at` for someone by the road at `s`: its next stop is still to come. */
  private serveFlag(v: FleetVehicle, s: number, at = s): void {
    v.s = at;
    v.speedMps = 0;
    v.currentStop = v.nextStop;
    v.dwellS = 3;
    this.dropOffOnly.add(v.id);
    this.passengerService!.pickUpFlag!(v, v.currentStop, s);
  }

  /** Open the door where `v` stands, short of its next stop (see stepVehicle). */
  private serveHere(v: FleetVehicle, dropOffOnly: boolean): void {
    v.speedMps = 0;
    v.currentStop = v.nextStop;
    v.dwellS = dropOffOnly ? 1 : 3;
    if (dropOffOnly) this.dropOffOnly.add(v.id);
    this.passengerService!.arrive(v, v.currentStop, dropOffOnly);
  }

  /** The stop after stop `i` in `direction` (wrapping round a loop, held at a line's ends). */
  private stopAfter(i: number, direction: 1 | -1): number {
    const n = this.route.stops.length;
    if (this.route.loop) return (i + 1) % n;
    return Math.max(0, Math.min(n - 1, i + direction));
  }

  /** Who is behind whom, sorted once per tick instead of scanning N² pairs. */
  private indexLeaders(): void {
    this.scanLeaders = false;
    this.followers.length = 0;
    this.lanes[0].length = this.lanes[1].length = 0;
    // The spacing the whole fleet would have, parked ones included: a
    // morning terminal spaces its departures for everyone still to come out.
    const L = this.route.polyline.length;
    const all = [0, 0];
    for (const v of this.vehicles) {
      all[v.direction === 1 ? 0 : 1]!++;
      if (v.duty !== 'parked' && !v.detour?.on) this.lanes[v.direction === 1 ? 0 : 1].push(v);
    }
    for (const k of [0, 1] as const) this.spacing[k] = all[k]! > 1 ? L / all[k]! : Infinity;
    for (const lane of this.lanes) {
      lane.sort((a, b) => (a.s - b.s) * a.direction);
      for (let i = 0; i < lane.length; i++) {
        const v = lane[i]!;
        const next = lane[i + 1] ?? (this.route.loop && lane.length > 1 ? lane[0]! : null);
        this.leaders[v.id] = next;
        if (next) this.followers[next.id] = v;
        // Imported/edited states can contain overlaps. Preserve the strict
        // positive-distance rule until those vehicles separate again.
        if (next && next.s === v.s) this.scanLeaders = true;
      }
    }
  }

  /** Whether the road has a lane beside `v` to swing out into: without one it would hit what it passes. */
  private roomToSwing(v: FleetVehicle, o: FleetVehicle | null): boolean {
    if (this.trafficBeside[v.id]) return false;
    if (!this.route.kerbs) return true; // a road of unknown width: as much as it needs
    return laneRoomAt(this.route, v.s) >= v.cruiseLaneM + this.passShift(v, o) - 0.1;
  }

  /** How far `v` swings out to go past `o`: a jeepney's PASS_SHIFT_M, more beside a bus. */
  private passShift(v: FleetVehicle, o: FleetVehicle | null | undefined): number {
    if (!o) return PASS_SHIFT_M;
    return Math.max(
      PASS_SHIFT_M,
      besideM(v.kind ?? 'jeepney', o.kind ?? 'jeepney') + SWING_MARGIN_M,
    );
  }

  /**
   * Whether `v` can drive round `o`: `o` is stopped at a stop where `v` has
   * nobody to set down or pick up. A jeepney swings out past one loading at
   * the kerb rather than queue behind it for a stop it does not need.
   */
  private canPass(v: FleetVehicle, o: FleetVehicle): boolean {
    return (
      o !== v &&
      Math.abs(this.acrossOf(v) - this.acrossOf(o)) < CLEAR_LANE_M &&
      this.roomToSwing(v, o) &&
      o.currentStop !== null &&
      // Double-parked, it already takes the space a passer would swing into.
      o.laneShiftM > -0.5 &&
      !!this.passengerService &&
      !this.passengerService.wantsStop(v, o.currentStop)
    );
  }

  /**
   * Whether `v` need not keep behind `o`: it is driving round `o` stopped
   * at a stop, or overtaking it, or `o` is still out in the road
   * overtaking `v` (the one passed never brakes for the one passing it).
   */
  private ignores(v: FleetVehicle, o: FleetVehicle): boolean {
    // In another lane altogether: it is no one's to wait for. One stopped at
    // the kerb would otherwise hold up every lane of the road behind it.
    const side = Math.abs(this.acrossOf(v) - this.acrossOf(o));
    if (side >= CLEAR_LANE_M) return true;
    // Whatever it is doing, a vehicle physically in the way is not to be driven
    // through: by both their widths (a bus is 2.5 m wide).
    const beside = besideM(v.kind ?? 'jeepney', o.kind ?? 'jeepney');
    if (this.route.kerbs && side < Math.max(SIDE_BY_SIDE_M, beside) && o.laneShiftM < SWUNG_OUT_M)
      return false;
    // Going round `o` only once swung out clear of it: before that, `v`
    // keeps behind it (a jeepney that stops just in front is braked for).
    // (By the two widths only where the road's width is known: elsewhere, across is a guess.)
    const clear = v.laneShiftM <= -SWUNG_OUT_M && (!this.route.kerbs || side >= beside);
    if (o.laneShiftM >= SWUNG_OUT_M) return true; // at the side of the road, out of the lane
    // Overtaking one only while it keeps to its lane: one that has pulled out
    // too (to overtake someone itself) is in the outer lane, in the way.
    return (
      (clear && this.canPass(v, o)) ||
      (clear && this.overtakes.get(v.id)?.of === o.id && o.laneShiftM > -SWUNG_OUT_M) ||
      (this.overtakes.get(o.id)?.of === v.id && v.laneShiftM > -SWUNG_OUT_M)
    );
  }

  /**
   * Whether `v`, done at its stop, waits on there for the jeepney in front
   * to get further away (see ABANG_S, DISPATCH_SHARE). Not when only letting
   * riders off in a queue, short of the stop.
   */
  private waitsForGap(v: FleetVehicle, dtS: number): boolean {
    const stop = v.currentStop!;
    const terminal = this.terminalFor(v, stop);
    const held = this.heldS[v.id] ?? 0;
    if (this.waitsForRiders(v, stop)) {
      this.heldS[v.id] = held + dtS;
      if (Math.floor((held + dtS) / REBOARD_EVERY_S) > Math.floor(held / REBOARD_EVERY_S))
        this.passengerService?.pickUp(v, stop);
      return true;
    }
    const o = this.leaders[v.id];
    const close =
      this.cfg.hangBack !== false &&
      !!o &&
      o !== v &&
      this.distance(v, o) <
        (terminal ? DISPATCH_SHARE : HANG_BACK_SHARE) * this.spacing[v.direction === 1 ? 0 : 1];
    const filling = terminal && !!this.cfg.dayCycle && v.occupancy < PILA_FILL * v.seats;
    if (held === 0)
      this.pilaWaitS[v.id] =
        PILA_WAIT_MIN_S + this.driverRng() * (PILA_WAIT_MAX_S - PILA_WAIT_MIN_S);
    // A long line behind: the dispatcher keeps it moving rather than let the
    // head fill (else the last in a line of 30 waits over an hour, and the
    // road goes without jeepneys).
    const limit = terminal
      ? this.lineBehind(v) >= LONG_LINE
        ? Math.min(this.pilaWaitS[v.id]!, LINE_DISPATCH_S)
        : this.pilaWaitS[v.id]!
      : ABANG_S;
    if (
      v.duty !== 'service' ||
      this.dropOffOnly.has(v.id) ||
      !(close || filling) ||
      held >= limit
    ) {
      this.heldS[v.id] = 0;
      return false;
    }
    this.heldS[v.id] = held + dtS;
    // Newcomers get on.
    const due = Math.floor((held + dtS) / REBOARD_EVERY_S) > Math.floor(held / REBOARD_EVERY_S);
    if (due && v.occupancy < v.capacity && (this.waiting[stop] ?? 0) > 0)
      this.passengerService?.pickUp(v, stop);
    return true;
  }

  /**
   * Whether `v` waits on at `stop` for riders on their way (waitFor): until
   * its time is up, it is full, or nobody is still coming or waiting there.
   * Time up with someone a few steps off, it waits for them (LATE_GRACE_S).
   */
  private waitsForRiders(v: FleetVehicle, stop: number): boolean {
    const hold = this.holds.get(v.id);
    if (!hold || hold.stop !== stop) return false;
    const service = this.passengerService;
    const coming = service?.comingTo?.(v, stop) ?? 0;
    const over = this.elapsedS - hold.untilS;
    const almostThere =
      over >= 0 &&
      over < LATE_GRACE_S &&
      (service?.comingTo?.(v, stop, LATE_GRACE_S - over) ?? 0) > 0;
    if (
      (over >= 0 && !almostThere) ||
      v.occupancy >= v.capacity ||
      (coming === 0 && (this.waiting[stop] ?? 0) === 0)
    ) {
      this.holds.delete(v.id);
      return false;
    }
    return true;
  }

  /**
   * Vehicle `index` stops at `stop`, its next, and waits there for riders on
   * their way to it, for at most `forS` seconds from now (the drive there
   * included). Its driver's call, asked of Muse.
   */
  waitFor(index: number, stop: number, forS: number): void {
    const v = this.vehicles[index];
    if (!v) return;
    this.holds.set(v.id, { stop, untilS: this.elapsedS + forS });
  }

  /** How many jeepneys stand in line right behind `v` (each within a car length or so of the next). */
  private lineBehind(v: FleetVehicle): number {
    let n = 0;
    let front = v;
    for (let u = this.followers[v.id]; u && u !== v && n < LONG_LINE; u = this.followers[u.id]) {
      if (u.speedMps > 0.5 || this.distance(u, front) > MIN_GAP_M + 12) break;
      n++;
      front = u;
    }
    return n;
  }

  /**
   * Whether `v`'s driver hangs back: the jeepney in front is close (see
   * HANG_BACK_SHARE) and going at a normal pace. One crawling well below
   * `v`'s pace is for overtaking instead.
   */
  private hangsBack(v: FleetVehicle): boolean {
    if (this.cfg.hangBack === false || v.duty !== 'service') return false;
    const o = this.leaders[v.id];
    if (!o || o === v) return false;
    if (o.currentStop === null && o.speedMps < this.paceOf(v) - SLOWER_BY_MPS) return false;
    return this.distance(v, o) < HANG_BACK_SHARE * this.spacing[v.direction === 1 ? 0 : 1];
  }

  /**
   * Start, finish or give up overtaking a slower moving jeepney (stopped
   * ones are canPass's). `toOwnStop`: how far the stop `v` will stop at is.
   */
  private overtake(v: FleetVehicle, toOwnStop: number, dtS: number): void {
    const on = this.overtakes.get(v.id);
    if (on) {
      const o = this.vehicles[on.of]!;
      const ahead = this.distance(o, v);
      // Past it with room to cut in (ahead of it, not a lap behind it).
      const past =
        ahead >= MERGE_AHEAD_M + this.longer(v, o) && ahead < this.route.polyline.length / 2;
      const stuck = this.elapsedS - on.sinceS > PASS_GIVE_UP_S || o.currentStop !== null;
      // Never give up alongside it: once level, the overtake is finished.
      if (past || (stuck && this.apart(v, o) >= ALONGSIDE_M + this.longer(v, o))) {
        this.overtakes.delete(v.id);
        this.calmUntil[v.id] = this.elapsedS + CALM_S * (1.5 - v.boldness);
      }
      return;
    }
    if (this.cfg.overtaking === false || (this.calmUntil[v.id] ?? 0) > this.elapsedS) return;
    // The one ahead of it in its own lane: what is ahead in another is no one's to pass.
    const o = this.leaderOf(v);
    if (!o || o === v || o.currentStop !== null || this.overtakes.has(o.id)) return;
    // Not while someone is passing this one: it would pull out into them.
    for (const x of this.overtakes.values()) if (x.of === v.id) return;
    if (this.distance(v, o) > CATCH_UP_M) return;
    if (o.speedMps > this.paceOf(v) - SLOWER_BY_MPS) return;
    if (toOwnStop < OWN_STOP_CLEAR_M) return;
    for (const x of this.overtakes.values()) if (x.of === o.id) return;
    const beyond = this.leaders[o.id];
    if (beyond && beyond !== v && this.distance(o, beyond) < ROOM_AHEAD_M) return;
    if (!this.straightAhead(v) || !this.roomToSwing(v, o) || !this.outerFree(v)) return;
    // The driver: most sit behind for a while, the bold pull out at once.
    if (this.driverRng() >= v.boldness * v.boldness * PULL_OUT_PER_S * dtS) return;
    this.overtakes.set(v.id, { of: o.id, sinceS: this.elapsedS });
  }

  /** Whether the road ahead of `v` is straight enough to overtake on. */
  private straightAhead(v: FleetVehicle): boolean {
    const line = this.route.polyline;
    const L = line.length;
    const far = v.s + v.direction * STRAIGHT_M;
    if (!this.route.loop && (far < 0 || far > L)) return false;
    const turn = line.headingAt((far + L) % L, 10) - line.headingAt(v.s, 10);
    return Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))) < STRAIGHT_RAD;
  }

  /** The jeepney `v` must keep behind: the one ahead, skipping any it can pass. */
  private leaderOf(v: FleetVehicle): FleetVehicle | null {
    let leader = this.leaders[v.id] ?? null;
    for (let hops = 0; leader && hops < LOOK_ALONG_LANE && this.ignores(v, leader); hops++)
      leader = this.leaders[leader.id] ?? null;
    return leader === v ? null : leader;
  }

  /** How far over from the kerb lane `v` is now (metres). */
  acrossOf(v: FleetVehicle): number {
    return Math.min(v.cruiseLaneM - v.laneShiftM, laneRoomAt(this.route, v.s));
  }

  /** Note `v` reaching a stop, and how long the road there took (see stopToStopS). */
  private noteStopToStop(v: FleetVehicle): void {
    const was = this.lastStop[v.id];
    if (v.duty !== 'service' || !this.route.loop) {
      this.lastStop[v.id] = null;
      return;
    }
    if (!was) {
      this.lastStop[v.id] = { next: v.nextStop, at: this.elapsedS };
      return;
    }
    if (v.nextStop === was.next) return;
    const reached = was.next;
    // Only from the stop before it: not a vehicle that has just joined the road.
    if (this.stopAfter(reached, v.direction) === v.nextStop && was.at >= 0) {
      const taken = this.elapsedS - was.at;
      const known = this.stopToStopS[reached]!;
      this.stopToStopS[reached] = known > 0 ? known + (taken - known) * LEARN_SHARE : taken;
    }
    was.next = v.nextStop;
    was.at = this.elapsedS;
  }

  /** Half the extra length of `a` and `b` over two jeepneys (negative for a van). */
  private longer(a: FleetVehicle, b: FleetVehicle): number {
    return (lengthOf(a.kind) + lengthOf(b.kind)) / 2 - JEEPNEY_LENGTH_M;
  }

  /**
   * Distance to the one ahead `v` keeps behind, as if both were jeepneys
   * (less the extra length of a longer one): what MIN_GAP_M is kept from.
   */
  private gapAhead(v: FleetVehicle): number {
    if (!this.scanLeaders) {
      const leader = this.leaderOf(v);
      if (!leader) return Infinity;
      // Read the live position, retaining the existing sequential step order.
      const d = this.route.loop
        ? aheadOf(this.route, v.s, leader.s)
        : (leader.s - v.s) * v.direction;
      return d - this.longer(v, leader);
    }
    let gap = Number.POSITIVE_INFINITY;
    for (const o of this.vehicles) {
      if (o === v || o.duty === 'parked' || o.detour?.on) continue;
      if (o.direction !== v.direction || this.ignores(v, o)) continue;
      const d = this.route.loop ? aheadOf(this.route, v.s, o.s) : (o.s - v.s) * v.direction;
      if (d > 0 && d - this.longer(v, o) < gap) gap = d - this.longer(v, o);
    }
    return gap;
  }

  /**
   * Swing out while overtaking, or going past a stopped jeepney (from just
   * before it to just after), and back in once clear, smoothly. Back in
   * only where the lane is free: a jeepney that had to stop beside another
   * stays double-parked rather than drive onto it.
   */
  /** The least room across the road (laneRoomAt) from `v` to NARROWING_SEEN_M ahead of it. */
  private roomAhead(v: FleetVehicle): number {
    const L = this.route.polyline.length;
    let room = laneRoomAt(this.route, v.s);
    for (let d = NARROWING_STEP_M; d <= NARROWING_SEEN_M; d += NARROWING_STEP_M) {
      const s = v.s + v.direction * d;
      if (!this.route.loop && (s < 0 || s > L)) break;
      room = Math.min(room, laneRoomAt(this.route, this.route.loop ? ((s % L) + L) % L : s));
    }
    return room;
  }

  /** Towards `v`'s own lane, or the kerb when it `wantsKerb`. Only where the road has the room. */
  private keepLane(v: FleetVehicle, wantsKerb: boolean, dtS: number, withinS = Infinity): void {
    // Swung out alongside someone, it holds its lane until it is back: the way
    // to the kerb goes through them.
    if (wantsKerb && v.laneShiftM < -0.5) return;
    // A road narrowing just ahead is seen coming: it moves in before it gets there.
    const room = this.roomAhead(v);
    const lane = wantsKerb ? 0 : Math.min(homeLane(v.id) * LANE_M, room);
    // Only into a lane that is free: no one may be alongside on the way there.
    if (!this.mayMoveAcross(v, lane)) return;
    const needed = v.cruiseLaneM / Math.max(withinS, 0.01);
    // Unhurried, it moves over gently at any speed (pulling out of a forecourt at
    // walking pace, say); a stop coming up with no warning, or the road
    // narrowing, takes the steepest.
    const squeezed = room < v.cruiseLaneM;
    const steepest = squeezed || needed > LANE_CHANGE_MPS ? MOST_ACROSS_PER_M : GENTLE_ACROSS_PER_M;
    const rate = Math.min(
      HURRIED_LANE_CHANGE_MPS,
      v.speedMps * steepest,
      Math.max(LANE_CHANGE_MPS, needed),
    );
    const change = Math.max(-rate * dtS, Math.min(rate * dtS, lane - v.cruiseLaneM));
    v.cruiseLaneM += change;
  }

  /** Whether nobody is alongside `v` between the lane it is in and lane `to`. */
  private mayMoveAcross(v: FleetVehicle, to: number): boolean {
    if (Math.abs(to - v.cruiseLaneM) < 0.05) return true;
    const from = this.acrossOf(v);
    const side = Math.sign(to - v.cruiseLaneM);
    for (const next of [this.leaders, this.followers]) {
      let u = next[v.id];
      for (let hop = 0; u && u !== v && hop < LOOK_ALONG_LANE; hop++, u = next[u.id]) {
        const reach = ALONGSIDE_M + Math.max(0, this.longer(v, u));
        if (this.apart(v, u) >= reach) break;
        if (u.direction !== v.direction) continue;
        const over = (this.acrossOf(u) - from) * side;
        if (over > 0.1 && over < CLEAR_LANE_M + 0.1) return false;
      }
    }
    return true;
  }

  private steerAround(v: FleetVehicle, dtS: number): void {
    const moving = v.currentStop === null;
    let passing = moving && this.overtakes.has(v.id);
    const ahead = this.leaders[v.id];
    if (moving && !passing && ahead && this.canPass(v, ahead))
      passing = this.distance(v, ahead) < PASS_WINDOW_AHEAD_M;
    const behind = this.followers[v.id];
    if (moving && !passing && behind && behind.currentStop !== null)
      passing = this.distance(behind, v) < PASS_WINDOW_BEHIND_M && v.laneShiftM < -0.1;
    const passed = this.overtakes.has(v.id) ? this.vehicles[this.overtakes.get(v.id)!.of] : ahead;
    let target = passing ? -this.passShift(v, passed) : 0;
    if (target > v.laneShiftM && !this.laneFree(v)) target = v.laneShiftM;
    if (target < v.laneShiftM && !this.outerFree(v)) target = v.laneShiftM;
    // Only while rolling, as the wheels allow: nothing slides sideways.
    const step = Math.min(LANE_SHIFT_MPS, v.speedMps * MOST_ACROSS_PER_M) * dtS;
    v.laneShiftM += Math.max(-step, Math.min(step, target - v.laneShiftM));
  }

  /**
   * The nose comes round to however `v` is moving across the road, and back,
   * as it rolls forward: per metre driven, so a slow lane change (pulling out
   * of a forecourt, say) points the way it goes as much as a fast one.
   */
  private turnNose(v: FleetVehicle, dtS: number): void {
    const across = v.cruiseLaneM - v.laneShiftM;
    const forward = v.speedMps * dtS;
    // In a forecourt it points along its way through (atStation).
    if (forward > 1e-3 && !v.yard) {
      const slope = (across - v.wasAcrossM) / forward;
      v.noseAcross += (slope - v.noseAcross) * Math.min(1, forward * NOSE_EASE_PER_M);
    }
    v.wasAcrossM = across;
  }

  /**
   * Whether `v` can move out towards the middle of the road: no jeepney
   * further out is alongside it, or coming up behind it within COMING_UP_M
   * (one overtaking, say). It waits, as a driver checks the mirror.
   */
  private outerFree(v: FleetVehicle): boolean {
    for (const [next, reach] of [
      [this.leaders, ALONGSIDE_M],
      [this.followers, ALONGSIDE_M + COMING_UP_M],
    ] as const) {
      let u = next[v.id];
      for (let hop = 0; u && u !== v && hop < PASS_AT_MOST; hop++, u = next[u.id]) {
        if (this.apart(v, u) >= reach + this.longer(v, u)) break;
        if (u.direction !== v.direction) continue;
        // Anyone between here and as far out as it would swing, and a car's width past that.
        const out = this.acrossOf(u) - this.acrossOf(v);
        if (out > 0.05 && out < PASS_SHIFT_M + SWING_CLEAR_M) return false;
      }
    }
    return true;
  }

  /**
   * Whether `v` can move in towards the kerb: no jeepney alongside it is
   * further in than it is. Only neighbours in driving order can be alongside.
   */
  private laneFree(v: FleetVehicle): boolean {
    for (const next of [this.leaders, this.followers]) {
      let u = next[v.id];
      for (let hop = 0; u && u !== v && hop < PASS_AT_MOST; hop++, u = next[u.id]) {
        if (this.apart(v, u) >= ALONGSIDE_M + this.longer(v, u)) break;
        if (u.direction === v.direction && u.laneShiftM > v.laneShiftM - 0.05) return false;
      }
    }
    return true;
  }

  /** How far apart `a` and `b` are along the road, whichever is in front. */
  private apart(a: FleetVehicle, b: FleetVehicle): number {
    if (!this.route.loop) return Math.abs(b.s - a.s);
    return Math.min(aheadOf(this.route, a.s, b.s), aheadOf(this.route, b.s, a.s));
  }

  /** How far `b` is ahead of `a` along their direction of travel. */
  private distance(a: FleetVehicle, b: FleetVehicle): number {
    return this.route.loop ? aheadOf(this.route, a.s, b.s) : (b.s - a.s) * a.direction;
  }

  private nextStopIndex(s: number, direction: 1 | -1): number {
    const stops = this.route.stops;
    if (direction === 1) {
      const i = stops.findIndex((st) => st.s >= s);
      // Past the last stop: on a loop the next one is the first, round again.
      return i === -1 ? (this.route.loop ? 0 : stops.length - 1) : i;
    }
    for (let i = stops.length - 1; i >= 0; i--) if (stops[i]!.s <= s) return i;
    return 0;
  }
}

function binomial(rng: Rng, n: number, p: number): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (rng() < p) k++;
  return k;
}
