import {
  BRAKE_MPS2,
  JEEPNEY_LENGTH_M,
  type FleetSim,
  type FleetVehicle,
  type PassengerService,
} from '../fleet/fleetSim';
import { aheadOf, isTerminal, stopsAhead, type Route } from '../geo/routes';
import { discountedKind, FARE_BY_VEHICLE, fareFor, type RiderKind } from '../fare';
import type { FleetKind } from '../vehicles/specs';
import { stopRoles, stopsAheadFor } from '../vehicles/stops';
import { createRng } from '../math/random';
import { newRiderPose, RiderMotion, type RiderPose, type Seat } from './riderMotion';
import type { LocalPoint } from '../geo/projection';
import type { Polyline } from '../geo/polyline';
import { alongFrom, leavingSpot, pavementPoint, roadsidePoint, waitingSpot } from './stopLayout';
import type { ApproachMode } from '../advisory/model';
import { crossingsOf, RoadIndex, type Crossing, type CrossingPass } from './crossing';
import { viaZebra, zebrasOf, type Zebra } from './zebra';
import { onwardLine } from './onward';
import { STOP_NEAR_M, wayLine, type Catchments, type Lane } from './streetGraph';
import type { StreetWay } from './streetWay';
import { stopsByTheRoad, VEHICLES } from '../vehicles/specs';
import { COMMUTE_BY_HOUR, LAST_RIDERS_S } from '../fleet/scenario';
import { BASE_MIX, calibrate, drawKind, mixAt, schoolStop, type Mix } from './riderMix';

/** Someone this close to a side street a vehicle drives is by it, to be picked up (metres). */
const BY_THE_STREET_M = 12;

/** Someone coming to cross the road is seen by drivers this long before the kerb (seconds). */
const HAIL_S = 4;
/** A vehicle stops this far short of the line where someone crosses (metres)… */
const YIELD_GAP_M = 3;
/** …and nobody steps out with a vehicle's end this close to the line (metres). */
const LINE_CLEAR_M = 1.5;
/** A driver sees someone this far ahead, waiting to cross or crossing (metres). */
const CROSSING_LOOK_M = 120;
/** Past a vehicle's side by this much (metres), someone crossing is out of its way. */
const LANE_CLEAR_M = 1;
/** A traditional jeepney's width (metres; jeepneyGeometry). */
const JEEPNEY_WIDTH_M = 2.2;
/**
 * Drivers wait for someone at the kerb for CROSSING_ASK_S out of every
 * CROSSING_CYCLE_S: two people waiting on vehicles held for each other would
 * otherwise wait for ever. Nobody passes someone already on the road.
 */
const CROSSING_CYCLE_S = 40;
const CROSSING_ASK_S = 30;
/** A vehicle slower than this is standing (m/s)… */
const STANDING_MPS = 0.3;
/** …and with one on their line this long (seconds) someone goes along the kerb for a gap… */
const GO_ROUND_AFTER_S = 5;
/** …looking this often along it (metres)… */
const GAP_STEP_M = 3;
/** …this far at most either way (metres). */
const GAP_LOOK_M = 45;

/** New people fade in over this as they walk up to the stop. */
const FADE_IN_S = 0.8;
/** Arrived people stand a moment at the stop, then fade out and are gone. */
const LINGER_S = 2.5;
const FADE_OUT_S = 1.5;
/** Someone who has just stepped off is still in the doorway for this long. */
const CLEAR_DOOR_S = 1.2;
/**
 * Boarders climb in this far apart: one person on the step at a time, as at
 * a real jeepney's back, but the next is already right behind them.
 */
const DOOR_HEADWAY_S = 1.4;
/** Newcomers walk in along the pavement from this far up or down the road… */
const WALK_IN_M = 15;
/**
 * …except this share, who come from further away: FIRST_MILE_MIN_M to
 * FIRST_MILE_MAX_M along the road, the drivers and the operator seeing them
 * on the way. Beyond TRICYCLE_FROM_M, TRICYCLE_SHARE of them take a tricycle.
 * Assumptions, not survey figures.
 */
const FIRST_MILE_SHARE = 0.35;
const FIRST_MILE_MIN_M = 100;
const FIRST_MILE_MAX_M = 500;
const TRICYCLE_FROM_M = 250;
const TRICYCLE_SHARE = 0.5;

/** Rider `id`'s own draw `k`, 0–1: fixed by id, so it takes nothing from the shared stream. */
function idDraw(id: number, k: number): number {
  const u = (Math.imul(id + 1, 0x85ebca6b) ^ Math.imul(k, 0xc2b2ae35)) >>> 0;
  return (Math.imul(u ^ (u >>> 15), 0x2c1b3c6d) >>> 0) / 4_294_967_296;
}

/**
 * Rider `id`'s first mile when the streets are not known (no map): along
 * the route's pavement, fixed by id. Null for a walk-in.
 */
export function firstMileOf(id: number): { metres: number; mode: ApproachMode } | null {
  if (idDraw(id, 1) >= FIRST_MILE_SHARE) return null;
  const metres = FIRST_MILE_MIN_M + idDraw(id, 2) * (FIRST_MILE_MAX_M - FIRST_MILE_MIN_M);
  const mode = metres > TRICYCLE_FROM_M && idDraw(id, 3) < TRICYCLE_SHARE ? 'tricycle' : 'walk';
  return { metres, mode };
}

/**
 * With the streets known (setStreets), everyone comes from a place of their
 * own on the streets around their stop (Catchments.place: as many as live
 * there), out to tricycle range. Up to WALK_ALL_M everyone walks; from there
 * to TRICYCLE_ALL_M more and more take a tricycle; beyond it, everyone does.
 */
const WALK_ALL_M = 400;
const TRICYCLE_ALL_M = 900;

/** On foot or by tricycle, for `metres` to or from the stop (rider `id`'s draw `k`). */
function modeFor(id: number, k: number, metres: number): ApproachMode {
  const tricycle = (metres - WALK_ALL_M) / (TRICYCLE_ALL_M - WALK_ALL_M);
  return idDraw(id, k) < tricycle ? 'tricycle' : 'walk';
}

/** Where on the street rider `id` goes by `mode`: a tricycle in its lane, on foot either edge (their own). */
function laneFor(id: number, mode: ApproachMode): Lane {
  if (mode === 'tricycle') return 'drive';
  return idDraw(id, 14) < 0.5 ? 'left' : 'right';
}

/** Along `path` on foot, or seated in a tricycle. */
function firstMile(mode: ApproachMode, path: readonly Point3[]): RiderMotion {
  return mode === 'tricycle' ? RiderMotion.tricycle(path) : RiderMotion.walking(path);
}

/**
 * Where people get off, relative (assumption): the ends of the line, malls
 * and markets draw the most; a school draws students on their way there in
 * the morning.
 */
const TERMINAL_PULL = 4;
const PLACE_PULL = 2.5;
const SCHOOL_PULL = 1.5;
const STUDENT_TO_SCHOOL = 4;
const PLACE = /SM|mall|market|palengke|plaza|hospital/i;

/** A spot picked on the map joins the streets at the nearest street point within this (metres)… */
const FROM_STREET_M = 250;
/** …and without streets, the nearest stop is at most this far off (metres): a tricycle ride. */
const MAX_FIRST_MILE_M = 3000;

/** Where the commuter app's own rider boards, from a spot on the map (firstMileFrom). */
export interface FirstMile {
  stop: number;
  direction: 1 | -1;
  /** Metres from the spot to the stop, the way they will go. */
  metres: number;
  from: LocalPoint;
  /** The street point they join the streets at; -1 when going straight. */
  node: number;
}

/**
 * The commute: whoever rides before MORNING_UNTIL_S is going to work (or
 * school) and, RETURN_SHARE of them, comes back the same way in the evening.
 * Each leaves work at a time of their own from 5 PM (LEAVE_WORK, by hour
 * from 5 PM, most early in the evening) until the last riders of the day
 * (LAST_RIDERS_S, 10:45 PM), and is home by about 11 PM; nobody waits at a
 * stop before the jeepneys run.
 */
const MORNING_UNTIL_S = 13 * 3600;
const RETURN_SHARE = 0.85;
const LEAVE_WORK = [2, 2, 1.5, 1.1, 0.8, 0.45];
const LEAVE_FROM_S = 17 * 3600;
/** Changing jeepneys at a terminal on the way home is worth this much walking to avoid (metres). */
const TRANSFER_M = 400;

/** When rider `id` leaves work, seconds since midnight (before the last riders of the day). */
function leaveWorkAt(id: number): number {
  const total = LEAVE_WORK.reduce((a, b) => a + b, 0);
  let u = idDraw(id, 40) * total;
  let hour = 0;
  while (hour < LEAVE_WORK.length - 1 && u >= LEAVE_WORK[hour]!) u -= LEAVE_WORK[hour++]!;
  const at = LEAVE_FROM_S + (hour + idDraw(id, 41)) * 3600;
  return at < LAST_RIDERS_S ? at : LEAVE_FROM_S + (LAST_RIDERS_S - LEAVE_FROM_S) * idDraw(id, 42);
}

/** Someone at work, to go home this evening. */
interface Return {
  /** When they leave work (seconds since midnight). */
  dueS: number;
  /** The stop they board at: the least walk from work (see planReturn). */
  stop: number;
  direction: 1 | -1;
  /** The stop to get off at: the least walk home. */
  homeStop: number;
  /** A terminal to change jeepneys at on the way, when none goes all the way. */
  via?: number;
  homeNode: number;
  /** Their workplace (street node), where they walk from. */
  awayNode: number;
  /** Who they are: the same person as this morning. */
  kind: RiderKind;
}
/**
 * A driver who sees someone hurrying to the stop waits for them, when there
 * is a seat: anyone this many seconds or less from the stop…
 */
const RUNNER_WITHIN_S = 5;
/** …but no longer than this in all, or a busy stop would never let them go. */
const MAX_HOLD_S = 12;

export type PassengerPhase =
  'approaching' | 'waiting' | 'boarding' | 'seated' | 'alighting' | 'walking' | 'arrived';
export interface VehiclePose {
  x: number;
  z: number;
  heading: number;
}
type Point3 = readonly [number, number, number];

/** Vehicle geometry adapter: journey logic has no fixed seat count or door orientation. */
export interface PassengerLayout {
  /** Every place to ride: the seats, then any places to stand or hang on (Seat.stands). */
  seats: readonly Seat[];
  /** The order they are taken: every seat before anyone stands. */
  seatOrder: readonly number[];
  /** Riding still in place `seat`, sitting or standing. */
  seated(seat: number, out: RiderPose): RiderPose;
  board(seat: number, start: Point3): RiderMotion;
  alight(seat: number): RiderMotion;
  /** From standing place `from` to `seat`, which has come free. */
  takeSeat(from: number, seat: number): RiderMotion;
  isInside(pose: RiderPose): boolean;
}

/** Where the commuter app's own rider goes from the stop they get off at. */
export interface Onward {
  way: StreetWay;
  mode: ApproachMode;
  /** Where they end up, when that is not where the way ends (it ends in the road). */
  to: LocalPoint;
}

export interface Passenger {
  id: number;
  originStop: number;
  destinationStop: number;
  direction: 1 | -1;
  phase: PassengerPhase;
  vehicleId: number | null;
  lastVehicleId: number | null;
  seat: number | null;
  /**
   * The seat beside a pregnant rider's, kept empty so she has room: one place
   * fewer on board while she rides. Null when none was free beside her.
   */
  room?: number | null;
  /** Where they stand while waiting at the stop (null once they board). */
  spot: LocalPoint | null;
  inside: boolean;
  /** World pose outside; vehicle-local while boarding, riding or alighting. */
  pose: RiderPose;
  motion: RiderMotion | null;
  t: number;
  history: { phase: PassengerPhase; at: number }[];
  /** First-mile travel mode; generated demand walks unless explicitly set. */
  approachMode?: ApproachMode;
  /** How they go on from the stop they get off at (a tricycle when far). */
  leaveMode?: ApproachMode;
  /** Going to work (and back tonight), or home from work; neither for other trips. */
  tour?: 'out' | 'back';
  /** Home, a street node (see setStreets): where an out trip started, a back trip ends. */
  homeNode?: number;
  /** Changing at a terminal on the way home: the stop to ride on to from there. */
  thenTo?: number;
  /** The vehicle whose driver passed them on to the next one: they do not get back on it. */
  passedOn?: number;
  /**
   * Who they are: as they said (the commuter app's own rider), else drawn
   * when they set out, by the hour, day and stop (riderMix.ts); riderKindOf(id) if unset.
   */
  kind?: RiderKind;
  /**
   * Going straight to the stop from a spot on the map, the streets not
   * known yet: put on the streets from where they are once they are (setStreets).
   */
  offStreets?: boolean;
  /** The commuter app's own rider: their way to the stop, as they go it (drawn on the map). */
  way?: readonly Point3[];
  /**
   * Waiting at the side of the road this far along the route, not at a stop,
   * as people do: any vehicle going their way with a seat stops for them
   * there. `originStop` is then the stop after that spot.
   */
  flagS?: number;
  /**
   * Waiting by a side street off the route, not by the route itself: only a
   * vehicle driving that street (a way round, fleetSim.ts takeWay) sees them
   * and takes them on. `flagS` is then where along the route that street is.
   */
  byStreet?: boolean;
  /** The commuter app's own rider: where they go from the stop they get off at. */
  onward?: Onward;
  /** Where their way goes over the road, still to come (crossing.ts), and the way that is of. */
  crossings?: Crossing[];
  crossingsOf?: RiderMotion;
}

/**
 * A synthetic first-mile path along the pavement. Sample bends instead of
 * cutting across them; beyond a line terminal extend its tangent. The path
 * has the requested length and is illustrative, not a surveyed walking route.
 */
function approachPath(
  route: Route,
  stop: number,
  direction: 1 | -1,
  target: LocalPoint,
  metres: number,
): Point3[] {
  const targetAlong = alongFrom(route, stop, direction, target);
  const base = pavementPoint(route, stop, direction, targetAlong, 2);
  const reversed: Point3[] = [[target.x, 0, target.z]];
  let remaining = metres;
  for (let back = 5; remaining > 1e-8; back += 5) {
    const along = targetAlong - back;
    const p = pavementPoint(route, stop, direction, along, 2);
    if (!route.loop) {
      const s = route.stops[stop]!.s + along * direction;
      const clamped = Math.max(0, Math.min(route.polyline.length, s));
      const heading = route.polyline.headingAt(clamped, 4.3);
      p.x += (s - clamped) * Math.cos(heading);
      p.z -= (s - clamped) * Math.sin(heading);
    }
    p.x += target.x - base.x;
    p.z += target.z - base.z;
    const previous = reversed[reversed.length - 1]!;
    const length = Math.hypot(p.x - previous[0], p.z - previous[2]);
    if (length < 1e-8) continue;
    const fraction = Math.min(1, remaining / length);
    reversed.push([
      previous[0] + (p.x - previous[0]) * fraction,
      0,
      previous[2] + (p.z - previous[2]) * fraction,
    ]);
    remaining -= length * fraction;
  }
  return reversed.reverse();
}

interface Service {
  stop: number;
  exits: number[];
  boarders: number[] | null;
  active: number | null;
  terminal: boolean;
  turned: boolean;
  /** Seconds spent holding for people hurrying to the stop. */
  heldS: number;
  /** Seconds lined up at its terminal waiting to fill (FILL). */
  fillS: number;
  /** Stopped by the road at this point of the route, short of `stop`, for whoever waits there. */
  flagS?: number;
  /** When the next boarder may reach the step (the one before is in by then). */
  doorFreeAt: number;
  /** The head of the queue's boarding, worked out once while they wait their turn. */
  next: {
    id: number;
    seat: number;
    room: number | null;
    /** Who moves over (pakiusog) to free the seat beside a pregnant rider, and to where. */
    usog?: { id: number; to: number };
    motion: RiderMotion;
    inAfterS: number;
  } | null;
  /** False when letting riders off in a queue short of the stop: nobody gets on there. */
  pickup: boolean;
  /** Whoever was standing has taken any seats freed at this stop. */
  sat: boolean;
  /** For the stop log: riders off and on, and the fares they paid (centavos). */
  off: number;
  on: number;
  fareCentavos: number;
}

/** One stop a jeepney made, for the operator's log (see PassengerSystem.log). */
export interface StopEvent {
  /** Seconds into the simulated day when it pulled away (FleetSim.elapsedS). */
  atS: number;
  vehicle: number;
  stop: number;
  off: number;
  on: number;
  fareCentavos: number;
}
/** Stop events kept: a busy hour of a 60-jeepney route; older ones are dropped. */
const LOG_KEEP = 5000;

/** Who rides and waits where, as of one tick (see tripsNow). */
interface Trips {
  at: number;
  aboard: Map<number, number>;
  gettingOff: Map<number, Set<number>>;
  waiting: Map<number, Passenger[]>;
  /** Those waiting by the road, not at a stop (Passenger.flagS). */
  flagging: Passenger[];
  /** Jeepneys whose doorway is in use by someone getting off. */
  doorBusy: Set<number>;
  /** Jeepneys with someone on the step (getting off, or not yet in). */
  onStep: Set<number>;
  /** People at the kerb or on the road, drivers giving way. */
  crossing: Crossing[];
}

/**
 * Who a rider is, for their fare, from the day's average mix (BASE_MIX: 65%
 * regular, 20% student, 8% senior, 5% PWD, 2% pregnant), fixed by id. The
 * twin's riders are drawn by the hour, day and stop instead (riderMix.ts).
 * Students, seniors and PWD pay 20% less; pregnancy alone is no discount.
 */
export function riderKindOf(id: number): RiderKind {
  return drawKind(BASE_MIX, (Math.imul(id + 1, 0x9e3779b1) >>> 0) / 4_294_967_296);
}

export const riderDiscounted = (id: number): boolean => discountedKind(riderKindOf(id));

/** Who `r` is: as they said (the commuter app's own rider), else as drawn. */
export const kindOf = (r: Passenger): RiderKind => r.kind ?? riderKindOf(r.id);

/** A seat this close to another, facing the same way, is next to it (metres). */
const NEXT_SEAT_M = 1;

/** A rider's fare in centavos, from where they got on to where they get off. */
/** What rider `r` pays for the ride, by the vehicle's own fare rule (fare.ts). */
function fareCentavosFor(route: Route, r: Passenger, vehicle: FleetKind): number {
  const a = r.flagS ?? route.stops[r.originStop]!.s;
  const b = route.stops[r.destinationStop]!.s;
  const metres = route.loop ? aheadOf(route, a, b) : Math.abs(b - a);
  return Math.round(
    fareFor(metres / 1000, discountedKind(kindOf(r)), FARE_BY_VEHICLE[vehicle]) * 100,
  );
}

/**
 * Whether `v` takes riders on at `stop` (core/vehicles/stops.ts): a jeepney
 * or bus at every stop of its route; a UV Express at its terminals only.
 */
function loadsAt(route: Route, v: FleetVehicle, stop: number): boolean {
  return stopRoles(route, v.kind).loads[stop]!;
}

/**
 * On a bus or UV Express route the far terminal draws this many times a
 * jeepney terminal's riders: people take them to go all the way.
 */
const LONG_TRIP_PULL = 6;
/** A driver at the terminal looks this far down the road for waiting riders (metres). */
const FILL_LOOK_AHEAD_M = 3000;
/** Stopped this close behind a vehicle filling at its terminal: next in line (metres). */
const QUEUE_BEHIND_M = 30;

/**
 * Lining up at its terminal (see advanceService): each kind sets out once
 * this share of its seats is taken, or after waiting this long for riders.
 * A UV Express leaves full (it waits for its last passenger); a bus fills
 * less (it picks up along the way); jeepneys most of the way ("hintay
 * mapuno"). Assumptions to check against the terminals' dispatchers.
 */
const FILL: Record<FleetKind, { share: number; patienceS: number }> = {
  jeepney: { share: 0.8, patienceS: 240 },
  modern: { share: 0.8, patienceS: 240 },
  bus: { share: 0.6, patienceS: 180 },
  uv: { share: 1, patienceS: 900 },
};

const lengthOf = ({ kind }: FleetVehicle): number =>
  kind === 'jeepney' ? JEEPNEY_LENGTH_M : VEHICLES[kind].lengthM;
const widthOf = ({ kind }: FleetVehicle): number =>
  kind === 'jeepney' ? JEEPNEY_WIDTH_M : VEHICLES[kind].widthM;

/** Whether drivers give way to `c` just now (see CROSSING_CYCLE_S). */
const asking = (c: Crossing): boolean => c.stepped || c.heldS % CROSSING_CYCLE_S < CROSSING_ASK_S;

export class PassengerSystem implements PassengerService {
  readonly metrics = { boarded: 0, alighted: 0, completed: 0, waitSeconds: 0 };
  readonly passengers = new Map<number, Passenger>();
  readonly services = new Map<number, Service>();
  /** Every stop made with someone off or on, oldest first (at most LOG_KEEP). */
  readonly log: StopEvent[] = [];
  private readonly rng = createRng(53);
  private nextId = 1;
  /** Riders who went home without a ride (still waiting when a day ended). */
  gaveUp = 0;
  private clock = 0;
  private readonly vehiclePose: VehiclePose = { x: 0, z: 0, heading: 0 };
  private readonly scratch = newRiderPose();
  /** Stops each stop's riders can reach (by kind, stop and direction), for goesTo. */
  private readonly callsAt = new Map<string, Set<number>>();
  /** Riders passed on to the vehicle behind, by the stop they switch at, till one takes them. */
  private readonly handedOver = new Map<number, Set<number>>();
  private trips: Trips = {
    at: -1,
    aboard: new Map(),
    gettingOff: new Map(),
    waiting: new Map(),
    flagging: [],
    doorBusy: new Set(),
    onStep: new Set(),
    crossing: [],
  };
  /** Where the route's road is, for those crossing it. */
  readonly road: RoadIndex;
  /** The pedestrian crossings at its stops, where people walk over it (zebra.ts). */
  readonly zebras: readonly Zebra[];
  /** Riders whose trip is over and who have left the twin. */
  delivered = 0;
  /** The streets around the stops, once loaded from the map (null: the route's pavement). */
  private streets: Catchments | null = null;
  /** The last firstMileFrom answer: the commuter app asks for the same spot every tick. */
  private firstMiles: { key: string; value: FirstMile | null } | null = null;
  /** People at work, soonest to leave first (see Return). */
  private readonly returns: Return[] = [];
  /** Commuters who set out home this evening not yet set against the evening's arrivals. */
  private goneHomeAhead = 0;
  /** Per stop: whether it is a school's, and how many get off there, relative. */
  private readonly schools: boolean[];
  private readonly pull: number[];
  /** Keeps a weekday's rider mix, over the commute profile, at BASE_MIX (riderMix.ts). */
  private readonly mixCal: Mix;

  constructor(
    readonly fleet: FleetSim,
    readonly layouts: readonly PassengerLayout[],
    private readonly poseAt: (vehicle: number, out: VehiclePose) => VehiclePose,
  ) {
    const route = fleet.route;
    this.road = new RoadIndex(route);
    this.zebras = zebrasOf(route, this.road);
    const n = route.stops.length;
    // A bus or UV Express route: most ride all the way (to Cubao, Quiapo, Makati).
    const longRoute = route.kind === 'bus' || route.kind === 'uv';
    this.schools = route.stops.map((s) => schoolStop(s.name));
    this.pull = route.stops.map(
      (s, i) =>
        (s.terminal ? TERMINAL_PULL * (longRoute ? LONG_TRIP_PULL : 1) : 1) *
        (PLACE.test(s.name) ? PLACE_PULL : 1) *
        (this.schools[i] ? SCHOOL_PULL : 1),
    );
    this.mixCal = calibrate(
      BASE_MIX,
      COMMUTE_BY_HOUR.flatMap((weight, hour) =>
        this.schools.map((school) => ({ weight: weight / n, hour, school })),
      ),
    );
    fleet.vehicles.forEach((v) => {
      const layout = layouts[v.id]!;
      v.capacity = layout.seats.length;
      v.seats = layout.seats.filter((s) => !s.stands).length;
      v.occupancy = Math.min(v.occupancy, v.capacity);
      // Riders already on board got on at the stop just behind the jeepney…
      const origin = route.loop
        ? (v.nextStop - 1 + n) % n
        : Math.max(0, Math.min(n - 1, v.nextStop - v.direction));
      // …and get off at the next stop it calls at or any later one, up to
      // its next terminal.
      const roles = stopRoles(route, v.kind);
      const options = roles.terminal[v.nextStop]
        ? [v.nextStop]
        : [
            ...(roles.serves[v.nextStop] ? [v.nextStop] : []),
            ...stopsAheadFor(route, v.kind, v.nextStop, v.direction),
          ];
      for (let k = 0; k < v.occupancy; k++) {
        const r = this.create(origin, v.direction, 'seated');
        r.destinationStop = options[Math.floor(this.rng() * options.length)]!;
        r.vehicleId = r.lastVehicleId = v.id;
        r.inside = true;
        r.seat = layout.seatOrder[k]!;
        layout.seated(r.seat, r.pose);
      }
      this.makeRoom(v);
    });
    const waiting = [...fleet.waiting];
    fleet.waiting.fill(0);
    waiting.forEach((count, stop) => this.demand(stop, count, true));
    fleet.passengerService = this;
  }

  /**
   * A new rider at `stop`: `kind` when known (the same person going home),
   * else drawn for the hour, day and stop; going to a stop ahead, as many
   * get off there (see the pulls).
   */
  private create(
    stop: number,
    direction: 1 | -1,
    phase: PassengerPhase,
    kind?: RiderKind,
  ): Passenger {
    const id = this.nextId++;
    const hour = this.fleet.timeOfDay / 3600;
    const where = { hour, day: this.fleet.dayNumber - 1, school: this.schools[stop]! };
    const who = kind ?? drawKind(mixAt(BASE_MIX, where, this.mixCal), idDraw(id, 50));
    const options = stopsAhead(this.fleet.route, stop, direction);
    const weights = options.map(
      (s) =>
        this.pull[s]! * (who === 'student' && hour < 13 && this.schools[s] ? STUDENT_TO_SCHOOL : 1),
    );
    let u = this.rng() * weights.reduce((a, b) => a + b, 0);
    const destination = options.find((_, i) => (u -= weights[i]!) < 0) ?? options.at(-1);
    const r: Passenger = {
      id,
      kind: who,
      originStop: stop,
      destinationStop: destination ?? stop,
      direction,
      phase,
      vehicleId: null,
      lastVehicleId: null,
      seat: null,
      spot: null,
      inside: false,
      pose: newRiderPose(),
      motion: null,
      t: 0,
      history: [{ phase, at: this.clock }],
    };
    this.passengers.set(r.id, r);
    this.trips.at = -1;
    return r;
  }

  /**
   * Where people come from and go to: the streets around the stops, once
   * loaded from the map (see streetGraph.ts); null for the route's pavement.
   * Riders already on their way keep the paths they have, except anyone
   * going straight from a spot on the map (offStreets): from where they are
   * now, they go by the streets instead.
   */
  setStreets(streets: Catchments | null): void {
    this.streets = streets;
    this.returns.length = 0;
    this.firstMiles = null;
    if (!streets) return;
    for (const r of this.passengers.values()) {
      if (!r.offStreets || r.phase !== 'approaching' || !r.spot) continue;
      r.offStreets = undefined;
      const mode = r.approachMode ?? 'walk';
      const path = streets.wayFrom(
        r.pose,
        r.originStop,
        r.direction,
        r.spot,
        laneFor(r.id, mode),
        FROM_STREET_M,
      );
      if (!path) continue;
      r.motion = this.onFoot(mode, path);
      r.way = path;
      r.t = 0;
      r.motion.poseAt(0, r.pose);
    }
  }

  /**
   * `count` people arrive to ride from `stop`. In the evening, commuters set
   * out home at times of their own (update); each one stands in for one of
   * these arrivals, so the day's volume stays the scenario's while people go
   * home from where they went this morning.
   */
  demand(stop: number, count: number, initial = false): void {
    for (let i = 0; i < count; i++) {
      if (!initial && this.goneHomeAhead > 0 && this.fleet.timeOfDay >= LEAVE_FROM_S)
        this.goneHomeAhead--;
      else this.spawn(stop, initial);
    }
  }

  /** People already waiting at `stop`, going `direction`: newcomers stand clear of them. */
  private othersAt(stop: number, direction: 1 | -1): LocalPoint[] {
    const others: LocalPoint[] = [];
    for (const o of this.passengers.values())
      if (o.spot && o.originStop === stop && o.direction === direction) others.push(o.spot);
    return others;
  }

  /** A way on foot, over the road at its nearest crossing; a tricycle drives it as it goes. */
  private onFoot(mode: ApproachMode, path: readonly Point3[]): RiderMotion {
    return mode === 'tricycle'
      ? RiderMotion.tricycle(path)
      : RiderMotion.walking(viaZebra(path, this.road, this.zebras));
  }

  /** One new rider at `stop`, from home (or wherever) to a stop ahead. */
  private spawn(stop: number, initial: boolean): void {
    const route = this.fleet.route;
    // A loop stop is served one way only; a line stop both ways, except
    // at its two ends.
    const direction: 1 | -1 = route.loop
      ? 1
      : stop === 0
        ? 1
        : stop === route.stops.length - 1
          ? -1
          : this.rng() < 0.5
            ? 1
            : -1;
    // Wherever there is room in the crowd, a step away from everyone else.
    const others = this.othersAt(stop, direction);
    const r = this.create(stop, direction, initial ? 'waiting' : 'approaching');
    const target = waitingSpot(route, stop, direction, r.id, others);
    r.spot = target;
    if (initial) Object.assign(r.pose, target);
    else if (!this.fromStreets(r, target)) this.alongPavement(r, target);
    this.fleet.waiting[stop]!++;
  }

  /** Someone leaving work: from there along the streets to the stop they ride home from. */
  private goHome(ret: Return): void {
    const r = this.create(ret.stop, ret.direction, 'approaching', ret.kind);
    r.destinationStop = ret.via ?? ret.homeStop;
    if (ret.via !== undefined) r.thenTo = ret.homeStop;
    r.tour = 'back';
    r.homeNode = ret.homeNode;
    const others = this.othersAt(ret.stop, ret.direction);
    const target = waitingSpot(this.fleet.route, ret.stop, ret.direction, r.id, others);
    r.spot = target;
    if (!this.fromStreets(r, target, ret.awayNode)) this.alongPavement(r, target);
    this.fleet.waiting[ret.stop]!++;
  }

  /**
   * Set `r` off along the streets to `target` at its stop: from `node`
   * (their workplace, going home), else from a place of their own around the
   * stop. On foot, or by tricycle from far. False without streets there.
   * Someone setting out in the morning is going to work from home.
   */
  private fromStreets(r: Passenger, target: LocalPoint, node?: number): boolean {
    const c = this.streets;
    if (!c) return false;
    const from = node ?? c.place(r.originStop, r.direction, idDraw(r.id, 10))?.node;
    if (from === undefined) return false;
    const metres = c.stopOf(from, r.direction)?.metres;
    if (metres === undefined) return false;
    r.approachMode = modeFor(r.id, 12, metres);
    const path = c.toStop(from, r.direction, target, laneFor(r.id, r.approachMode));
    if (!path) return false;
    r.motion = this.onFoot(r.approachMode, path);
    r.motion.poseAt(0, r.pose);
    if (r.tour === undefined && this.fleet.timeOfDay < MORNING_UNTIL_S) {
      r.tour = 'out';
      r.homeNode = from;
    }
    return true;
  }

  /** Without streets: along the route's pavement, from further along it or the last few metres. */
  private alongPavement(r: Passenger, target: LocalPoint): void {
    const route = this.fleet.route;
    const { originStop: stop, direction } = r;
    const far = firstMileOf(r.id);
    if (far) {
      r.approachMode = far.mode;
      r.motion = this.onFoot(far.mode, approachPath(route, stop, direction, target, far.metres));
    } else {
      // From up or down the road, so people do not all walk in from one side.
      const from = r.id % 2 === 0 ? -WALK_IN_M : WALK_IN_M;
      const start = pavementPoint(route, stop, direction, from, 1 + (r.id % 5));
      r.motion = RiderMotion.walking([
        [start.x, 0, start.z],
        [target.x, 0, target.z],
      ]);
    }
    r.motion.poseAt(0, r.pose);
  }

  /**
   * Off at `stop`: the way on from `from` (the kerb) along the side streets,
   * home for someone coming back from work, else to a place of their own
   * (work, in the morning). Null without streets there. Someone off to work
   * is planned to come back this evening (planReturn).
   */
  private toStreets(r: Passenger, stop: number, from: LocalPoint): RiderMotion | null {
    const c = this.streets;
    if (!c) return null;
    const node =
      (r.tour === 'back' ? r.homeNode : undefined) ??
      c.place(stop, r.direction, idDraw(r.id, 20))?.node;
    if (node === undefined) return null;
    const metres = c.stopOf(node, r.direction)?.metres;
    if (metres === undefined) return null;
    const leaveMode = modeFor(r.id, 22, metres);
    const path = c.fromStop(node, r.direction, from, laneFor(r.id, leaveMode));
    if (!path) return null;
    if (r.tour === 'out') this.planReturn(r, node);
    r.leaveMode = leaveMode;
    // A tricycle waits at the kerb; on foot, from the jeepney's step.
    return leaveMode === 'tricycle'
      ? RiderMotion.tricycle(path)
      : this.onFoot('walk', [[r.pose.x, 0, r.pose.z], ...path]);
  }

  /**
   * `r`, off for work at street node `work`: home this evening, unless they
   * go some other way. Home is reached from the stop its streets lead to,
   * work from the one its streets lead to (Catchments.stopOf); they ride
   * between whichever stops by those (within STOP_NEAR_M: often the one
   * across the road) a jeepney runs between, least walking first. Where none
   * does (on a loop, one going on to a terminal first), they change at the
   * terminal, which counts as TRANSFER_M more walking.
   */
  private planReturn(r: Passenger, work: number): void {
    const c = this.streets;
    const home = r.homeNode;
    if (!c || home === undefined || idDraw(r.id, 30) >= RETURN_SHARE) return;
    const route = this.fleet.route;
    const apart = (a: LocalPoint, b: LocalPoint) => Math.hypot(a.x - b.x, a.z - b.z);
    type Ride = Pick<Return, 'stop' | 'direction' | 'homeStop' | 'via'>;
    let best: Ride | null = null;
    let least = Infinity;
    // Going each way the route runs: the stops work and home lead to, and those by them.
    const pairs = c.directions.flatMap((d) => {
      const atWork = c.stopOf(work, d);
      const atHome = c.stopOf(home, d);
      if (!atWork || !atHome) return [];
      const homeStops = c.slotsNear(atHome.spot, STOP_NEAR_M, d);
      return c
        .slotsNear(atWork.spot, STOP_NEAR_M, d)
        .map((board) => ({ board, atWork, atHome, homeStops }));
    });
    for (const { board, atWork, atHome, homeStops } of pairs) {
      const walked = apart(board.spot, atWork.spot);
      const ahead = stopsAhead(route, board.stop, board.direction);
      const end = ahead[ahead.length - 1];
      const via = route.loop && end !== undefined && isTerminal(route, end) ? end : undefined;
      for (const alight of homeStops) {
        if (alight.direction !== board.direction) continue;
        const cost = walked + apart(alight.spot, atHome.spot);
        const ride: Ride = { stop: board.stop, direction: board.direction, homeStop: alight.stop };
        if (ahead.includes(alight.stop)) {
          if (cost < least) [least, best] = [cost, ride];
        } else if (
          via !== undefined &&
          cost + TRANSFER_M < least &&
          stopsAhead(route, via, board.direction).includes(alight.stop)
        )
          [least, best] = [cost + TRANSFER_M, { ...ride, via }];
      }
    }
    if (!best) return;
    const ret: Return = {
      dueS: leaveWorkAt(r.id),
      ...best,
      homeNode: home,
      awayNode: work,
      kind: kindOf(r),
    };
    let i = this.returns.length;
    while (i > 0 && this.returns[i - 1]!.dueS > ret.dueS) i--;
    this.returns.splice(i, 0, ret);
  }

  /**
   * The commuter app's own rider ("you"): getting to `stop` from `distanceM`
   * away on foot or by tricycle, going to `destination`; or, with `from`,
   * from that very spot on the map (see firstMileFrom: then `stop` and
   * `distanceM` are worked out from it). `kind` is who they are, for the
   * fare. From then on they are a rider like any other: queued in arrival
   * order, waited for when close, boarded first come first served. Returns
   * their id, for the app to follow.
   */
  join(
    stop: number,
    destination: number,
    distanceM: number,
    mode: ApproachMode = 'walk',
    opts: {
      kind?: RiderKind;
      from?: LocalPoint;
      keepStop?: boolean;
      way?: StreetWay;
      /** Wait at the side of the road here, not at `stop`, the stop after it… */
      flagS?: number;
      /** …just there, by that part of the road. */
      flagAt?: LocalPoint;
      /** …by a side street off the route, there (Passenger.byStreet). */
      byStreet?: boolean;
      /** Where they go from the stop they get off at, and how. */
      onward?: Onward;
      /** Along the route's pavement, in sight of the road, not in by the side streets. */
      alongRoad?: boolean;
    } = {},
  ): number {
    const route = this.fleet.route;
    // From a spot: the stop it leads to; with `keepStop`, to `stop` as given
    // (the trip planner's choice), from that spot all the same.
    const fromHere =
      opts.from && !opts.keepStop ? this.firstMileFrom(opts.from, destination) : null;
    if (opts.from && !opts.keepStop && !fromHere)
      throw new RangeError('No stop on this route goes there from here.');
    if (fromHere) [stop, distanceM] = [fromHere.stop, fromHere.metres];
    if (!route.stops[stop] || !route.stops[destination] || !Number.isFinite(distanceM))
      throw new RangeError('Choose valid stops and a finite first-mile distance.');
    const direction: 1 | -1 =
      fromHere?.direction ??
      (route.loop || route.stops[destination]!.s >= route.stops[stop]!.s ? 1 : -1);
    const first: FirstMile | null =
      fromHere ??
      (opts.from
        ? { stop, direction, metres: distanceM, from: opts.from, node: this.streets ? 0 : -1 }
        : null);
    const others = this.othersAt(stop, direction);
    const remaining = Math.max(0, distanceM);
    const r = this.create(stop, direction, remaining === 0 ? 'waiting' : 'approaching');
    r.approachMode = mode;
    if (opts.kind) r.kind = opts.kind;
    if (stopsAhead(route, stop, direction).includes(destination)) r.destinationStop = destination;
    const target =
      opts.flagS === undefined
        ? waitingSpot(route, stop, direction, r.id, others)
        : (opts.flagAt ?? roadsidePoint(route, opts.flagS, direction));
    r.spot = target;
    r.flagS = opts.flagS;
    if (opts.byStreet) r.byStreet = true;
    r.onward = opts.onward;
    if (remaining === 0) Object.assign(r.pose, target);
    else {
      // From the spot chosen; else from a place on the side streets about
      // that far away, when they are known.
      const lane = laneFor(r.id, mode);
      const place =
        first || opts.alongRoad ? null : this.streets?.placeAbout(stop, direction, remaining, 0.5);
      // The way already worked out for this trip, on to their place at the stop.
      const given: Point3[] | null = opts.way
        ? wayLine(opts.way.points, opts.way.widths, mode, target)
        : opts.flagS !== undefined && opts.from
          ? [
              [opts.from.x, 0, opts.from.z],
              [target.x, 0, target.z],
            ]
          : null;
      const path =
        given ??
        (first && this.pathFrom(r, first, target, lane)) ??
        (place && this.streets!.toStop(place.node, direction, target, lane)) ??
        approachPath(route, stop, direction, target, remaining);
      r.motion = this.onFoot(mode, path);
      r.way = path;
      r.motion.poseAt(0, r.pose);
    }
    this.fleet.waiting[stop]!++;
    return r.id;
  }

  /**
   * From a spot on the map to `destination`: the stop to board at (going
   * the way that reaches it), and how far it is. When the streets are known
   * and the spot is within FROM_STREET_M of one: along the streets to the
   * stop they lead to, or else to the nearest by street that goes there.
   * Otherwise straight to the nearest such stop. Null when no stop goes
   * there, or the nearest is beyond tricycle range.
   */
  firstMileFrom(from: LocalPoint, destination: number): FirstMile | null {
    const key = `${from.x},${from.z},${destination}`;
    if (this.firstMiles?.key !== key)
      this.firstMiles = { key, value: this.findFirstMile(from, destination) };
    return this.firstMiles.value;
  }

  private findFirstMile(from: LocalPoint, destination: number): FirstMile | null {
    const route = this.fleet.route;
    if (!route.stops[destination]) return null;
    const goes = (stop: number, direction: 1 | -1) =>
      stop !== destination && stopsAhead(route, stop, direction).includes(destination);
    const c = this.streets;
    const at = c?.onStreets(from, FROM_STREET_M);
    let best: FirstMile | null = null;
    if (c && at) {
      const hop = Math.hypot(at.at.x - from.x, at.at.z - from.z);
      for (const direction of c.directions)
        for (const node of [at.a, at.b]) {
          const s = c.stopOf(node, direction);
          if (!s) continue;
          // Its stop, or (squeezed between others) one by it that goes there.
          const board = [s, ...c.slotsNear(s.spot, STOP_NEAR_M, direction)].find((b) =>
            goes(b.stop, direction),
          );
          if (!board) continue;
          const along = Math.hypot(c.graph.x[node]! - at.at.x, c.graph.z[node]! - at.at.z);
          const metres =
            hop + along + s.metres + Math.hypot(board.spot.x - s.spot.x, board.spot.z - s.spot.z);
          if (!best || metres < best.metres)
            best = { stop: board.stop, direction, metres, from, node };
        }
      if (best) return best;
      // Its own streets lead to no stop going there: the nearest by street that does.
      const near = c.nearestByStreet(from, FROM_STREET_M, goes);
      if (near)
        return {
          stop: near.stop,
          direction: near.direction,
          metres: near.metres,
          from,
          node: at.a,
        };
    }
    // Straight to the nearest stop that goes there.
    const directions: ReadonlyArray<1 | -1> = route.loop ? [1] : [1, -1];
    for (let stop = 0; stop < route.stops.length; stop++)
      for (const direction of directions) {
        if (!goes(stop, direction)) continue;
        const p = route.polyline.pointAt(route.stops[stop]!.s);
        const metres = Math.hypot(p.x - from.x, p.z - from.z);
        if (metres <= MAX_FIRST_MILE_M && (!best || metres < best.metres))
          best = { stop, direction, metres, from, node: -1 };
      }
    return best;
  }

  /**
   * The way for rider `r` from a spot on the map (firstMileFrom) to `target`
   * at its stop, in `lane`: by the streets when known, else straight (and
   * onto the streets once they are: setStreets).
   */
  private pathFrom(r: Passenger, m: FirstMile, target: LocalPoint, lane: Lane): Point3[] {
    const streets =
      m.node >= 0
        ? this.streets?.wayFrom(m.from, m.stop, m.direction, target, lane, FROM_STREET_M)
        : null;
    if (streets) return streets;
    r.offStreets = true;
    return [
      [m.from.x, 0, m.from.z],
      [target.x, 0, target.z],
    ];
  }

  /** Withdraw a personal trip before boarding; never remove an onboard rider. */
  cancel(id: number): boolean {
    const r = this.passengers.get(id);
    if (!r || r.vehicleId !== null || (r.phase !== 'approaching' && r.phase !== 'waiting'))
      return false;
    this.passengers.delete(id);
    this.fleet.waiting[r.originStop] = Math.max(0, (this.fleet.waiting[r.originStop] ?? 0) - 1);
    this.trips.at = -1;
    return true;
  }

  /**
   * On board `vehicle` now: exactly these riders, each going to the stop given,
   * and nobody else, the first of them `kind`. For staging a moment
   * (app/demoScenes.ts), before it moves.
   */
  seatRiders(vehicle: number, destinations: readonly number[], kind?: RiderKind): number[] {
    const v = this.fleet.vehicles[vehicle]!;
    const layout = this.layouts[vehicle]!;
    const route = this.fleet.route;
    for (const r of this.passengers.values())
      if (r.vehicleId === vehicle) this.passengers.delete(r.id);
    const n = route.stops.length;
    const origin = route.loop
      ? (v.nextStop - 1 + n) % n
      : Math.max(0, Math.min(n - 1, v.nextStop - v.direction));
    const ids = destinations.slice(0, layout.seats.length).map((stop, k) => {
      const r = this.create(origin, v.direction, 'seated', k === 0 ? kind : undefined);
      r.destinationStop = stop;
      r.vehicleId = r.lastVehicleId = vehicle;
      r.inside = true;
      r.seat = layout.seatOrder[k]!;
      layout.seated(r.seat, r.pose);
      return r.id;
    });
    this.makeRoom(v);
    v.occupancy = ids.length;
    this.trips.at = -1;
    return ids;
  }

  /** Waiting at `stop` now: exactly these people (a kind each, or as they come), nobody else. */
  setWaiting(stop: number, kinds: ReadonlyArray<RiderKind | undefined>): void {
    for (const r of [...this.passengers.values()])
      if (r.originStop === stop && r.flagS === undefined && r.vehicleId === null) this.cancel(r.id);
    this.fleet.waiting[stop] = 0;
    for (const kind of kinds) {
      this.spawn(stop, true);
      if (kind) [...this.passengers.values()].at(-1)!.kind = kind;
    }
  }

  /**
   * The driver passes their riders on to the vehicle behind: everyone on
   * board gets off at the next stop and waits there, going on to where they
   * were going. Returns how many, and at which stop.
   */
  passOn(vehicle: number): { riders: number; stop: number } {
    const v = this.fleet.vehicles[vehicle]!;
    let riders = 0;
    for (const r of this.passengers.values()) {
      if (r.vehicleId !== vehicle || r.phase !== 'seated' || r.destinationStop === v.nextStop)
        continue;
      r.thenTo = r.destinationStop;
      r.passedOn = vehicle;
      r.destinationStop = v.nextStop;
      riders++;
      const at = this.handedOver.get(v.nextStop) ?? new Set<number>();
      this.handedOver.set(v.nextStop, at.add(r.id));
    }
    this.trips.at = -1;
    return { riders, stop: v.nextStop };
  }

  arrive(vehicle: FleetVehicle, stop: number, dropOffOnly = false): void {
    const terminal = stopRoles(this.fleet.route, vehicle.kind).terminal[stop]!;
    const exits = [...this.passengers.values()].filter(
      (r) =>
        r.vehicleId === vehicle.id &&
        r.phase === 'seated' &&
        (terminal || r.destinationStop === stop),
    );
    exits.sort(
      (a, b) =>
        this.layouts[vehicle.id]!.alight(a.seat!).duration -
        this.layouts[vehicle.id]!.alight(b.seat!).duration,
    );
    this.services.set(vehicle.id, {
      stop,
      exits: exits.map((r) => r.id),
      boarders: null,
      active: null,
      terminal,
      turned: false,
      heldS: 0,
      fillS: 0,
      doorFreeAt: 0,
      next: null,
      pickup: !dropOffOnly,
      sat: false,
      off: 0,
      on: 0,
      fareCentavos: 0,
    });
  }

  pickUp(vehicle: FleetVehicle, stop: number): void {
    if (this.services.has(vehicle.id)) return;
    this.services.set(vehicle.id, {
      stop,
      exits: [],
      boarders: null,
      active: null,
      terminal: stopRoles(this.fleet.route, vehicle.kind).terminal[stop]!,
      turned: true, // it turned round, if it had to, when it first served the stop
      heldS: 0,
      fillS: 0,
      doorFreeAt: 0,
      next: null,
      pickup: true,
      sat: false,
      off: 0,
      on: 0,
      fareCentavos: 0,
    });
  }

  flagAhead(v: FleetVehicle): number | null {
    const { flagging, aboard } = this.tripsNow();
    if (flagging.length === 0 || !stopsByTheRoad(v.kind) || (aboard.get(v.id) ?? 0) >= v.capacity)
      return null;
    const route = this.fleet.route;
    const ahead = (s: number) => (route.loop ? aheadOf(route, v.s, s) : (s - v.s) * v.direction);
    let nearest: number | null = null;
    for (const r of flagging) {
      if (r.byStreet) continue;
      if (r.direction !== v.direction || !this.goesTo(v, r.originStop, r.destinationStop)) continue;
      const d = ahead(r.flagS!);
      // Past them already, it is further to them than to the stop after them.
      if (d < 0 || d > ahead(route.stops[r.originStop]!.s)) continue;
      if (nearest === null || d < ahead(nearest)) nearest = r.flagS!;
    }
    return nearest;
  }

  /**
   * Whoever waits by the side street `v` is driving (`line`, `fromM` metres
   * along it already) and goes its way: how far along it they are, and their
   * `flagS` (pickUpFlag). Null if nobody, or no seat.
   */
  streetRiderAhead(
    v: FleetVehicle,
    line: Polyline,
    fromM: number,
  ): {
    atM: number;
    flagS: number;
  } | null {
    const { flagging, aboard } = this.tripsNow();
    if (flagging.length === 0 || (aboard.get(v.id) ?? 0) >= v.capacity) return null;
    let nearest: { atM: number; flagS: number } | null = null;
    for (const r of flagging) {
      if (!r.byStreet || !r.spot || r.direction !== v.direction) continue;
      if (!this.goesTo(v, r.originStop, r.destinationStop)) continue;
      const p = line.project(r.spot);
      if (p.offset > BY_THE_STREET_M || p.s <= fromM) continue;
      if (!nearest || p.s < nearest.atM) nearest = { atM: p.s, flagS: r.flagS! };
    }
    return nearest;
  }

  /** Everyone at the kerb or on the road just now, drivers giving way. */
  get crossingsNow(): readonly Crossing[] {
    return this.tripsNow().crossing.filter(asking);
  }

  crossingAhead(v: FleetVehicle): number {
    const crossing = this.tripsNow().crossing;
    if (crossing.length === 0) return Infinity;
    const half = lengthOf(v) / 2;
    const toStop = (v.speedMps * v.speedMps) / (2 * BRAKE_MPS2);
    let least = Infinity;
    for (const c of crossing) {
      if (!asking(c)) continue;
      for (const pass of c.passes) {
        const [near, far] = this.stripAhead(v, pass);
        // On it (getting out of the way), past it, or too far off to matter.
        if (near < half || far < -half || near > CROSSING_LOOK_M) continue;
        // Out on the road but past this one's lane, walking away: it goes on.
        if (c.stepped && this.pastLane(v, c)) continue;
        const room = near - half - YIELD_GAP_M;
        // Too close to stop: it goes on, and they wait for it (mayCross).
        if (!c.stepped && room < toStop && !c.giving.has(v.id)) continue;
        c.giving.add(v.id);
        least = Math.min(least, Math.max(0, room));
      }
    }
    return least;
  }

  /** Whether whoever is crossing at `c` is clear of `v`'s lane and walking away from it. */
  private pastLane(v: FleetVehicle, c: Crossing): boolean {
    if (!c.at) return false;
    const p = this.poseAt(v.id, this.vehiclePose);
    // Across the vehicle's way: (sin, cos) of its heading; theirs: along the crossing.
    const nx = Math.sin(p.heading);
    const nz = Math.cos(p.heading);
    const beside = (c.at.x - p.x) * nx + (c.at.z - p.z) * nz;
    const going = Math.cos(c.heading) * nx - Math.sin(c.heading) * nz;
    return Math.abs(beside) > widthOf(v) / 2 + LANE_CLEAR_M && beside * going > 0;
  }

  /** How far the line at `s` is ahead of `v`, the short way round; behind it, negative. */
  private lineAhead(v: FleetVehicle, s: number): number {
    const route = this.fleet.route;
    if (!route.loop) return (s - v.s) * v.direction;
    const L = route.polyline.length;
    return ((((s - v.s + L / 2) % L) + L) % L) - L / 2;
  }

  /** How far ahead of `v` the near and far ends of `pass` are; behind it, negative. */
  private stripAhead(v: FleetVehicle, pass: CrossingPass): [number, number] {
    const a = this.lineAhead(v, pass.s);
    const b = a + (this.fleet.route.loop ? pass.alongM : pass.alongM * v.direction);
    return a < b ? [a, b] : [b, a];
  }

  /** Whether someone at the kerb can step out: nothing on the line, nothing too close to stop. */
  private mayCross(c: Crossing): boolean {
    if (c.flowBusy) return false;
    for (const v of this.fleet.vehicles) {
      if (v.duty === 'parked' || v.yard) continue;
      const half = lengthOf(v) / 2;
      const toStop = (v.speedMps * v.speedMps) / (2 * BRAKE_MPS2);
      for (const pass of c.passes) {
        const [near, far] = this.stripAhead(v, pass);
        if (near <= half + LINE_CLEAR_M && far >= -half - LINE_CLEAR_M) return false;
        if (near > 0 && near - half - YIELD_GAP_M < toStop && !c.giving.has(v.id)) return false;
      }
    }
    return true;
  }

  /** Whether a vehicle stands on the line of `c`, not just passing over it. */
  private standingOn(c: Crossing): boolean {
    return this.fleet.vehicles.some((v) => {
      if (v.duty === 'parked' || v.yard || v.speedMps >= STANDING_MPS) return false;
      const half = lengthOf(v) / 2;
      return c.passes.some((pass) => {
        const [near, far] = this.stripAhead(v, pass);
        return near <= half + LINE_CLEAR_M && far >= -half - LINE_CLEAR_M;
      });
    });
  }

  /**
   * Rider `r` at the kerb, a vehicle standing on their line: along the kerb to
   * the nearest gap between what is on the road there, over, and back to their
   * way. False when there is no gap in reach: they wait.
   */
  private goRound(r: Passenger, c: Crossing): boolean {
    const motion = r.motion!;
    const off = motion.poseAt(c.t1, this.scratch);
    const exit: Point3 = [off.x, 0, off.z];
    const c0 = this.fleet.route.polyline.pointAt(c.passes[0]!.s);
    const ux = Math.cos(c0.heading);
    const uz = -Math.sin(c0.heading);
    // Where along the road, from their line, each vehicle near it is taken up.
    const taken: Array<[number, number]> = [];
    for (const v of this.fleet.vehicles) {
      if (v.duty === 'parked' || v.yard) continue;
      const p = this.poseAt(v.id, this.vehiclePose);
      const along = (p.x - c.x) * ux + (p.z - c.z) * uz;
      const beside = (p.x - c.x) * uz - (p.z - c.z) * ux;
      if (Math.abs(along) > GAP_LOOK_M * 2 || Math.abs(beside) > c.length) continue;
      const half = lengthOf(v) / 2 + LINE_CLEAR_M + YIELD_GAP_M;
      taken.push([along - half, along + half]);
    }
    const slant = Math.abs((exit[0] - r.pose.x) * ux + (exit[2] - r.pose.z) * uz);
    for (let m = GAP_STEP_M; m <= GAP_LOOK_M; m += GAP_STEP_M)
      for (const shift of [m, -m]) {
        if (taken.some(([a, b]) => shift + slant / 2 > a && shift - slant / 2 < b)) continue;
        const dx = ux * shift;
        const dz = uz * shift;
        const path: Point3[] = [
          [r.pose.x, 0, r.pose.z],
          [r.pose.x + dx, 0, r.pose.z + dz],
          [exit[0] + dx, 0, exit[2] + dz],
          exit,
          ...motion.pointsAfter(c.t1),
        ];
        r.motion = firstMile(motion.riding ? 'tricycle' : 'walk', path);
        r.t = 0;
        this.trips.at = -1;
        return true;
      }
    return false;
  }

  /** True while rider `r` stands at the kerb, this tick, for the road to clear. */
  private holdForRoad(r: Passenger, dt: number): boolean {
    // The next crossing on their way, looked for once per way (from where they are).
    if (r.crossingsOf !== r.motion) {
      r.crossingsOf = r.motion!;
      r.crossings = crossingsOf(r.motion!, this.road, r.t, 1);
    }
    const c = r.crossings![0];
    if (!c) return false;
    if (r.t >= c.t1) {
      // Over: the one after it, if any.
      r.crossings = crossingsOf(r.motion!, this.road, c.t1, 1);
      this.trips.at = -1;
      return false;
    }
    if (r.t + HAIL_S < c.t0) return false;
    if (!c.hailing) {
      c.hailing = true;
      this.trips.at = -1;
    }
    if (c.stepped || r.t + dt < c.t0) return false;
    if (this.mayCross(c)) {
      c.stepped = true;
      this.trips.at = -1;
      return false;
    }
    const before = Math.floor(c.heldS / GO_ROUND_AFTER_S);
    c.heldS += dt;
    r.pose.walk = 0;
    if (Math.floor(c.heldS / GO_ROUND_AFTER_S) > before && this.standingOn(c) && this.goRound(r, c))
      return false;
    return true;
  }

  pickUpFlag(vehicle: FleetVehicle, stop: number, s: number): void {
    this.pickUp(vehicle, stop);
    this.services.get(vehicle.id)!.flagS = s;
  }

  /** A stop done: into the log if anyone got off or on, and the jeepney may go. */
  private finish(v: FleetVehicle, s: Service): void {
    this.services.delete(v.id);
    if (s.off + s.on === 0) return;
    this.log.push({
      atS: this.fleet.elapsedS,
      vehicle: v.id,
      stop: s.stop,
      off: s.off,
      on: s.on,
      fareCentavos: s.fareCentavos,
    });
    if (this.log.length > LOG_KEEP) this.log.splice(0, this.log.length - LOG_KEEP);
  }

  busy(vehicle: number): boolean {
    return this.services.has(vehicle);
  }

  /**
   * The day is over (FleetSim.dayCycle): whoever is still waiting, or still
   * walking to a stop, has gone home some other way. They leave the twin;
   * riders on board are already off (every jeepney parked at a terminal).
   */
  endOfDay(): void {
    // Anyone still at work went home some other way.
    this.returns.length = 0;
    this.goneHomeAhead = 0;
    for (const r of [...this.passengers.values()]) {
      if (r.phase !== 'waiting' && r.phase !== 'approaching') continue;
      this.fleet.waiting[r.originStop] = Math.max(0, (this.fleet.waiting[r.originStop] ?? 0) - 1);
      this.passengers.delete(r.id);
      this.gaveUp++;
    }
  }

  status(vehicle: number): string {
    const s = this.services.get(vehicle);
    if (!s)
      return this.fleet.vehicles[vehicle]!.currentStop === null
        ? 'Driving'
        : 'Stopped, ready to depart';
    const active = s.active === null ? null : this.passengers.get(s.active);
    if (active?.phase === 'alighting' || s.exits.length) return 'Stopped, passengers getting off';
    let boarding = 0;
    for (const r of this.passengers.values())
      if (r.vehicleId === vehicle && r.phase === 'boarding') boarding++;
    if (boarding > 0) return `Stopped, ${boarding} boarding`;
    if (s.heldS > 0) return 'Stopped, waiting for someone running to the stop';
    return 'Stopped, waiting for passengers to clear';
  }

  update(dt: number): void {
    this.clock += dt;
    // Commuters leave work at their own times, and stand in for the evening's arrivals (demand).
    // Not after the last riders of the day: anyone still at work then goes home some other way.
    const now = this.fleet.timeOfDay;
    while (
      now >= LEAVE_FROM_S &&
      now < LAST_RIDERS_S &&
      now >= (this.returns[0]?.dueS ?? Infinity)
    ) {
      this.goHome(this.returns.shift()!);
      this.goneHomeAhead++;
    }
    for (const r of this.passengers.values()) {
      if (!r.motion) continue;
      if (r.vehicleId === null && this.holdForRoad(r, dt)) continue;
      r.t = Math.min(r.t + dt, r.motion.duration);
      r.motion.poseAt(r.t, r.pose);
      // (On board already, moving to a seat that has come free.)
      if (r.vehicleId !== null && r.phase !== 'seated') {
        const inside = this.layouts[r.vehicleId]!.isInside(r.pose);
        if (inside !== r.inside) {
          if (inside) {
            this.metrics.boarded++;
            this.metrics.waitSeconds +=
              this.clock - (r.history.find((h) => h.phase === 'waiting')?.at ?? r.history[0]!.at);
          } else this.metrics.alighted++;
        }
        r.inside = inside;
      }
      if (r.t < r.motion.duration) continue;
      r.motion = null;
      if (r.phase === 'approaching') {
        this.transition(r, 'waiting');
        r.pose.sit = 0;
      } else if (r.phase === 'boarding') {
        this.transition(r, 'seated');
        this.sitInRoom(r);
      } else if (r.phase === 'alighting') this.walkAway(r);
      else if (r.phase === 'walking') this.transition(r, 'arrived');
      r.pose.walk = 0;
    }
    // Trips that are over leave the twin (and its data) once faded out.
    for (const r of this.passengers.values()) {
      if (r.phase === 'arrived' && this.visibility(r) === 0) {
        this.passengers.delete(r.id);
        this.delivered++;
      }
    }
    for (const v of this.fleet.vehicles) {
      const service = this.services.get(v.id);
      if (service) this.advanceService(v, service, dt);
      v.occupancy = 0;
    }
    for (const v of this.fleet.vehicles) v.capacity = this.layouts[v.id]!.seats.length;
    for (const r of this.passengers.values()) {
      if (r.vehicleId === null) continue;
      const v = this.fleet.vehicles[r.vehicleId];
      if (!v) continue;
      if (r.inside) v.occupancy++;
      // The seat kept beside a pregnant rider is nobody's.
      if (typeof r.room === 'number') v.capacity--;
    }
  }

  /**
   * How visible rider `r` is, 0 to 1: fading in while walking up to the
   * stop, fading out once arrived. The renderer draws it; update() removes
   * arrived riders at 0.
   */
  visibility(r: Passenger): number {
    if (r.phase === 'approaching') return Math.min(1, (this.clock - r.history[0]!.at) / FADE_IN_S);
    if (r.phase !== 'arrived') return 1;
    const since = this.clock - r.history[r.history.length - 1]!.at - LINGER_S;
    return Math.max(0, Math.min(1, 1 - since / FADE_OUT_S));
  }

  private advanceService(v: FleetVehicle, s: Service, dt: number): void {
    // Getting off: one person in the doorway at a time, the next one goes as
    // soon as the one before is out.
    if (s.active !== null) {
      const r = this.passengers.get(s.active);
      if (r?.phase === 'alighting' && r.inside) return;
      s.active = null;
    }
    const exiting = s.exits.shift();
    if (exiting !== undefined) {
      const r = this.passengers.get(exiting)!;
      this.transition(r, 'alighting');
      // The fare, paid getting off: by ride distance, 20% off for the eligible.
      const fare = fareCentavosFor(this.fleet.route, r, v.kind);
      v.day.fareCentavos += fare;
      v.day.riders++;
      s.fareCentavos += fare;
      s.off++;
      r.motion = this.layouts[v.id]!.alight(r.seat!);
      r.t = 0;
      s.active = r.id;
      return;
    }
    // Boarders wait until everyone getting off is down and clear of the doorway.
    if (this.tripsNow().doorBusy.has(v.id)) return;
    // Let off in a queue short of the stop: on again as soon as they are clear.
    if (!s.pickup) {
      if (!this.tripsNow().onStep.has(v.id)) this.finish(v, s);
      return;
    }
    // Everyone is off: those standing take the seats they left.
    if (!s.sat) {
      s.sat = true;
      this.sitDown(v);
    }
    // On a line the jeepney turns round at a terminal; on a loop the road
    // brings it back, so it keeps its direction.
    if (s.terminal && !s.turned) {
      if (!this.fleet.route.loop) v.direction = v.direction === 1 ? -1 : 1;
      s.turned = true;
    }
    // Getting on: everyone it is taking heads for the back at once, and they
    // climb in one after another, DOOR_HEADWAY_S apart, in the order they
    // came (first come, first served). Whoever is further away sets off
    // earlier, so nobody stands at the step waiting for the person before.
    if (s.boarders === null) {
      s.boarders = this.boardersFor(v, s)
        .slice(0, this.seatsLeft(v))
        .map((r) => r.id);
    }
    while (s.boarders.length > 0) {
      const r = this.passengers.get(s.boarders[0]!);
      if (!r || r.phase !== 'waiting') {
        s.boarders.shift(); // walked off, or got on another jeepney
        s.next = null;
        continue;
      }
      if (!s.next || s.next.id !== r.id) {
        const place = this.freeSeat(v, r);
        if (place === undefined) {
          s.boarders.length = 0; // full
          break;
        }
        const motion = this.layouts[v.id]!.board(place.seat, this.localStart(v, r));
        s.next = { id: r.id, ...place, motion, inAfterS: this.timeToGetIn(v, motion) };
      }
      // Too early: they would only queue at the step behind the one before.
      if (this.clock + s.next.inAfterS < s.doorFreeAt) return;
      s.boarders.shift();
      r.vehicleId = r.lastVehicleId = v.id;
      r.seat = s.next.seat;
      r.room = s.next.room;
      if (s.next.usog) this.moveOver(v, s.next.usog, r);
      s.on++;
      this.transition(r, 'boarding');
      r.spot = null; // their place in the crowd is free again
      r.motion = s.next.motion;
      r.t = 0;
      r.motion.poseAt(0, r.pose);
      this.fleet.waiting[s.stop]!--;
      s.doorFreeAt = this.clock + s.next.inAfterS + DOOR_HEADWAY_S;
      s.next = null;
      return; // one more on the way each tick
    }
    // People are still waiting (another jeepney took some of this list):
    // take the next of them while there are seats.
    if (this.seatsLeft(v) > 0 && this.boardersFor(v, s).length > 0) {
      s.boarders = null;
      return;
    }
    // Pull away only once nobody is still on the step.
    if (this.tripsNow().onStep.has(v.id)) return;
    // Everyone queued is on. Someone hurrying to the stop with a seat left
    // for them: hold a moment, then board them like anyone else.
    if (
      s.flagS === undefined &&
      s.heldS < MAX_HOLD_S &&
      this.seatsLeft(v) > 0 &&
      this.hurryingTo(s.stop, v.direction)
    ) {
      s.heldS += dt;
      s.boarders = null; // pick them up as soon as they reach the stop
      return;
    }
    // At its terminal, in service: waits for riders until it is full enough
    // to set out, or has waited long enough (FILL), as drivers line up there.
    const fill = FILL[v.kind];
    if (
      s.terminal &&
      v.duty === 'service' &&
      s.fillS < fill.patienceS &&
      (this.tripsNow().aboard.get(v.id) ?? 0) < Math.ceil(fill.share * v.seats) &&
      this.waitingAhead(v, s.stop) < v.seats - (this.tripsNow().aboard.get(v.id) ?? 0) &&
      !this.queuedBehind(v)
    ) {
      s.fillS += dt;
      s.boarders = null; // whoever turns up gets on
      return;
    }
    this.finish(v, s);
  }

  /**
   * Riders waiting for `v` at its stops within FILL_LOOK_AHEAD_M after
   * `stop`: with as many as it has seats left, its driver sets out from the
   * terminal at once (they fill it on the way) instead of waiting there.
   */
  private waitingAhead(v: FleetVehicle, stop: number): number {
    const route = this.fleet.route;
    const ahead =
      v.kind === 'jeepney' || v.kind === 'modern'
        ? stopsAhead(route, stop, v.direction)
        : stopsAheadFor(route, v.kind, stop, v.direction);
    const from = route.stops[stop]!.s;
    const t = this.tripsNow();
    let n = 0;
    for (const i of ahead) {
      const d = route.loop
        ? aheadOf(route, from, route.stops[i]!.s)
        : Math.abs(route.stops[i]!.s - from);
      if (d > FILL_LOOK_AHEAD_M) break;
      if (!loadsAt(route, v, i)) continue;
      for (const r of t.waiting.get(i) ?? [])
        if (r.phase === 'waiting' && r.direction === v.direction) n++;
    }
    return n;
  }

  /**
   * Another vehicle stopped just behind `v`, waiting its turn at the stop:
   * the one in front leaves so the line moves (one loading bay), rather than
   * holding everyone behind it while it fills.
   */
  private queuedBehind(v: FleetVehicle): boolean {
    const route = this.fleet.route;
    return this.fleet.vehicles.some((o) => {
      if (o === v || o.duty === 'parked' || o.direction !== v.direction || o.speedMps > 0.5)
        return false;
      const d = route.loop ? aheadOf(route, o.s, v.s) : (v.s - o.s) * v.direction;
      return d > 0 && d < QUEUE_BEHIND_M;
    });
  }

  /**
   * Places free on `v` as of this tick, seats or standing (each jeepney takes
   * on at most one person a tick).
   */
  private seatsLeft(v: FleetVehicle): number {
    return v.capacity - (this.tripsNow().aboard.get(v.id) ?? 0);
  }

  /** Each seat free on `v`: whoever is standing nearest it (or hanging on) sits down. */
  private sitDown(v: FleetVehicle): void {
    // A pregnant rider without room yet has the seat beside her first.
    this.makeRoom(v);
    const layout = this.layouts[v.id]!;
    const taken = this.placesTaken(v);
    const standing: Passenger[] = [];
    for (const r of this.passengers.values()) {
      if (r.vehicleId !== v.id || r.seat === null) continue;
      if (r.phase === 'seated' && !r.motion && layout.seats[r.seat]!.stands) standing.push(r);
    }
    for (const seat of layout.seatOrder) {
      if (standing.length === 0) return;
      const place = layout.seats[seat]!;
      if (place.stands || taken.has(seat)) continue;
      const apart = (r: Passenger) => Math.abs(layout.seats[r.seat!]!.x - place.x);
      const nearest = standing.reduce((a, b) => (apart(b) < apart(a) ? b : a));
      standing.splice(standing.indexOf(nearest), 1);
      nearest.motion = layout.takeSeat(nearest.seat!, seat);
      nearest.seat = seat;
      nearest.t = 0;
    }
  }

  /**
   * Where `rider` sits on `v`: the first place free, or for a pregnant rider
   * the first seat with a free one beside it, kept for her (else any free).
   */
  private freeSeat(
    v: FleetVehicle,
    rider: Passenger,
  ): { seat: number; room: number | null; usog?: { id: number; to: number } } | undefined {
    const layout = this.layouts[v.id]!;
    const taken = this.placesTaken(v);
    const benchFree = layout.seatOrder.filter((k) => !taken.has(k) && !layout.seats[k]!.stands);
    if (kindOf(rider) === 'pregnant') {
      for (const seat of benchFree) {
        const room = this.seatBeside(v, seat, taken);
        if (room !== undefined) return { seat, room };
      }
      // No two free side by side: the one beside a free seat moves over to
      // another free seat (pakiusog), and the seat they leave is her room.
      for (const seat of benchFree) {
        const to = benchFree.find((k) => k !== seat);
        if (to === undefined) break;
        for (const room of this.seatsBeside(v, seat)) {
          const mover = this.riderIn(v, room);
          if (mover && this.canMoveOver(mover)) return { seat, room, usog: { id: mover.id, to } };
        }
      }
    }
    const seat = layout.seatOrder.find((k) => !taken.has(k));
    return seat === undefined ? undefined : { seat, room: null };
  }

  /** Sat still in their seat, and not one who needs room themselves: able to move over. */
  private canMoveOver(r: Passenger): boolean {
    return (
      r.phase === 'seated' && !r.motion && typeof r.room !== 'number' && kindOf(r) !== 'pregnant'
    );
  }

  private riderIn(v: FleetVehicle, seat: number): Passenger | undefined {
    for (const r of this.passengers.values()) if (r.vehicleId === v.id && r.seat === seat) return r;
    return undefined;
  }

  /** `usog.id` moves over to seat `usog.to`, leaving the seat beside `her` free for her. */
  private moveOver(v: FleetVehicle, usog: { id: number; to: number }, her: Passenger): void {
    const mover = this.passengers.get(usog.id);
    const from = mover?.seat;
    if (
      !mover ||
      typeof from !== 'number' ||
      from !== her.room ||
      !this.canMoveOver(mover) ||
      this.riderIn(v, usog.to)
    ) {
      her.room = null; // they have gone, or moved already: no room after all
      return;
    }
    mover.motion = this.layouts[v.id]!.takeSeat(from, usog.to);
    mover.seat = usog.to;
    mover.t = 0;
  }

  /** Places on `v` sat or stood in, and the seats kept beside pregnant riders. */
  private placesTaken(v: FleetVehicle): Set<number> {
    const taken = new Set<number>();
    for (const r of this.passengers.values()) {
      if (r.vehicleId !== v.id) continue;
      if (r.seat !== null) taken.add(r.seat);
      if (typeof r.room === 'number') taken.add(r.room);
    }
    return taken;
  }

  /** The free seat next to `seat` on the same bench (or in the same row), if any. */
  private seatBeside(
    v: FleetVehicle,
    seat: number,
    taken: ReadonlySet<number>,
  ): number | undefined {
    return this.seatsBeside(v, seat).find((k) => !taken.has(k));
  }

  /** The seats next to `seat` on the same bench (or in the same row), nearest first. */
  private seatsBeside(v: FleetVehicle, seat: number): number[] {
    const seats = this.layouts[v.id]!.seats;
    const at = seats[seat]!;
    const apart = (k: number) => Math.hypot(seats[k]!.x - at.x, seats[k]!.z - at.z);
    return seats
      .map((_, k) => k)
      .filter((k) => k !== seat && !seats[k]!.stands && seats[k]!.yaw === at.yaw)
      .filter((k) => apart(k) < NEXT_SEAT_M)
      .sort((x, y) => apart(x) - apart(y));
  }

  /** Each pregnant rider seated on `v` without room: the seat beside her, if it is free now. */
  private makeRoom(v: FleetVehicle): void {
    const seats = this.layouts[v.id]!.seats;
    for (const r of this.passengers.values()) {
      if (r.vehicleId !== v.id || typeof r.room === 'number' || r.seat === null) continue;
      if (r.phase !== 'seated' || r.motion || kindOf(r) !== 'pregnant' || seats[r.seat]!.stands)
        continue;
      const room = this.seatBeside(v, r.seat, this.placesTaken(v));
      if (room === undefined) continue;
      r.room = room;
      this.sitInRoom(r);
    }
  }

  /** Seated with room beside her: in the middle of her seat and the one kept. */
  private sitInRoom(r: Passenger): void {
    if (r.vehicleId === null || r.seat === null || typeof r.room !== 'number') return;
    const layout = this.layouts[r.vehicleId]!;
    layout.seated(r.seat, r.pose);
    const beside = layout.seated(r.room, this.scratch);
    r.pose.x = (r.pose.x + beside.x) / 2;
    r.pose.z = (r.pose.z + beside.z) / 2;
  }

  /**
   * Whether jeepney `v`, at `stop`, goes to `destination`: its signboard
   * names its next terminal, and it calls at every stop on the way there.
   * A rider only gets on a jeepney that does.
   */
  goesTo(v: FleetVehicle, stop: number, destination: number): boolean {
    const key = `${v.kind}:${stop * 2 + (v.direction === 1 ? 0 : 1)}`;
    let ahead = this.callsAt.get(key);
    if (!ahead) {
      // A jeepney calls everywhere to its next terminal; a bus or UV Express
      // only at the stops it serves, up to its own terminal.
      ahead = new Set(
        v.kind === 'jeepney' || v.kind === 'modern'
          ? stopsAhead(this.fleet.route, stop, v.direction)
          : stopsAheadFor(this.fleet.route, v.kind, stop, v.direction),
      );
      this.callsAt.set(key, ahead);
    }
    return ahead.has(destination);
  }

  /** Who can get on `v` where it has stopped, in the order they came. */
  private boardersFor(v: FleetVehicle, { stop, flagS }: Service): Passenger[] {
    if (flagS === undefined && !loadsAt(this.fleet.route, v, stop)) return [];
    // The tick's list of people there; phase read live, as one may have just
    // got on another jeepney.
    const { flagging, waiting } = this.tripsNow();
    const there =
      flagS === undefined
        ? (waiting.get(stop) ?? [])
        : flagging.filter((r) => r.flagS === flagS && (r.originStop === stop || r.byStreet));
    return there
      .filter(
        (r) =>
          r.phase === 'waiting' &&
          r.direction === v.direction &&
          r.passedOn !== v.id &&
          this.goesTo(v, stop, r.destinationStop),
      )
      .sort((a, b) => {
        const joinedA = a.history.find((h) => h.phase === 'waiting')!.at;
        const joinedB = b.history.find((h) => h.phase === 'waiting')!.at;
        return joinedA - joinedB || a.id - b.id;
      });
  }

  /** Where waiting rider `r` stands, in jeepney `v`'s own frame. */
  private localStart(v: FleetVehicle, r: Passenger): Point3 {
    const pose = this.poseAt(v.id, this.vehiclePose);
    const dx = r.pose.x - pose.x;
    const dz = r.pose.z - pose.z;
    return [
      dx * Math.cos(pose.heading) - dz * Math.sin(pose.heading),
      0,
      dx * Math.sin(pose.heading) + dz * Math.cos(pose.heading),
    ];
  }

  /** Seconds into a boarding motion when the rider is inside the cabin. */
  private timeToGetIn(v: FleetVehicle, motion: RiderMotion): number {
    const layout = this.layouts[v.id]!;
    for (let t = 0; t <= motion.duration; t += 1 / 30)
      if (layout.isInside(motion.poseAt(t, this.scratch))) return t;
    return motion.duration;
  }

  /**
   * Whether jeepney `v` needs to stop at `stop`: someone on board gets off
   * there, or someone there can get on (it has a seat, and goes where they
   * are going). Terminals always. Otherwise it drives past, as a jeepney
   * does when nobody calls "para" and nobody is waiting.
   */
  dropsAt(v: FleetVehicle, stop: number): boolean {
    const t = this.tripsNow();
    if (stopRoles(this.fleet.route, v.kind).terminal[stop]) return (t.aboard.get(v.id) ?? 0) > 0;
    return t.gettingOff.get(v.id)?.has(stop) ?? false;
  }

  wantsStop(v: FleetVehicle, stop: number): boolean {
    const roles = stopRoles(this.fleet.route, v.kind);
    if (roles.terminal[stop]) return true;
    // Not its stop at all (a jeepney station, for a bus).
    if (!roles.serves[stop] && !roles.loads[stop]) return false;
    const t = this.tripsNow();
    if (t.gettingOff.get(v.id)?.has(stop)) return true;
    if ((t.aboard.get(v.id) ?? 0) >= v.capacity) return false;
    if (!loadsAt(this.fleet.route, v, stop)) return false;
    if (this.handedOverTo(v, stop)) return true;
    return (t.waiting.get(stop) ?? []).some(
      (r) => r.direction === v.direction && this.goesTo(v, stop, r.destinationStop),
    );
  }

  /** How many are still on their way to `stop`, going `v`'s way (there within `withinS`, if given). */
  comingTo(v: FleetVehicle, stop: number, withinS = Infinity): number {
    let n = 0;
    for (const r of this.passengers.values())
      if (
        r.phase === 'approaching' &&
        r.originStop === stop &&
        r.direction === v.direction &&
        (!r.motion || r.motion.duration - r.t <= withinS)
      )
        n++;
    return n;
  }

  /**
   * Whether riders passed on are switching to `v` at `stop`: its driver was told,
   * so it stops for them, even while they are still getting down from the other.
   */
  private handedOverTo(v: FleetVehicle, stop: number): boolean {
    const ids = this.handedOver.get(stop);
    if (!ids) return false;
    let coming = false;
    for (const id of ids) {
      const r = this.passengers.get(id);
      // Taken on by the one behind (or gone): no longer anyone's to stop for.
      if (!r || (r.vehicleId !== null && r.vehicleId !== r.passedOn)) ids.delete(id);
      else if (r.passedOn !== v.id && this.goesTo(v, stop, r.thenTo ?? r.destinationStop))
        coming = true;
    }
    if (ids.size === 0) this.handedOver.delete(stop);
    return coming;
  }

  /**
   * Who is aboard each jeepney, where they get off, and who waits where,
   * worked out once per tick: the fleet asks wantsStop for every jeepney
   * every tick, and scanning every rider each time would not scale.
   */
  private tripsNow(): Trips {
    const t = this.trips;
    if (t.at === this.clock) return t;
    // Refilled in place, not rebuilt: this runs every tick.
    t.at = this.clock;
    t.aboard.clear();
    for (const set of t.gettingOff.values()) set.clear();
    for (const list of t.waiting.values()) list.length = 0;
    t.flagging.length = 0;
    t.crossing.length = 0;
    t.doorBusy.clear();
    t.onStep.clear();
    for (const r of this.passengers.values()) {
      const c = r.crossings?.[0];
      if (c?.hailing && r.vehicleId === null) {
        c.at = { x: r.pose.x, z: r.pose.z };
        t.crossing.push(c);
      }
      if (r.vehicleId !== null) {
        t.aboard.set(r.vehicleId, (t.aboard.get(r.vehicleId) ?? 0) + 1);
        if (r.phase === 'seated' || r.phase === 'boarding') {
          let set = t.gettingOff.get(r.vehicleId);
          if (!set) t.gettingOff.set(r.vehicleId, (set = new Set()));
          set.add(r.destinationStop);
        }
        if (r.phase === 'alighting') t.doorBusy.add(r.vehicleId);
        if (r.phase === 'alighting' || (r.phase === 'boarding' && !r.inside))
          t.onStep.add(r.vehicleId);
      } else if (r.flagS !== undefined && r.phase === 'waiting') {
        t.flagging.push(r);
      } else if (r.flagS !== undefined && r.phase === 'approaching') {
        // Not at the roadside yet: nothing to stop for.
      } else if (
        r.phase === 'waiting' ||
        // Someone nearly at the stop is worth stopping for (they will be waited for).
        (r.phase === 'approaching' && !!r.motion && r.motion.duration - r.t <= RUNNER_WITHIN_S)
      ) {
        let list = t.waiting.get(r.originStop);
        if (!list) t.waiting.set(r.originStop, (list = []));
        list.push(r);
      } else if (
        r.phase === 'walking' &&
        r.t < CLEAR_DOOR_S &&
        r.lastVehicleId !== null &&
        !(c && !c.stepped && c.heldS > 0)
      ) {
        // Just stepped off: still in the doorway. Not someone stopped at the
        // kerb to cross: they may be waiting for this very vehicle to go.
        t.doorBusy.add(r.lastVehicleId);
      }
    }
    return t;
  }

  /** Someone walking up to `stop`, going `direction`, who is nearly there. */
  private hurryingTo(stop: number, direction: 1 | -1): boolean {
    // The tick's list holds only those within RUNNER_WITHIN_S of the stop.
    return (this.tripsNow().waiting.get(stop) ?? []).some(
      (r) => r.phase === 'approaching' && r.direction === direction,
    );
  }

  private walkAway(r: Passenger): void {
    const s = this.services.get(r.vehicleId!)!;
    this.worldPose(r.id, this.scratch);
    Object.assign(r.pose, this.scratch);
    r.vehicleId = null;
    r.seat = null;
    r.inside = false;
    const route = this.fleet.route;
    // Changing jeepneys at a terminal on the way home, or passed on by their
    // driver: into the line for the next one.
    if (r.thenTo !== undefined && (r.passedOn !== undefined || isTerminal(route, s.stop))) {
      this.changeAt(r, s.stop);
      return;
    }
    // Where they actually got off (a terminal puts everyone off).
    r.destinationStop = s.stop;
    // Off the back step, up onto the pavement where they are (at the stop,
    // or further back if let off in a queue), and away. They fade out once
    // there.
    const here = alongFrom(route, s.stop, r.direction, r.pose);
    const kerbside = pavementPoint(route, s.stop, r.direction, here, 0.6);
    const target = leavingSpot(route, s.stop, r.direction, r.id, here);
    // On to where the trip is going, or to home or work along the side streets, when known.
    r.motion =
      this.toOnward(r, s.stop) ??
      this.toStreets(r, s.stop, kerbside) ??
      RiderMotion.walking([
        [r.pose.x, 0, r.pose.z],
        [kerbside.x, 0, kerbside.z],
        [target.x, 0, target.z],
      ]);
    r.t = 0;
    this.transition(r, 'walking');
  }

  /** The commuter app's own rider, off at the kerb: on to where they said they were going. */
  private toOnward(r: Passenger, stop: number): RiderMotion | null {
    if (!r.onward) return null;
    const { way, mode, to } = r.onward;
    r.leaveMode = mode;
    const line = onwardLine(this.fleet.route, this.fleet.route.stops[stop]!.s, way, to);
    return mode === 'tricycle'
      ? RiderMotion.tricycle(line)
      : this.onFoot('walk', [[r.pose.x, 0, r.pose.z], ...line]);
  }

  /** Off at terminal `stop` to change jeepneys: a few steps to its waiting area, then in line. */
  private changeAt(r: Passenger, stop: number): void {
    const target = waitingSpot(
      this.fleet.route,
      stop,
      r.direction,
      r.id,
      this.othersAt(stop, r.direction),
    );
    r.originStop = stop;
    r.destinationStop = r.thenTo!;
    r.thenTo = undefined;
    r.spot = target;
    r.motion = RiderMotion.walking([
      [r.pose.x, 0, r.pose.z],
      [target.x, 0, target.z],
    ]);
    r.t = 0;
    this.transition(r, 'approaching');
    this.fleet.waiting[stop]!++;
    this.trips.at = -1;
  }

  private transition(r: Passenger, phase: PassengerPhase): void {
    if (phase === 'arrived') this.metrics.completed++;
    r.phase = phase;
    r.history.push({ phase, at: this.clock });
  }

  /** Everyone on `vehicle`, with the place they have (null when they have none yet). */
  forEachRider(
    vehicle: number,
    visit: (id: number, pose: RiderPose, place: Seat | null) => void,
  ): void {
    const seats = this.layouts[vehicle]!.seats;
    for (const r of this.passengers.values())
      if (r.vehicleId === vehicle) visit(r.id, r.pose, r.seat === null ? null : seats[r.seat]!);
  }

  forEachOutside(visit: (rider: Passenger) => void): void {
    for (const r of this.passengers.values()) if (r.vehicleId === null) visit(r);
  }

  worldPose(id: number, out: RiderPose): RiderPose | null {
    const r = this.passengers.get(id);
    if (!r) return null;
    Object.assign(out, r.pose);
    if (r.vehicleId !== null) {
      const vehicle = this.poseAt(r.vehicleId, this.vehiclePose);
      const c = Math.cos(vehicle.heading),
        s = Math.sin(vehicle.heading);
      out.x = vehicle.x + r.pose.x * c + r.pose.z * s;
      out.z = vehicle.z - r.pose.x * s + r.pose.z * c;
      out.yaw += vehicle.heading;
    }
    return out;
  }
}
