/**
 * Everything the live twin simulates, kept outside React.
 *
 * React renders structure; this object holds state that changes every frame
 * (vehicle positions, interpolation). The 3D components read from it inside
 * useFrame, so a moving fleet causes zero React re-renders.
 *
 * Raw GPS history is kept per session, so swapping the route (e.g. after
 * recording one) re-matches every trace against the new road.
 */

import type { StationFit } from '@/core/map/streets';
import { FleetSim, DEFAULT_FLEET, type FuelStopAt } from '@/core/fleet/fleetSim';
import { forecourtAlong, PULL_IN_M, stationsFor } from '@/core/fuel/stations';
import { alignKinds, mixKinds } from '@/core/fleet/scenario';
import { fleetKinds, type FleetKind } from '@/core/vehicles/specs';
import { laneOffset } from '@/scene/world/lanes';
import type { SimulationScenario } from '@/core/fleet/scenario';
import { CrewState } from '@/scene/jeepney/crewState';
import type { DoorCounting } from '@/scene/vehicles/doorCounting';
import type { CameraFeed } from './doorwayRuntime';
import type { Route } from '@/core/geo/routes';
import { LiveVehicle } from '@/core/tracking/liveVehicle';
import type { GpsFix, SessionUpdate } from '@/core/tracking/types';

const MAX_HISTORY = 4_000;
/** A longer gap between frames (a stall, a hidden tab) advances the clock this much at most. */
export const MAX_FRAME_DT_S = 0.1;
/** The simulation stops once this many days are in the ledger (a long month). */
export const MAX_DAYS = 31;
/**
 * Fast-forwarding (see advance): at most this many simulation steps a frame,
 * each at most MAX_TICK_S long, and no longer than SIM_BUDGET_MS of a frame
 * (a busy machine sees the clock slow down, not the view freeze); at night, with every jeepney parked and
 * nothing to watch, the clock may skip ahead (only when asked: skipNight)
 * at least NIGHT_RATE× in NIGHT_TICK_S steps.
 */
const MAX_TICKS_PER_FRAME = 10;
const MAX_TICK_S = 0.5;
const SIM_BUDGET_MS = 10;
const NIGHT_RATE = 600;
const NIGHT_TICK_S = 2;

/** A jeepney's starting state when a route is handed over from its network flow. */
export interface FleetStart {
  s: number;
  occupancy: number;
  plate: string;
  /** False when it is not out at this hour: parked at its terminal. */
  inService?: boolean;
  /** What it is, when it comes from a flow: it stays that. */
  kind?: FleetKind;
}

export class TwinRuntime {
  readonly route: Route;
  readonly fleet: FleetSim;
  /** Riders in each simulated jeepney, animated boarding and alighting. */
  readonly crew: CrewState;
  /** Cabin camera of the jeepney being ridden along with (null when none). */
  readonly cabinFeed: CameraFeed = { pipeline: null, clockMs: 0 };
  /** Door cameras of the modern jeepney, UV Express or bus being ridden along with. */
  doorCounting: DoorCounting | null = null;
  readonly live = new Map<string, LiveVehicle>();
  private readonly history = new Map<string, GpsFix[]>();
  private accumulatedS = 0;

  constructor(
    route: Route,
    previous?: TwinRuntime,
    readonly scenario?: SimulationScenario,
    /** Where each jeepney starts (a network flow handing its route over); else spread evenly. */
    start?: readonly FleetStart[],
  ) {
    this.route = route;
    this.fleet = new FleetSim(
      route,
      scenario
        ? {
            ...DEFAULT_FLEET,
            count: scenario.vehicles,
            seed: scenario.seed,
            scenario,
            dayCycle: true,
            fuelStops: () => this.fuelStops(),
            // A jeepney route's jeepneys (a few of them modern); a bus or UV
            // Express route's buses or vans.
            kinds: alignKinds(
              scenario.mix
                ? mixKinds(scenario.mix)
                : fleetKinds(scenario.vehicles, route.kind, route.mix),
              start ?? [],
            ),
          }
        : DEFAULT_FLEET,
    );
    start?.forEach((at, i) => i < this.fleet.vehicles.length && this.fleet.place(i, at));
    this.crew = new CrewState(this.fleet);
    previous?.history.forEach((fixes, id) => fixes.forEach((fix) => this.ingestFix(id, fix)));
  }

  /** Time of day of the simulation, seconds since midnight (of its first day). */
  get clockS(): number {
    return this.fleet.clockS;
  }

  ingest(update: SessionUpdate): void {
    this.ingestFix(update.meta.sessionId, update.fix);
  }

  step(dtS: number, nowMs: number): void {
    this.fleet.step(dtS);
    this.crew.update(dtS);
    this.doorCounting?.step(dtS);
    for (const v of this.live.values()) v.update(dtS, nowMs);
  }

  /**
   * The stations a jeepney can pull in at: by the road (PULL_IN_M), with a
   * forecourt it can drive through clear of the stops; worked out again only
   * when the stations known change (the network's are loaded after the twin
   * starts).
   */
  private fuelStops(): readonly FuelStopAt[] {
    const all = stationsFor(this.route);
    if (all.length !== this.stationsSeen) {
      this.stationsSeen = all.length;
      const route = this.route;
      this.stations = all.flatMap((st) => {
        if (st.roadM > PULL_IN_M) return [];
        const way = forecourtAlong(
          route,
          st,
          st.side === 'right' ? 1 : -1,
          (s) => laneOffset(route, s),
          this.stationFits.get(st.id),
        );
        return way ? [{ s: st.s, name: st.name ?? st.brand, side: st.side, ...way }] : [];
      });
    }
    return this.stations;
  }
  private stations: readonly FuelStopAt[] = [];
  private stationsSeen = -1;
  private stationFits: ReadonlyMap<string, StationFit> = new Map();

  /** Where stations stand, by id, as fitted among the map's roads. */
  setStationFits(fits: ReadonlyMap<string, StationFit>): void {
    this.stationFits = fits;
    this.stationsSeen = -1;
  }

  /** Every day of the month simulated: the clock has stopped. */
  get finished(): boolean {
    return this.fleet.dayNumber > MAX_DAYS;
  }

  /** The night: every jeepney parked, nothing moving. */
  get night(): boolean {
    return this.fleet.allParked && !this.finished;
  }

  /**
   * Fixed simulation ticks keep accelerated runs independent of display frame
   * rate: 1/60 s, longer only when a fast speed would need more than
   * MAX_TICKS_PER_FRAME of them (up to MAX_TICK_S), so 300× costs a frame
   * about what 30× does. A backlog the machine cannot keep up with is dropped
   * rather than allowed to grow (the clock then runs slower than asked).
   * `skipNight`: run through the night fast instead of at `speed`.
   */
  advance(realDtS: number, nowMs: number, speed: number, skipNight = false): void {
    if (this.finished) speed = 0;
    const night = skipNight && speed > 0 && this.night;
    this.accumulatedS += realDtS * (night ? Math.max(speed, NIGHT_RATE) : speed);
    const tick = Math.min(
      night ? NIGHT_TICK_S : MAX_TICK_S,
      Math.max(1 / 60, this.accumulatedS / MAX_TICKS_PER_FRAME),
    );
    const startedAt = performance.now();
    for (let n = 0; this.accumulatedS >= tick - 1e-9; n++) {
      if (n >= MAX_TICKS_PER_FRAME || performance.now() - startedAt > SIM_BUDGET_MS) {
        this.accumulatedS = 0;
        break;
      }
      this.fleet.step(tick);
      this.crew.update(tick);
      this.doorCounting?.step(tick);
      this.accumulatedS = Math.max(0, this.accumulatedS - tick);
    }
    // Phone/GPS interpolation remains on real time, even during accelerated experiments.
    for (const v of this.live.values()) v.update(realDtS, nowMs);
  }

  private ingestFix(sessionId: string, fix: GpsFix): void {
    let vehicle = this.live.get(sessionId);
    if (!vehicle) {
      vehicle = new LiveVehicle(this.route);
      this.live.set(sessionId, vehicle);
      this.history.set(sessionId, []);
    }
    const fixes = this.history.get(sessionId)!;
    fixes.push(fix);
    if (fixes.length > MAX_HISTORY) fixes.shift();
    vehicle.ingest(fix);
  }
}
