/**
 * Deterministic SakaySightAI Intelligence Engine (Server-side /api).
 *
 * Computes exact mathematical answers for the two core personas BEFORE (or
 * without) calling the Meta LLM:
 *
 * 1. COMMUTER INTELLIGENCE:
 *    - When will the next jeepney arrive at my stop / house km mark?
 *    - Will it actually have free seats when it reaches me (accounting for
 *      passengers dropping off and boarding at stops in between)?
 *    - If the nearest jeepney will be full, when does the next jeepney with
 *      open seats arrive?
 *    - What is the exact LTFRB fare for that vehicle (Regular vs. 20%
 *      Student/Senior/PWD)?
 *
 * 2. DRIVER & FLEET DISPATCH INTELLIGENCE (FCFS Conflict Resolution + Fuel):
 *    - Where are waiting passengers located (stop & km mark)?
 *    - Where are current onboard passengers dropping off (alighting)?
 *    - Multi-Jeepney First-Come, First-Served (FCFS) Conflict Resolution:
 *      Nearest jeepney to a stop claims waiting passengers first up to its
 *      available seat capacity (after drop-offs). Trailing jeepneys only see
 *      the remaining unclaimed riders, preventing two jeepneys from racing
 *      for the same crowd.
 *    - Fuel & Gas Savings Calculator (in km, Liters, and ₱ Pesos):
 *      Calculates cruising fuel burn (L/km adjusted by passenger load),
 *      stop-and-go braking/idling penalty (~0.028 L = 0.20 km equivalent per
 *      stop), and exact fuel/peso savings from skipping empty or already-claimed
 *      stops when no onboard passenger is dropping off there.
 */

import {
  tripBudget,
  type TripRoute,
  type TripBudget,
  type TripBudgetInputs,
} from '../../src/core/advisory/tripBudget.js';
import { FARE_BY_VEHICLE, fareFor } from '../../src/core/fare.js';
import { KIND_WORD, type FleetKind } from '../../src/core/vehicles/specs.js';

export interface RawSnapshot {
  tripRoute?: TripRoute;
  route?: {
    name?: string;
    source?: string;
    lengthKm?: number;
    stops?: Array<{
      name: string;
      sKm?: number;
      s?: number;
      waiting?: number;
      terminal?: boolean;
    }>;
  };
  simulatedFleet?: Array<{
    id?: string;
    plate: string;
    /** What it is (a traditional jeepney when not said): its fare and where it loads. */
    kind?: FleetKind;
    occupancy: number;
    capacity: number;
    kmh: number;
    nextStop?: string;
    sKm?: number;
    /** Optional explicit drop-off counts keyed by stop name. */
    dropOffs?: Record<string, number>;
    /** Seconds to each stop by name, as the app's screens work them out. */
    etaS?: Record<string, number>;
  }>;
  waitingAtStops?: Record<string, number>;
  liveSessions?: Array<{
    sessionId: string;
    link: string;
    matchedToRoute: boolean;
    offsetFromRoadM: number | null;
    kmh: number;
    accuracyM: number | null;
  }>;
  doorway?: {
    current?: number;
    boarded?: number;
    alighted?: number;
    seenNow?: number;
    seenSteady?: number;
    fps?: number;
    latencyMs?: number;
  };
}

export interface PlanOptions {
  tripBudgetInputs?: Partial<TripBudgetInputs>;
  dieselPriceBasis?: string;
  question?: string;
  role?: 'commuter' | 'driver' | 'operator' | 'auto';
  driverPlate?: string;
  commuterStop?: string;
  destinationStop?: string;
  commuterKm?: number;
  dieselPricePhpPerLiter?: number;
}

export interface StopNode {
  index: number;
  name: string;
  sKm: number;
  /** Everyone gets off here. */
  terminal: boolean;
  initialWaiting: number;
  unclaimedWaiting: number;
  claimedBy: Array<{ plate: string; etaSeconds: number; boarded: number }>;
}

export type StopActionKind =
  | 'STOP_PICKUP_AND_DROPOFF'
  | 'STOP_PICKUP_ONLY'
  | 'STOP_DROPOFF_ONLY'
  | 'SKIP_CLAIMED_BY_CLOSER_JEEPNEY'
  | 'SKIP_FULL_CAPACITY'
  | 'SKIP_EMPTY_STOP';

export interface DriverStopDecision {
  stopName: string;
  stopKm: number;
  distanceAheadKm: number;
  etaSeconds: number;
  etaMinutes: number;
  action: StopActionKind;
  dropOffsHere: number;
  totalWaitingAtStop: number;
  unclaimedWaitingForYou: number;
  expectedBoardingsHere: number;
  claimedEarlierByPlates: string[];
  occupancyBefore: number;
  occupancyAfter: number;
  freeSeatsAfter: number;
  fuelSavedLitersIfSkipped: number;
  fuelSavedPhpIfSkipped: number;
  reason: string;
}

export interface DriverDispatchPlan {
  plate: string;
  kind: FleetKind;
  currentKm: number;
  speedKmh: number;
  currentOccupancy: number;
  capacity: number;
  nextStopName: string;
  remainingRouteKm: number;
  bestPriorityStop: string | null;
  stopsToStopAt: number;
  stopsToSkip: number;
  totalExpectedBoardings: number;
  totalExpectedDropOffs: number;
  projectedGrossFarePhp: number;
  cruisingFuelLiters: number;
  stopGoFuelLiters: number;
  totalFuelLiters: number;
  totalFuelCostPhp: number;
  fuelSavedBySkippingLiters: number;
  fuelSavedBySkippingPhp: number;
  equivalentKmSaved: number;
  netDriverTakeHomePhp: number;
  stopDecisions: DriverStopDecision[];
  driverSummary: string;
}

export interface CommuterJeepneyArrival {
  plate: string;
  kind: FleetKind;
  distanceAwayKm: number;
  etaSeconds: number;
  etaMinutes: number;
  currentOccupancy: number;
  capacity: number;
  projectedOccupancyAtYourStop: number;
  projectedFreeSeatsAtYourStop: number;
  /** Free seats minus the people already queued at the stop, who board first. */
  seatsLeftForYou: number;
  willHaveSeatForYou: boolean;
}

export interface CommuterStopAdvice {
  stopName: string;
  stopKm: number;
  waitingAheadOfYou: number;
  destinationStopName: string;
  destinationKm: number;
  tripDistanceKm: number;
  regularFarePhp: number;
  discountedFarePhp: number;
  status: 'BOARD_NEAREST' | 'WAIT_FOR_NEXT_WITH_SEATS' | 'NO_JEEPNEY_WITH_SEATS';
  nearestJeepney: CommuterJeepneyArrival | null;
  recommendedJeepney: CommuterJeepneyArrival | null;
  approachingJeepneys: CommuterJeepneyArrival[];
  commuterSummary: string;
}

export interface SceneStopBadge {
  stopName: string;
  stopKm: number;
  kind: 'stop' | 'skip' | 'conflict-avoided';
  label: string;
  detail: string;
}

export interface SceneActionDirective {
  /** Which jeepney plate the 3D camera can focus/follow based on the AI answer. */
  focusVehiclePlate: string | null;
  /** Which stop on the 3D map is the primary focus of the AI answer. */
  focusStopName: string | null;
  /** Suggested 3D camera view for this persona ('pov' for driver, 'chase' for commuter/operator). */
  suggestedCameraView: 'pov' | 'chase' | 'overview';
  /** Floating 3D map badges per stop showing STOP/SKIP/FCFS status and fuel saved. */
  stopBadges: SceneStopBadge[];
}

export interface CommutePlanResult {
  tripBudget?: TripBudget;
  detectedRole: 'commuter' | 'driver' | 'operator';
  route: {
    name: string;
    lengthKm: number;
    totalWaiting: number;
    activeJeepneys: number;
    liveGpsPhones: number;
  };
  stops: StopNode[];
  driverPlans: DriverDispatchPlan[];
  focusedDriverPlan: DriverDispatchPlan | null;
  commuterAdviceByStop: Record<string, CommuterStopAdvice>;
  focusedCommuterAdvice: CommuterStopAdvice | null;
  sceneActions: SceneActionDirective;
  directAnswer: string;
}

/**
 * Traditional Philippine diesel jeepney (Isuzu 4JB1 / 4BC2 2.8L-3.3L) fuel constants:
 * - Base cruise burn: 0.14 L/km empty + 0.0025 L/km per onboard passenger
 * - Stop-and-go cycle (deceleration + boarding dwell idle + 1st/2nd gear launch): 0.028 L
 *   (0.028 L / 0.14 L/km = 0.20 km of equivalent cruising distance per stop)
 *
 * The same numbers as ADVISORY in src/core/advisory/model.ts, so the assistant
 * and the screens agree (planner.test.ts holds them together); not imported,
 * because that file brings the bundled price data with it.
 */
export const COSTS = { baseLPerKm: 0.14, perRiderLPerKm: 0.0025, stopGoL: 0.028 };
const BASE_L_PER_KM = COSTS.baseLPerKm;
const LOAD_L_PER_KM_PER_PAX = COSTS.perRiderLPerKm;
const STOP_GO_PENALTY_LITERS = COSTS.stopGoL;
export const STOP_DWELL_SECONDS = 30;
/**
 * Used only when the app does not send this week's price
 * (dieselPricePhpPerLiter). DOE NCR common diesel price, Oct 20–26 2026:
 * ₱95.80 Caloocan, ₱93.30 Quezon City. The old ₱58 predates the 2026 rise.
 */
const DEFAULT_DIESEL_PHP = 94.55;
const MIN_EFFECTIVE_KMH = 14;
/** The usual ride, for a rough day's fares (one short trip's first-distance fare). */
const AVERAGE_RIDE_KM = 3.8;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Build ordered stops with kilometer markers from whatever snapshot fields are present. */
function extractStops(snapshot: RawSnapshot, routeLengthKm: number): StopNode[] {
  const explicit = snapshot.route?.stops;
  if (explicit && explicit.length > 0) {
    return explicit.map((s, idx) => {
      const sKm =
        typeof s.sKm === 'number'
          ? s.sKm
          : typeof s.s === 'number'
            ? s.s / 1000
            : (idx / Math.max(1, explicit.length - 1)) * routeLengthKm;
      const w = s.waiting ?? snapshot.waitingAtStops?.[s.name] ?? 0;
      return {
        index: idx,
        name: s.name,
        sKm: round2(sKm),
        terminal: s.terminal === true,
        initialWaiting: w,
        unclaimedWaiting: w,
        claimedBy: [],
      };
    });
  }

  const entries = Object.entries(snapshot.waitingAtStops ?? {});
  if (entries.length === 0) {
    return [
      {
        index: 0,
        name: 'Origin Terminal',
        sKm: 0,
        terminal: true,
        initialWaiting: 0,
        unclaimedWaiting: 0,
        claimedBy: [],
      },
      {
        index: 1,
        name: 'Destination Terminal',
        sKm: routeLengthKm,
        terminal: true,
        initialWaiting: 0,
        unclaimedWaiting: 0,
        claimedBy: [],
      },
    ];
  }

  return entries.map(([name, waiting], idx) => {
    const sKm = (idx / Math.max(1, entries.length - 1)) * routeLengthKm;
    const w = typeof waiting === 'number' && Number.isFinite(waiting) ? Math.max(0, waiting) : 0;
    return {
      index: idx,
      name,
      sKm: round2(sKm),
      terminal: false,
      initialWaiting: w,
      unclaimedWaiting: w,
      claimedBy: [],
    };
  });
}

/**
 * Estimate where onboard passengers (`occupancy`) will drop off across upcoming
 * stops when explicit per-passenger drop-off destinations are not provided.
 * Commercial/transfer stops and the final terminal receive higher alighting weights.
 * With explicit ones, a rider bound beyond the stops listed stays on past them;
 * only a terminal empties the vehicle.
 */
function estimateDropOffsByStop(
  occupancy: number,
  upcomingStops: readonly StopNode[],
  explicitDropOffs?: Record<string, number>,
): number[] {
  if (upcomingStops.length === 0 || occupancy <= 0) return upcomingStops.map(() => 0);

  if (explicitDropOffs) {
    let remaining = occupancy;
    return upcomingStops.map((st) => {
      const wanted = st.terminal ? remaining : Math.round(explicitDropOffs[st.name] ?? 0);
      const count = Math.min(remaining, Math.max(0, wanted));
      remaining -= count;
      return count;
    });
  }

  // Deterministic demand-weighted alighting profile:
  // Mid-route commercial stops get moderate drop-offs; the terminal gets all remaining riders.
  const weights = upcomingStops.map((st, idx) => {
    if (idx === upcomingStops.length - 1) return 3.2; // The terminal hub.
    if (idx === 0) return 0.6;
    return 1.0 + (st.initialWaiting > 4 ? 0.5 : 0);
  });
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let remaining = occupancy;
  return upcomingStops.map((_, idx) => {
    if (idx === upcomingStops.length - 1) return remaining;
    const share = Math.min(remaining, Math.floor((occupancy * (weights[idx] ?? 1)) / weightSum));
    remaining -= share;
    return share;
  });
}

/** Detect whether the question is from a commuter, a driver, or a fleet operator. */
function detectPersona(
  question: string,
  explicitRole?: PlanOptions['role'],
): 'commuter' | 'driver' | 'operator' {
  if (explicitRole && explicitRole !== 'auto') return explicitRole;
  const q = question.toLowerCase();
  if (
    /\b(commuter|passenger|ride|waiting at|my house|near me|when will|eta|arrive|fare|magkano|pamasahe|student|senior|pwd|seat)\b/.test(
      q,
    ) &&
    !/\b(fuel|gas|diesel|save|skip|conflict|dispatch|driver)\b/.test(q)
  ) {
    return 'commuter';
  }
  if (
    /\b(fuel|gas|diesel|save|drop-?off|alight|driver|my jeep|skip|route path|conflict)\b/.test(q)
  ) {
    return 'driver';
  }
  return 'operator';
}

export function buildCommutePlan(
  rawSnapshot: unknown,
  options: PlanOptions = {},
): CommutePlanResult {
  const snapshot = (
    rawSnapshot && typeof rawSnapshot === 'object' ? rawSnapshot : {}
  ) as RawSnapshot;
  const budget = tripBudget(
    options.question ?? '',
    snapshot.tripRoute,
    { dieselPhpPerL: options.dieselPricePhpPerLiter, ...options.tripBudgetInputs },
    [],
    options.dieselPriceBasis,
  );
  if (budget)
    return {
      tripBudget: budget,
      detectedRole: 'driver',
      route: {
        name: snapshot.tripRoute?.name ?? snapshot.route?.name ?? 'Route unavailable',
        lengthKm: snapshot.tripRoute?.lengthKm ?? 0,
        totalWaiting: 0,
        activeJeepneys: snapshot.simulatedFleet?.length ?? 0,
        liveGpsPhones: snapshot.liveSessions?.length ?? 0,
      },
      stops: [],
      driverPlans: [],
      focusedDriverPlan: null,
      commuterAdviceByStop: {},
      focusedCommuterAdvice: null,
      sceneActions: {
        focusVehiclePlate: null,
        focusStopName: null,
        suggestedCameraView: 'overview',
        stopBadges: [],
      },
      directAnswer: budget.answer,
    };
  const routeName = snapshot.route?.name ?? 'this route';
  const furthestStopKm = Math.max(
    1,
    ...(snapshot.route?.stops ?? []).map((s) => s.sKm ?? (s.s ?? 0) / 1000),
  );
  const routeLengthKm =
    typeof snapshot.route?.lengthKm === 'number' && snapshot.route.lengthKm > 0
      ? snapshot.route.lengthKm
      : furthestStopKm;
  const dieselPhp = options.dieselPricePhpPerLiter ?? DEFAULT_DIESEL_PHP;

  const stops = extractStops(snapshot, routeLengthKm);
  const rawVehicles = snapshot.simulatedFleet ?? [];

  // 1. Place each vehicle along the route (sKm) and list its upcoming stops.
  const vehicles = rawVehicles.map((v, idx) => {
    const nextIdx = stops.findIndex((s) => s.name === v.nextStop);
    const resolvedNextIdx = nextIdx >= 0 ? nextIdx : Math.min(stops.length - 1, 1);
    const prevKm = resolvedNextIdx > 0 ? (stops[resolvedNextIdx - 1]?.sKm ?? 0) : 0;
    const nextKm = stops[resolvedNextIdx]?.sKm ?? routeLengthKm;
    const inferredKm =
      typeof v.sKm === 'number'
        ? v.sKm
        : round2(prevKm + ((idx % 3) + 1) * 0.22 * (nextKm - prevKm));
    const currentKm = Math.max(0, Math.min(routeLengthKm, inferredKm));
    const upcomingStops = stops.filter((s) => s.sKm >= currentKm - 0.01);
    const effectiveKmh = Math.max(MIN_EFFECTIVE_KMH, v.kmh > 1 ? v.kmh : 22);
    const dropOffsPerUpcoming = estimateDropOffsByStop(
      Math.max(0, v.occupancy),
      upcomingStops,
      v.dropOffs,
    );

    return {
      plate: v.plate || `JEEP-${idx + 1}`,
      kind: v.kind ?? ('jeepney' as FleetKind),
      etaS: v.etaS,
      currentKm,
      speedKmh: Math.max(0, v.kmh),
      effectiveKmh,
      currentOccupancy: Math.max(0, v.occupancy),
      capacity: Math.max(1, v.capacity || 22),
      nextStopName: v.nextStop ?? stops[resolvedNextIdx]?.name ?? stops[0]!.name,
      upcomingStops,
      dropOffsPerUpcoming,
    };
  });

  // 2. First-Come, First-Served (FCFS) Multi-Jeepney Simulation:
  //    We step through stops in route order. At each stop, approaching jeepneys
  //    are ordered by earliest arrival (nearest / lowest ETA wins waiting riders first).
  interface SimState {
    occupancy: number;
    cumulativeDwellS: number;
    decisions: Map<string, DriverStopDecision>;
  }
  const simByPlate = new Map<string, SimState>();
  for (const v of vehicles) {
    simByPlate.set(v.plate, {
      occupancy: v.currentOccupancy,
      cumulativeDwellS: 0,
      decisions: new Map(),
    });
  }

  for (const stop of stops) {
    // Find all vehicles that will pass this stop, sorted by ETA (First-Come, First-Served).
    const approaching = vehicles
      .map((v) => {
        const upIdx = v.upcomingStops.findIndex((u) => u.name === stop.name);
        if (upIdx === -1) return null;
        const sim = simByPlate.get(v.plate)!;
        const distKm = Math.max(0, stop.sKm - v.currentKm);
        const driveSeconds = (distKm / v.effectiveKmh) * 3600;
        // The screens' own time when sent: they go by how long the road is taking.
        const etaSeconds = Math.round(v.etaS?.[stop.name] ?? driveSeconds + sim.cumulativeDwellS);
        const dropOffsHere = v.dropOffsPerUpcoming[upIdx] ?? 0;
        return { v, sim, distKm, etaSeconds, dropOffsHere };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.etaSeconds - b.etaSeconds);

    for (const item of approaching) {
      const { v, sim, distKm, etaSeconds, dropOffsHere } = item;
      const occBefore = sim.occupancy;
      const occAfterDrop = Math.max(0, occBefore - dropOffsHere);
      const freeSeatsForBoarding = Math.max(0, v.capacity - occAfterDrop);

      const claimedEarlierByPlates = stop.claimedBy.map((c) => c.plate);
      const unclaimedHere = stop.unclaimedWaiting;
      // A UV Express takes riders on only at its terminals (core/vehicles/stops.ts).
      const loadsHere = v.kind !== 'uv' || stop.terminal;
      const boardedHere = loadsHere ? Math.min(unclaimedHere, freeSeatsForBoarding) : 0;

      let action: StopActionKind;
      let reason: string;

      if (dropOffsHere > 0 && boardedHere > 0) {
        action = 'STOP_PICKUP_AND_DROPOFF';
        reason = `Stop at ${stop.name}: drop off ${dropOffsHere} rider(s) and pick up ${boardedHere} waiting rider(s).`;
      } else if (dropOffsHere > 0 && boardedHere === 0) {
        action = 'STOP_DROPOFF_ONLY';
        reason =
          stop.initialWaiting > 0 && unclaimedHere === 0
            ? `Stop briefly at ${stop.name} for ${dropOffsHere} drop-off(s) only (${claimedEarlierByPlates.join(', ')} is closer and claims the ${stop.initialWaiting} waiting rider(s)).`
            : `Stop at ${stop.name} to let ${dropOffsHere} passenger(s) alight.`;
      } else if (!loadsHere) {
        action = 'SKIP_EMPTY_STOP';
        reason = `Pass ${stop.name}: a UV Express takes riders on only at its terminals.`;
      } else if (boardedHere > 0) {
        action = 'STOP_PICKUP_ONLY';
        reason = `Stop at ${stop.name} (${stop.sKm.toFixed(1)} km): you are in FCFS position to pick up ${boardedHere} waiting rider(s).`;
      } else if (stop.initialWaiting > 0 && unclaimedHere === 0) {
        action = 'SKIP_CLAIMED_BY_CLOSER_JEEPNEY';
        reason = `FCFS conflict avoided at ${stop.name}: closer vehicle ${claimedEarlierByPlates.join(', ')} arrives first and claims all ${stop.initialWaiting} waiting rider(s), and you have 0 drop-offs here. Cruise past to save ${STOP_GO_PENALTY_LITERS * 1000} mL diesel.`;
      } else if (freeSeatsForBoarding === 0 && stop.initialWaiting > 0) {
        action = 'SKIP_FULL_CAPACITY';
        reason = `Bypass ${stop.name}: cabin is full (${occAfterDrop}/${v.capacity}) with 0 drop-offs here; leave the ${unclaimedHere} waiting rider(s) for the next vehicle behind you.`;
      } else {
        action = 'SKIP_EMPTY_STOP';
        reason = `Bypass ${stop.name}: 0 waiting riders and 0 drop-offs—maintain cruising speed to save fuel.`;
      }

      const didStop =
        action === 'STOP_PICKUP_AND_DROPOFF' ||
        action === 'STOP_PICKUP_ONLY' ||
        action === 'STOP_DROPOFF_ONLY';

      if (boardedHere > 0) {
        stop.unclaimedWaiting -= boardedHere;
        stop.claimedBy.push({ plate: v.plate, etaSeconds, boarded: boardedHere });
      }

      const occAfter = occAfterDrop + boardedHere;
      sim.occupancy = occAfter;
      if (didStop) sim.cumulativeDwellS += STOP_DWELL_SECONDS;

      sim.decisions.set(stop.name, {
        stopName: stop.name,
        stopKm: stop.sKm,
        distanceAheadKm: round2(distKm),
        etaSeconds,
        etaMinutes: round2(etaSeconds / 60),
        action,
        dropOffsHere,
        totalWaitingAtStop: stop.initialWaiting,
        unclaimedWaitingForYou: unclaimedHere,
        expectedBoardingsHere: boardedHere,
        claimedEarlierByPlates,
        occupancyBefore: occBefore,
        occupancyAfter: occAfter,
        freeSeatsAfter: Math.max(0, v.capacity - occAfter),
        fuelSavedLitersIfSkipped: didStop ? 0 : STOP_GO_PENALTY_LITERS,
        fuelSavedPhpIfSkipped: didStop ? 0 : round2(STOP_GO_PENALTY_LITERS * dieselPhp),
        reason,
      });
    }
  }

  // 3. Compile complete DriverDispatchPlan for each jeepney (with fuel & revenue math).
  const driverPlans: DriverDispatchPlan[] = vehicles.map((v) => {
    const sim = simByPlate.get(v.plate)!;
    const stopDecisions = v.upcomingStops.map((s) => sim.decisions.get(s.name)!).filter(Boolean);

    const remainingRouteKm = round2(Math.max(0, routeLengthKm - v.currentKm));
    const avgOcc =
      stopDecisions.length > 0
        ? stopDecisions.reduce((s, d) => s + d.occupancyAfter, 0) / stopDecisions.length
        : v.currentOccupancy;

    const lPerKm = BASE_L_PER_KM + avgOcc * LOAD_L_PER_KM_PER_PAX;
    const cruisingFuelLiters = round3(remainingRouteKm * lPerKm);

    const stopsToStopAt = stopDecisions.filter((d) => d.action.startsWith('STOP_')).length;
    const stopsToSkip = stopDecisions.filter((d) => d.action.startsWith('SKIP_')).length;

    const stopGoFuelLiters = round3(stopsToStopAt * STOP_GO_PENALTY_LITERS);
    const totalFuelLiters = round3(cruisingFuelLiters + stopGoFuelLiters);
    const totalFuelCostPhp = round2(totalFuelLiters * dieselPhp);

    const fuelSavedBySkippingLiters = round3(stopsToSkip * STOP_GO_PENALTY_LITERS);
    const fuelSavedBySkippingPhp = round2(fuelSavedBySkippingLiters * dieselPhp);
    const equivalentKmSaved = round2(fuelSavedBySkippingLiters / BASE_L_PER_KM);

    const totalExpectedBoardings = stopDecisions.reduce((s, d) => s + d.expectedBoardingsHere, 0);
    const totalExpectedDropOffs = stopDecisions.reduce((s, d) => s + d.dropOffsHere, 0);

    const projectedGrossFarePhp = round2(
      (v.currentOccupancy + totalExpectedBoardings) *
        fareFor(AVERAGE_RIDE_KM, false, FARE_BY_VEHICLE[v.kind]),
    );
    const netDriverTakeHomePhp = round2(projectedGrossFarePhp - totalFuelCostPhp);

    const bestStop =
      stopDecisions
        .filter((d) => d.expectedBoardingsHere > 0)
        .sort((a, b) => b.expectedBoardingsHere - a.expectedBoardingsHere)[0]?.stopName ?? null;

    const skipNames = stopDecisions
      .filter((d) => d.action.startsWith('SKIP_'))
      .map((d) => d.stopName);
    const stopNames = stopDecisions
      .filter((d) => d.action.startsWith('STOP_'))
      .map((d) => `${d.stopName} (+${d.expectedBoardingsHere}/-${d.dropOffsHere})`);

    const driverSummary =
      `[${v.plate}] Position ${v.currentKm.toFixed(1)}/${routeLengthKm.toFixed(1)} km (${v.currentOccupancy}/${v.capacity} riders, ${v.speedKmh} km/h). ` +
      `Stop at: ${stopNames.length ? stopNames.join(', ') : 'none'}. ` +
      `Skip (${stopsToSkip}): ${skipNames.length ? skipNames.join(', ') : 'none'} → saves ${round2(fuelSavedBySkippingLiters * 1000)} mL diesel (₱${fuelSavedBySkippingPhp.toFixed(2)}, ~${equivalentKmSaved} km equivalent). ` +
      `Remaining leg (${remainingRouteKm} km) uses ${totalFuelLiters} L (₱${totalFuelCostPhp.toFixed(2)}); projected gross fare ₱${projectedGrossFarePhp.toFixed(0)} (net ₱${netDriverTakeHomePhp.toFixed(0)}).`;

    return {
      plate: v.plate,
      kind: v.kind,
      currentKm: v.currentKm,
      speedKmh: v.speedKmh,
      currentOccupancy: v.currentOccupancy,
      capacity: v.capacity,
      nextStopName: v.nextStopName,
      remainingRouteKm,
      bestPriorityStop: bestStop,
      stopsToStopAt,
      stopsToSkip,
      totalExpectedBoardings,
      totalExpectedDropOffs,
      projectedGrossFarePhp,
      cruisingFuelLiters,
      stopGoFuelLiters,
      totalFuelLiters,
      totalFuelCostPhp,
      fuelSavedBySkippingLiters,
      fuelSavedBySkippingPhp,
      equivalentKmSaved,
      netDriverTakeHomePhp,
      stopDecisions,
      driverSummary,
    };
  });

  // 4. Compile Commuter Advice for every stop (ETA, seat availability after drop-offs, fare).
  const commuterAdviceByStop: Record<string, CommuterStopAdvice> = {};
  const finalStop = stops[stops.length - 1]!;
  const requestedDest =
    stops.find(
      (s) =>
        options.destinationStop &&
        s.name.toLowerCase().includes(options.destinationStop.toLowerCase()),
    ) ?? finalStop;

  for (const stop of stops) {
    const destStop = requestedDest.sKm > stop.sKm ? requestedDest : finalStop;
    const tripDistanceKm = round2(Math.max(0.5, destStop.sKm - stop.sKm));

    const arrivals: CommuterJeepneyArrival[] = [];
    for (const plan of driverPlans) {
      const dec = plan.stopDecisions.find((d) => d.stopName === stop.name);
      if (!dec) continue;
      // Free seats when the jeepney arrives at this stop (after drop-offs at this stop):
      const occAfterDropHere = Math.max(0, dec.occupancyBefore - dec.dropOffsHere);
      const freeSeatsHere = Math.max(0, plan.capacity - occAfterDropHere);
      arrivals.push({
        plate: plan.plate,
        kind: plan.kind,
        distanceAwayKm: dec.distanceAheadKm,
        etaSeconds: dec.etaSeconds,
        etaMinutes: dec.etaMinutes,
        currentOccupancy: plan.currentOccupancy,
        capacity: plan.capacity,
        projectedOccupancyAtYourStop: occAfterDropHere,
        projectedFreeSeatsAtYourStop: freeSeatsHere,
        seatsLeftForYou: 0,
        willHaveSeatForYou: false,
      });
    }
    arrivals.sort((a, b) => a.etaSeconds - b.etaSeconds);

    // First come, first served at the stop too: everyone already queued boards
    // before you, so a jeepney has a seat for you only once they are all in.
    let queuedAhead = stop.initialWaiting;
    for (const a of arrivals) {
      a.seatsLeftForYou = Math.max(0, a.projectedFreeSeatsAtYourStop - queuedAhead);
      a.willHaveSeatForYou = a.seatsLeftForYou > 0;
      queuedAhead = Math.max(0, queuedAhead - a.projectedFreeSeatsAtYourStop);
    }

    const nearest = arrivals[0] ?? null;
    const firstWithSeat = arrivals.find((a) => a.willHaveSeatForYou) ?? null;

    // The fare of the vehicle that takes them; a jeepney's until one is coming.
    const rule = FARE_BY_VEHICLE[(firstWithSeat ?? nearest)?.kind ?? 'jeepney'];
    const regularFarePhp = fareFor(tripDistanceKm, false, rule);
    const discountedFarePhp = fareFor(tripDistanceKm, true, rule);
    const word = (a: CommuterJeepneyArrival) => KIND_WORD[a.kind];

    let status: CommuterStopAdvice['status'] = 'NO_JEEPNEY_WITH_SEATS';
    if (nearest && nearest.willHaveSeatForYou) {
      status = 'BOARD_NEAREST';
    } else if (firstWithSeat) {
      status = 'WAIT_FOR_NEXT_WITH_SEATS';
    }

    // Stop km marks are positions on the planner's line, not something a rider
    // knows, so summaries use names, distances away and minutes only.
    const queue =
      stop.initialWaiting > 0 ? ` (${stop.initialWaiting} already waiting board first)` : '';
    const fare = `Fare to ${destStop.name} (${tripDistanceKm.toFixed(1)} km): ₱${regularFarePhp.toFixed(2)} regular / ₱${discountedFarePhp.toFixed(2)} discounted (Student/Senior/PWD).`;
    let commuterSummary: string;
    if (!nearest) {
      commuterSummary = `At ${stop.name}: no vehicle is on its way to this stop right now.`;
    } else if (status === 'BOARD_NEAREST') {
      commuterSummary =
        `At ${stop.name}: board ${word(nearest)} ${nearest.plate}, arriving in ${nearest.etaMinutes.toFixed(1)} min (${nearest.distanceAwayKm.toFixed(2)} km away) with ${nearest.seatsLeftForYou} seat(s) left for you${queue}. ` +
        fare;
    } else if (status === 'WAIT_FOR_NEXT_WITH_SEATS' && firstWithSeat) {
      commuterSummary =
        `At ${stop.name}: the nearest ${word(nearest)} ${nearest.plate} (${nearest.etaMinutes.toFixed(1)} min) has ${nearest.projectedFreeSeatsAtYourStop} free seat(s), not enough for you${queue}. ` +
        `Wait for ${word(firstWithSeat)} ${firstWithSeat.plate}, arriving in ${firstWithSeat.etaMinutes.toFixed(1)} min (${firstWithSeat.distanceAwayKm.toFixed(2)} km away) with ${firstWithSeat.seatsLeftForYou} seat(s) left for you. ` +
        fare;
    } else {
      commuterSummary = `At ${stop.name}: the nearest ${word(nearest)} is ${nearest.plate} in ${nearest.etaMinutes.toFixed(1)} min, but none of the vehicles on their way will have a seat left for you${queue}.`;
    }

    commuterAdviceByStop[stop.name] = {
      stopName: stop.name,
      stopKm: stop.sKm,
      waitingAheadOfYou: stop.initialWaiting,
      destinationStopName: destStop.name,
      destinationKm: destStop.sKm,
      tripDistanceKm,
      regularFarePhp,
      discountedFarePhp,
      status,
      nearestJeepney: nearest,
      recommendedJeepney: firstWithSeat ?? nearest,
      approachingJeepneys: arrivals,
      commuterSummary,
    };
  }

  // 5. Match specific vehicle or stop mentioned in the user's question / options.
  const qLower = (options.question ?? '').toLowerCase();
  const focusedDriverPlan =
    driverPlans.find(
      (p) =>
        (options.driverPlate && p.plate.toLowerCase() === options.driverPlate.toLowerCase()) ||
        qLower.includes(p.plate.toLowerCase()),
    ) ??
    driverPlans[0] ??
    null;

  const matchedStop =
    stops.find(
      (s) =>
        (options.commuterStop &&
          s.name.toLowerCase().includes(options.commuterStop.toLowerCase())) ||
        qLower.includes(s.name.toLowerCase()),
    ) ??
    [...stops].sort((a, b) => b.initialWaiting - a.initialWaiting)[0] ??
    stops[0]!;

  const focusedCommuterAdvice = commuterAdviceByStop[matchedStop.name] ?? null;
  const detectedRole = detectPersona(options.question ?? '', options.role);
  const totalWaiting = stops.reduce((s, st) => s + st.initialWaiting, 0);

  // 6. Synthesize a concise, high-signal direct answer covering the detected persona.
  let directAnswer: string;
  if (detectedRole === 'commuter' && focusedCommuterAdvice) {
    directAnswer = focusedCommuterAdvice.commuterSummary;
  } else if (detectedRole === 'driver' && focusedDriverPlan) {
    directAnswer = focusedDriverPlan.driverSummary;
  } else {
    // Operator / combined view:
    const busiest = [...stops].sort((a, b) => b.initialWaiting - a.initialWaiting)[0];
    const totalSavedL = round3(driverPlans.reduce((s, p) => s + p.fuelSavedBySkippingLiters, 0));
    const totalSavedPhp = round2(driverPlans.reduce((s, p) => s + p.fuelSavedBySkippingPhp, 0));
    const busiestClaim =
      busiest && busiest.claimedBy.length > 0
        ? `${busiest.claimedBy.map((c) => `${c.plate} (ETA ${Math.round((c.etaSeconds / 60) * 10) / 10}m, boards ${c.boarded})`).join(', ')}`
        : 'no approaching vehicle with free seats yet';
    directAnswer =
      `Route ${routeName} (${routeLengthKm} km): ${totalWaiting} waiting riders across ${stops.length} stops. ` +
      (busiest
        ? `Highest demand is at ${busiest.name} (${busiest.sKm} km, ${busiest.initialWaiting} waiting) → assigned First-Come-First-Served to ${busiestClaim}. `
        : '') +
      `Across all ${driverPlans.length} vehicles, FCFS conflict resolution & skip-stop pacing avoids unnecessary stops, saving ${round2(totalSavedL * 1000)} mL diesel (₱${totalSavedPhp.toFixed(2)}) on this leg.`;
  }

  const stopBadges: SceneStopBadge[] = (focusedDriverPlan?.stopDecisions ?? []).map((d) => {
    const isSkip = d.action.startsWith('SKIP_');
    const isConflictAvoided = d.action === 'SKIP_CLAIMED_BY_CLOSER_JEEPNEY';
    return {
      stopName: d.stopName,
      stopKm: d.stopKm,
      kind: isConflictAvoided ? 'conflict-avoided' : isSkip ? 'skip' : 'stop',
      label: isConflictAvoided
        ? `SKIP (FCFS: ${d.claimedEarlierByPlates[0] ?? 'closer vehicle'})`
        : isSkip
          ? `SKIP • Save ${Math.round(d.fuelSavedLitersIfSkipped * 1000)}mL`
          : `STOP • +${d.expectedBoardingsHere} / -${d.dropOffsHere}`,
      detail: d.reason,
    };
  });

  const sceneActions: SceneActionDirective = {
    focusVehiclePlate:
      detectedRole === 'commuter'
        ? (focusedCommuterAdvice?.recommendedJeepney?.plate ?? null)
        : (focusedDriverPlan?.plate ?? null),
    focusStopName:
      detectedRole === 'commuter'
        ? (focusedCommuterAdvice?.stopName ?? null)
        : (focusedDriverPlan?.bestPriorityStop ?? matchedStop.name),
    suggestedCameraView:
      detectedRole === 'driver' ? 'pov' : detectedRole === 'commuter' ? 'chase' : 'overview',
    stopBadges,
  };

  return {
    detectedRole,
    route: {
      name: routeName,
      lengthKm: routeLengthKm,
      totalWaiting,
      activeJeepneys: driverPlans.length,
      liveGpsPhones: (snapshot.liveSessions ?? []).length,
    },
    stops,
    driverPlans,
    focusedDriverPlan,
    commuterAdviceByStop,
    focusedCommuterAdvice,
    sceneActions,
    directAnswer,
  };
}
