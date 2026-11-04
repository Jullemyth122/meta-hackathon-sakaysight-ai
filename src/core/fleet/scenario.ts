import type { FleetKind } from '../vehicles/specs';

/** How many of each kind of vehicle. */
export type FleetMix = Record<FleetKind, number>;

/**
 * Synthetic single-route experiments. Values are inputs, not measured
 * ridership for this route (nobody publishes that), but they are sized from
 * what is published:
 *
 *   - 6.8 million jeepney trips a day in Greater Manila on ~55–73 thousand
 *     jeepneys (JICA MUCEP 2014): ~90–125 riders per unit per day, idle and
 *     part-day units included; ~300 is the planning figure for a jeepney
 *     working a full day (UP CIDS 2021).
 *   - 10–15 riders on board on average (MMDA, via IBON); trips ~5 km.
 *     Quirino Highway is Metro Manila's busiest radial road.
 *
 * The simulator now runs a working day at the road's speeds (rush-hour
 * traffic, terminal lines: FleetSim.dayCycle), so it takes the published
 * figure: 300 riders per jeepney a day. Measured on the Tungko–SM Fairview
 * loop with 60 jeepneys (28 Oct 2026): ~11 on board at the rush, ~4 at
 * midday, 128 km and 29 L of diesel a day, ₱700 net after the ₱700
 * boundary, inside the ₱400–800 drivers report.
 */
export interface SimulationScenario {
  vehicles: number;
  /**
   * How many of each kind, when chosen by hand: kept from route to route, and
   * `vehicles` is their sum. Without it, each route has its usual mix.
   */
  mix?: FleetMix;
  dailyTrips: number;
  startHour: number;
  /**
   * Seconds past startHour the run begins at. Switching the focused route
   * of the network keeps the clock going instead of jumping to the hour.
   */
  startOffsetS?: number;
  profile: 'commute' | 'flat';
  seed: number;
  /** Share of jeepneys driven by their owner (no boundary, their own upkeep), 0–1. */
  ownerShare?: number;
}

/**
 * Not every driver pays boundary: some own their jeepney. No published
 * share for Metro Manila routes; a quarter is an assumption to change.
 */
export const OWNER_SHARE = 0.25;

/**
 * Where a boundary driver collects the jeepney: this share at the terminal,
 * where the operator keeps it; the rest at the operator's garage (or the
 * driver's house) somewhere along the route, like an owner's. So jeepneys
 * come out onto the road all along it in the morning, not only at its ends,
 * and go back there at night. Also an assumption to change.
 */
export const TERMINAL_KEPT_SHARE = 0.4;

/**
 * A route's day (seconds since midnight): drivers set out from SERVICE_FROM_S
 * (5:30, so most are out around 6 AM), each at a time of their own that
 * changes day to day; each knocks off between HOME_FROM_S and HOME_TO_S
 * (9 to 11 PM), finishes the trip to a terminal and parks; riders turn up
 * from SERVICE_FROM_S until LAST_RIDERS_S. The day's ledger closes at
 * DAY_ENDS_S, when anyone still waiting goes home.
 */
export const SERVICE_FROM_S = 5.5 * 3600;
export const HOME_FROM_S = 21 * 3600;
export const HOME_TO_S = 23 * 3600;
export const LAST_RIDERS_S = 22.75 * 3600;
export const DAY_ENDS_S = 3 * 3600;

/**
 * Riders a day per jeepney on a route: enough that, with drivers lining up
 * at the terminals to fill (passengerSystem FILL), a jeepney runs about
 * three-quarters full or more in the rushes and over half full through the
 * day, as riders see them (30 Oct 2026). An assumption to replace with
 * route counts.
 */
export const RIDERS_PER_JEEPNEY_PER_DAY = 560;
const day = (vehicles: number) => vehicles * RIDERS_PER_JEEPNEY_PER_DAY;

/** 20 jeepneys at 7 AM, the morning rush: stops are busy from the first frame. */
export const DEFAULT_SCENARIO: SimulationScenario = {
  vehicles: 20,
  dailyTrips: day(20),
  startHour: 7,
  profile: 'commute',
  seed: 11,
  ownerShare: OWNER_SHARE,
};

/**
 * What the app starts with: day 1 at 5 AM, every jeepney parked (a boundary
 * driver's at the operator's terminal, an owner's at home), 60 on the route. A regular rider sees a jeepney pass a Quirino
 * Highway stop about every minute (28 Oct 2026); with the terminal lines
 * this route's own come about every 3 minutes, and the other routes on the
 * highway (drawn from the network) make up the rest. LTFRB publishes no
 * per-route unit counts.
 */
export const FIELD_SCENARIO: SimulationScenario = {
  ...DEFAULT_SCENARIO,
  vehicles: 60,
  dailyTrips: day(60),
  startHour: 5,
};

export const SCENARIOS = [
  { name: 'A day from 5 AM (60)', values: FIELD_SCENARIO },
  {
    name: 'Quieter route (20)',
    values: { ...FIELD_SCENARIO, vehicles: 20, dailyTrips: day(20) },
  },
  { name: 'Stress test', values: { ...DEFAULT_SCENARIO, vehicles: 120, dailyTrips: day(120) } },
] as const;

// Relative arrivals by half hour (slot k starts at k × 30 min). Scenario
// assumptions, from how a regular rider describes the day (29 Oct 2026):
// nobody at the stops at 5 AM; most ride between 6:30 and 7:00, each at a
// time of their own, a few earlier or later; errands and shifts through the
// day, busy too (late morning and early afternoon are not empty: errands,
// school, shifts); home from 5 to 11 PM (PassengerSystem times each
// commuter's return). The busiest hour carries about 9% of the day, as
// commute peaks do: a sharper peak asks more of a route's jeepneys than they
// can carry, and the stops fill with people that no jeepney has room for.
const SLOT_S = 1800;
// prettier-ignore
const COMMUTE = [
  ...Array<number>(10).fill(0.02), // midnight to 5:00 (no jeepneys run)
  0.02, 0.35, // 5:00, 5:30: the first jeepneys out, a few early risers
  1, 1.3, 1.25, 1.05, // 6:00, 6:30, 7:00, 7:30: the morning rush
  0.8, 0.6, // 8:00, 8:30
  ...Array<number>(16).fill(0.95), // 9:00 to 17:00: errands, school, shifts
  1.15, 1.3, 1.25, 1.1, 0.95, 0.8, 0.65, 0.55, 0.45, 0.38, 0.3, 0.22, // 17:00 to 23:00: home
  0.06, 0.03, // 23:00, 23:30
];
const TOTAL_WEIGHT = COMMUTE.reduce((sum, n) => sum + n, 0);

/** Relative arrivals in each hour of the day (the commute profile), from midnight. */
export const COMMUTE_BY_HOUR: readonly number[] = Array.from(
  { length: 24 },
  (_, h) => COMMUTE[2 * h]! + COMMUTE[2 * h + 1]!,
);

/** The most one route can be asked to simulate, vehicle by vehicle. */
export const MAX_SCENARIO_VEHICLES = 600;
export const MAX_SCENARIO_TRIPS = 300_000;

/** The order the kinds are listed in. */
export const FLEET_KINDS: readonly FleetKind[] = ['jeepney', 'modern', 'uv', 'bus'];

export const mixTotal = (mix: FleetMix): number =>
  FLEET_KINDS.reduce((sum, kind) => sum + mix[kind], 0);

/**
 * The fleet a mix makes, its kinds scattered along the list (which is the
 * order vehicles come out in), not one kind after another.
 */
export function mixKinds(mix: FleetMix): FleetKind[] {
  const list = FLEET_KINDS.flatMap((kind) => Array.from({ length: mix[kind] }, () => kind));
  const place = (i: number) => ((i + 1) * 0.618_033_988_75) % 1;
  return list
    .map((kind, i) => ({ kind, at: place(i) }))
    .sort((a, b) => a.at - b.at)
    .map((v) => v.kind);
}

/**
 * Which of a route's fleet to simulate, `vehicles` of them: the first ones, or
 * as many of each kind as `mix` asks for. Always with vehicle `keep` (one
 * someone clicked), which takes the place of the last of its kind if need be.
 * In the fleet's own order.
 */
export function pickFleet<T extends { index: number; kind: FleetKind }>(
  fleet: readonly T[],
  vehicles: number,
  mix?: FleetMix,
  keep?: number,
): T[] {
  const left = mix ? { ...mix } : null;
  const wanted = keep === undefined ? undefined : fleet[keep];
  const chosen: T[] = [];
  const take = (v: T) => {
    chosen.push(v);
    if (left) left[v.kind]--;
  };
  if (wanted) take(wanted);
  for (const v of fleet) {
    if (chosen.length >= vehicles) break;
    if (v === wanted || (left && left[v.kind] <= 0)) continue;
    take(v);
  }
  return chosen.sort((a, b) => a.index - b.index);
}

/**
 * A fleet's kinds in the order `start` has them, with as few changes as
 * possible: a vehicle handed over from the flows stays what it is, and the
 * fleet keeps the numbers it had of each kind where it can.
 */
export function alignKinds(
  kinds: readonly FleetKind[],
  start: ReadonlyArray<{ kind?: FleetKind }>,
): FleetKind[] {
  const out = [...kinds];
  start.forEach(({ kind }, i) => {
    if (!kind || i >= out.length || out[i] === kind) return;
    const other = out.findIndex((k, j) => j > i && k === kind);
    if (other >= 0) out[other] = out[i]!;
    out[i] = kind;
  });
  return out;
}

/** A mix cut to what can be simulated, keeping the kinds in proportion. */
function boundedMix(mix: FleetMix): FleetMix {
  const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
  const clean = Object.fromEntries(FLEET_KINDS.map((k) => [k, whole(mix[k])])) as FleetMix;
  const total = mixTotal(clean);
  if (total === 0) return { ...clean, jeepney: 1 };
  if (total <= MAX_SCENARIO_VEHICLES) return clean;
  const cut = MAX_SCENARIO_VEHICLES / total;
  return Object.fromEntries(FLEET_KINDS.map((k) => [k, Math.floor(clean[k] * cut)])) as FleetMix;
}

export function normalizeScenario(s: SimulationScenario): SimulationScenario {
  const bounded = (n: number, fallback: number, lo: number, hi: number) =>
    Math.round(Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : fallback)));
  const mix = s.mix && boundedMix(s.mix);
  return {
    vehicles: mix
      ? mixTotal(mix)
      : bounded(s.vehicles, DEFAULT_SCENARIO.vehicles, 1, MAX_SCENARIO_VEHICLES),
    ...(mix ? { mix } : {}),
    dailyTrips: bounded(s.dailyTrips, DEFAULT_SCENARIO.dailyTrips, 0, MAX_SCENARIO_TRIPS),
    startHour: bounded(s.startHour, 6, 0, 23),
    ...(s.startOffsetS ? { startOffsetS: bounded(s.startOffsetS, 0, 0, 3599) } : {}),
    profile: s.profile === 'flat' ? 'flat' : 'commute',
    seed: bounded(s.seed, 11, 1, 2147483647),
    ownerShare: Math.max(
      0,
      Math.min(1, Number.isFinite(s.ownerShare) ? s.ownerShare! : OWNER_SHARE),
    ),
  };
}

/** Expected route-wide arrivals over an interval, integrating hour/day boundaries. */
export function expectedArrivals(s: SimulationScenario, elapsedS: number, dtS: number): number {
  let time = s.startHour * 3600 + (s.startOffsetS ?? 0) + elapsedS;
  let remaining = Math.max(0, dtS),
    expected = 0;
  while (remaining > 1e-9) {
    const slot = Math.floor(time / SLOT_S) % COMMUTE.length;
    const duration = Math.min(remaining, (Math.floor(time / SLOT_S) + 1) * SLOT_S - time);
    const share = s.profile === 'flat' ? 1 / COMMUTE.length : COMMUTE[slot]! / TOTAL_WEIGHT;
    expected += (s.dailyTrips * share * duration) / SLOT_S;
    remaining -= duration;
    time += duration;
  }
  return expected;
}
