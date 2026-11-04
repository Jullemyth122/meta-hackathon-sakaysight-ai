/**
 * UI state that React should re-render on. Low-frequency only: which view is
 * open, which sessions exist, which route is loaded. Per-frame values live in
 * the runtimes (twinRuntime.ts, doorwayRuntime.ts).
 */

import type { FleetKind } from '@/core/vehicles/specs';
import type { GeoError } from '@/tracker/useGeolocation';
import { onPhone } from './device';
import { create } from 'zustand';
import { FIELD_SCENARIO, normalizeScenario, type SimulationScenario } from '@/core/fleet/scenario';
import type { CommuterQuery } from '@/core/advisory/commuter';
import { defaultRoute, stopsAhead, type Route } from '@/core/geo/routes';
import type { RiderKind } from '@/core/fare';
import type { LocalPoint } from '@/core/geo/projection';
import type { Roadside } from '@/core/network/roadside';
import type { SessionMeta, TripPhase } from '@/core/tracking/types';
import type { TransportKind } from '@/net/transport';
import type { VehicleKind } from '@/core/vehicles/specs';
import type { FleetStart } from './twinRuntime';

/**
 * twin      the operator's view of the whole route
 * driver    the driver's phone: only what is ahead of their jeepney
 * commuter  the commuter's phone: their stop, their jeepney, their trip
 * doorway   the cabin camera test bench
 */
export type View = 'twin' | 'driver' | 'commuter' | 'doorway' | 'economics';
export type Backend = 'WebGPU' | 'WebGL2';

export interface SessionSummary {
  meta: SessionMeta;
  trip: TripPhase;
  lastFixAt: number;
}

/**
 * What the camera rides along with: a phone-driven jeepney or a simulated one,
 * seen from behind (chase) or from the rear step inside the cabin (inside).
 */
export type FollowTarget = ({ kind: 'live'; id: string } | { kind: 'sim'; index: number }) & {
  view?: 'chase' | 'inside' | 'pov';
};

/** A one-off camera move. `seq` changes on every request so repeats still fire. */
export interface CameraShot {
  kind: 'overview' | 'street' | 'stop' | 'area';
  seq: number;
  /** For 'stop': which one. */
  stop?: number;
  /** For 'area': the points to frame (a planned trip, end to end). */
  area?: LocalPoint[];
}

export interface NetworkStatus {
  state: 'off' | 'loading' | 'ready' | 'error';
  routes: number;
  /** While loading, how much of it is done (0 to 1). */
  share?: number;
  message?: string;
  /** Metro Manila's gas stations are loaded (stationsFor covers every route). */
  fuel?: boolean;
}

/** A commuter's chosen trip across the network: each leg's route and stops. */
export interface TripLeg {
  route: number;
  board: number;
  alight: number;
  /** Walk to the boarding stop (from the start, or from the last jeepney). */
  walkM: number;
  /** First-mile travel mode; transfers default to walking. */
  approachMode?: 'walk' | 'tricycle';
  /** The first leg's: where the trip starts (the place chosen), for "you" to set out from. */
  from?: LocalPoint;
  /** The first leg's: the waiting area chosen on the way, if one was. */
  via?: LocalPoint;
  /** The first leg's: boarding right there by the road, not at stop `board`. */
  flag?: Roadside;
}

/** A point of a planned trip: a place found by name, or a spot clicked on the map. */
export interface TripEnd {
  name: string;
  at: LocalPoint;
}

/**
 * The points of a trip being planned: `home`, where "you" appear; `from`,
 * the waiting area (a stop) you go to, chosen for you unless you choose
 * it; `to`, where you are going.
 */
export type TripPoint = 'home' | 'from' | 'to';

/** What a click on the map is for: the commuter's own spot, or a point of a trip being planned. */
export type Picking = false | 'me' | TripPoint;

/**
 * The commuter app's user. `place`: where they are, picked on the map (in
 * the focused route's scene metres), or null to choose a stop and a distance.
 * `mode`: how they get to the stop; 'auto' walks up to 400 m and takes a
 * tricycle beyond 900 m, as most people do.
 */
export interface CommuterSelf {
  kind: RiderKind;
  mode: 'auto' | 'walk' | 'tricycle';
  place: LocalPoint | null;
}

/** "You" are to join the twin as a rider once this route is the focused one. */
export interface PendingJoin {
  routeId: string;
  /** Which leg of tripLegs. */
  leg: number;
}

/** A demo scene being played (app/demoScenes.ts): a new `seq` starts it again. */
export interface DemoPlaying {
  id: string;
  seq: number;
}

/** A line for the Ask box, with a picture to send with it: asked at once when `send`. */
export interface DemoAsk {
  text: string;
  photo?: string;
  send: boolean;
  seq: number;
}

export interface MapStatus {
  state: 'off' | 'loading' | 'ready' | 'partial' | 'error';
  loaded: number;
  total: number;
  message?: string;
}

interface AppState {
  scenario: SimulationScenario;
  /** Share of the other routes' traffic drawn, 0–1. */
  trafficShare: number;
  setTrafficShare(share: number): void;
  simulationSpeed: number;
  /** Run through the night (every jeepney parked) fast instead of at the chosen speed. */
  skipNight: boolean;
  /** Draw the other routes' (estimated) jeepneys around the one simulated in full. */
  otherRoutes: boolean;
  setScenario(scenario: SimulationScenario): void;
  setSimulationSpeed(speed: number): void;
  setSkipNight(skip: boolean): void;
  setOtherRoutes(show: boolean): void;
  view: View;
  backend: Backend | null;
  /** The loading screen has lifted: the app is in view. */
  started: boolean;
  transport: TransportKind | null;
  route: Route;
  /** Where the twin's jeepneys start when a network route is focused (else spread evenly). */
  fleetStart: FleetStart[] | null;
  network: NetworkStatus;
  /** The commuter's planned trip across the network, drawn on the map. */
  tripLegs: TripLeg[] | null;
  /** The trip planner's points (see TripPoint), as chosen (by name, or on the map), drawn as pins. */
  tripEnds: Record<TripPoint, TripEnd | null>;
  /** A trip the planner offers, drawn end to end before it is taken. */
  tripPreview: TripLeg[] | null;
  /** A way the agent has found (a shortcut), drawn on the map, for the driver who asked. */
  agentWay: { points: LocalPoint[]; label: string } | null;
  /** Ways the agent is weighing against each other (compare_ways), each in its colour, until one is taken. */
  agentWays: Array<{ points: LocalPoint[]; label: string; colour: string }> | null;
  /** The leg of tripLegs being travelled now. */
  tripLeg: number;
  pendingJoin: PendingJoin | null;
  sessions: Record<string, SessionSummary>;
  /**
   * The areas of phones this view listens to (core/tracking/area.ts): the map
   * cells it shows, of the kinds it shows. None for a driver, or a scene.
   */
  watchAreas: readonly string[];
  /** This phone's own session while it shares its place: on its own map without the network. */
  mySessionId: string | null;
  follow: FollowTarget | null;
  trackedRiderId: number | null;
  /** Who Automatic AI is on for: one vehicle or person at a time (ui/AutoAI.tsx). */
  autoAI: string | null;
  /** Locate me is on (app/useLocateMe.ts), and where it last found them. */
  locating: boolean;
  /** As whom: a commuter, or a driver of this kind of vehicle. */
  sharingAs: 'commuter' | FleetKind;
  located: { at: LocalPoint; accuracyM: number } | null;
  locateError: GeoError;
  showFov: boolean;
  /** Sensor lab: the vehicle at the kerb (the traditional jeepney runs the counting demo). */
  labVehicle: 'jeepney' | VehicleKind;
  /** Sensor lab: which door's camera the picture-in-picture shows. */
  labDoor: number;
  /** The operator's table of every jeepney, over the live twin. */
  fleetData: boolean;
  shot: CameraShot;
  map: MapStatus;
  /** Whose phone the driver view shows. */
  driverVehicle: number;
  /** The vehicle picked for the commuter's phone: it shows someone riding it, once there is one. */
  commuterVehicle: number | null;
  /** Whose phone the commuter view shows: a trip being planned, or a rider. */
  commuter: CommuterQuery;
  demoScene: DemoPlaying | null;
  demoAsk: DemoAsk | null;
  /** Muse answers in English, whatever it is asked in (for a global audience). */
  english: boolean;
  setEnglish(on: boolean): void;
  /** The live map's state, while a demo scene plays (see DEMO_BORROWS). */
  demoKept: DemoKept | null;
  /** The commuter app's user: who they are (for the fare), how they get to the stop. */
  me: CommuterSelf;
  /** Waiting for a click on the map: for the commuter's own spot, or a trip's end. */
  pickingPlace: Picking;

  /** Put the live map aside for a scene (a second scene keeps what the first put aside). */
  enterDemo(): void;
  /** The scene is over: back to the live map as it was. */
  leaveDemo(): void;
  setDemoScene(id: string | null): void;
  setDemoAsk(ask: Omit<DemoAsk, 'seq'> | null): void;
  setView(view: View): void;
  setDriverVehicle(index: number): void;
  setCommuter(query: CommuterQuery): void;
  setMe(me: Partial<CommuterSelf>): void;
  setPickingPlace(picking: Picking): void;
  setTripEnd(end: TripPoint, place: TripEnd | null): void;
  setTripPreview(legs: TripLeg[] | null): void;
  setAgentWay(way: AppState['agentWay']): void;
  setAgentWays(ways: AppState['agentWays']): void;
  setBackend(backend: Backend): void;
  setStarted(): void;
  setTransport(kind: TransportKind): void;
  setRoute(route: Route): void;
  /**
   * Focus a network route: the twin takes it over from its flow (app/network.ts
   * focusRoute). A planned trip is dropped unless `keepTrip` (its own legs).
   */
  setFocus(
    focus: { route: Route; scenario: SimulationScenario; start: FleetStart[] },
    keepTrip?: boolean,
  ): void;
  setNetwork(status: NetworkStatus): void;
  setTripLegs(legs: TripLeg[] | null): void;
  /** Start travelling leg `leg` of the trip: "you" join its route as a rider. */
  startLeg(leg: number, routeId: string): void;
  clearPendingJoin(): void;
  upsertSession(summary: SessionSummary): void;
  /** Many at once: one change of state, however many phones were heard. */
  upsertSessions(summaries: readonly SessionSummary[]): void;
  setWatchAreas(areas: readonly string[]): void;
  setMySessionId(id: string | null): void;
  /** A phone has gone: off the map, and off the camera if it was following it. */
  dropSession(id: string): void;
  setFollow(target: FollowTarget | null): void;
  trackRider(id: number | null): void;
  setAutoAI(key: string | null): void;
  setLocating(on: boolean, as?: AppState['sharingAs']): void;
  setLocated(located: AppState['located']): void;
  setLocateError(error: GeoError): void;
  setShowFov(show: boolean): void;
  setLabVehicle(vehicle: 'jeepney' | VehicleKind): void;
  setLabDoor(door: number): void;
  setFleetData(show: boolean): void;
  requestShot(kind: CameraShot['kind'], area?: LocalPoint[]): void;
  setMap(status: MapStatus): void;
}

/**
 * What a demo scene borrows from the live map: its fleet, its clock and who is
 * selected. Put aside while the scene plays and given back as it was, so the
 * live map's day never sees a scene.
 */
const DEMO_BORROWS = [
  'scenario',
  'route',
  'fleetStart',
  'follow',
  'trackedRiderId',
  'autoAI',
  'driverVehicle',
  'commuterVehicle',
  'commuter',
  'tripLegs',
  'tripLeg',
  'tripEnds',
  'tripPreview',
  'pendingJoin',
  'agentWay',
  'agentWays',
  'me',
  'simulationSpeed',
  'locating',
  'sharingAs',
  'otherRoutes',
] as const;
type DemoKept = Pick<AppState, (typeof DEMO_BORROWS)[number]>;

const keptFrom = (s: AppState) =>
  Object.fromEntries(DEMO_BORROWS.map((k) => [k, s[k]])) as unknown as DemoKept;

/** Everything back as the scene found it. */
const backFromDemo = (s: AppState): Partial<AppState> =>
  s.demoKept ? { ...s.demoKept, demoKept: null, demoScene: null, demoAsk: null } : {};

/** What Automatic AI is on for: a vehicle by its index, a person by their ID. */
export const autoKey = (kind: 'vehicle' | 'person', id: number): string => `${kind}:${id}`;

const ENGLISH_KEY = 'sakaysightai.english';
const rememberedEnglish = (): boolean => {
  try {
    return localStorage.getItem(ENGLISH_KEY) === '1';
  } catch {
    return false;
  }
};

/** Counts every demo scene and line, so a repeat is always a new one. */
let demoSeq = 0;

/** Simulation speeds offered (0 pauses); 300× runs a day in about 4 minutes. */
export const SPEEDS: readonly number[] = [0, 1, 5, 10, 30, 60, 120, 300];

export const useApp = create<AppState>((set) => ({
  scenario: FIELD_SCENARIO,
  trafficShare: 1,
  setTrafficShare: (trafficShare) => set({ trafficShare }),
  simulationSpeed: 1,
  skipNight: false,
  otherRoutes: true,
  setScenario: (scenario) =>
    set((s) => ({
      scenario: normalizeScenario(scenario),
      fleetStart: null,
      follow: null,
      trackedRiderId: null,
      autoAI: null,
      driverVehicle: 0,
      commuter: defaultTrip(s.route),
    })),
  setSimulationSpeed: (speed) => set({ simulationSpeed: SPEEDS.includes(speed) ? speed : 1 }),
  setSkipNight: (skipNight) => set({ skipNight }),
  setOtherRoutes: (otherRoutes) => set({ otherRoutes }),
  view: onPhone ? 'commuter' : 'twin',
  backend: null,
  started: false,
  autoAI: null,
  locating: false,
  sharingAs: 'commuter',
  located: null,
  locateError: null,
  transport: null,
  route: defaultRoute(),
  fleetStart: null,
  network: { state: 'off', routes: 0 },
  tripLegs: null,
  tripEnds: { home: null, from: null, to: null },
  agentWay: null,
  setAgentWay: (agentWay) => set({ agentWay }),
  agentWays: null,
  setAgentWays: (agentWays) => set({ agentWays }),
  tripPreview: null,
  tripLeg: 0,
  pendingJoin: null,
  sessions: {},
  watchAreas: [],
  mySessionId: null,
  follow: null,
  trackedRiderId: null,
  showFov: true,
  labVehicle: 'jeepney',
  labDoor: 0,
  fleetData: false,
  shot: { kind: 'street', seq: 0 },
  map: { state: 'off', loaded: 0, total: 0 },
  driverVehicle: 0,
  commuterVehicle: null,
  commuter: defaultTrip(defaultRoute()),
  me: { kind: 'regular', mode: 'auto', place: null },
  pickingPlace: false,
  demoScene: null,
  demoAsk: null,
  demoKept: null,
  english: rememberedEnglish(),
  setEnglish: (english) => {
    try {
      localStorage.setItem(ENGLISH_KEY, english ? '1' : '0');
    } catch {
      // Private mode: for this visit only.
    }
    set({ english });
  },
  enterDemo: () => set((s) => (s.demoKept ? {} : { demoKept: keptFrom(s) })),
  leaveDemo: () => set(backFromDemo),
  setDemoScene: (id) => set({ demoScene: id ? { id, seq: ++demoSeq } : null }),
  setDemoAsk: (ask) => set({ demoAsk: ask && { ...ask, seq: ++demoSeq } }),

  // The driver's phone puts the camera in their vehicle; the commuter's
  // follows the rider it shows, and otherwise leaves the camera where it is
  // (look around, pick your spot on the map, or someone to be). A vehicle
  // being followed goes with you: it becomes the driver's, or the one the
  // commuter's phone rides (the camera stays on it until there is a rider).
  setView: (view) => {
    // A scene belongs to the view it was played in.
    set((s) => (s.view === view ? {} : backFromDemo(s)));
    set((s) => {
      const picked = s.follow?.kind === 'sim' ? s.follow.index : null;
      if (view === 'commuter' && picked !== null)
        return { view, commuterVehicle: picked, commuter: defaultTrip(s.route) };
      if (view === 'driver') {
        const driverVehicle = picked ?? s.driverVehicle;
        return { view, driverVehicle, ...cameraFor(view, { ...s, driverVehicle }) };
      }
      return {
        view,
        ...(view === 'commuter' && 'passenger' in s.commuter ? cameraFor(view, s) : {}),
      };
    });
  },
  setDriverVehicle: (driverVehicle) =>
    set((s) => ({
      driverVehicle,
      agentWay: null,
      agentWays: null,
      ...cameraFor(s.view, { ...s, driverVehicle }),
    })),
  setCommuter: (commuter) =>
    set((s) => ({ commuter, commuterVehicle: null, ...cameraFor(s.view, { ...s, commuter }) })),
  setMe: (me) => set((s) => ({ me: { ...s.me, ...me } })),
  setPickingPlace: (pickingPlace) => set({ pickingPlace }),
  setTripEnd: (end, place) => set((s) => ({ tripEnds: { ...s.tripEnds, [end]: place } })),
  setTripPreview: (tripPreview) => set({ tripPreview }),
  setBackend: (backend) => set({ backend }),
  setStarted: () => set({ started: true }),
  setTransport: (transport) => set({ transport }),
  // A new route invalidates whatever the camera was following.
  setRoute: (route) =>
    set({
      route,
      fleetStart: null,
      tripLegs: null,
      pendingJoin: null,
      follow: null,
      trackedRiderId: null,
      autoAI: null,
      driverVehicle: 0,
      commuterVehicle: null,
      commuter: defaultTrip(route),
    }),
  setFocus: ({ route, scenario, start }, keepTrip = false) =>
    set((s) => {
      const commuter = defaultTrip(route);
      return {
        route,
        scenario: normalizeScenario(scenario),
        fleetStart: start,
        ...(keepTrip ? {} : { tripLegs: null, tripLeg: 0, pendingJoin: null }),
        follow: null,
        trackedRiderId: null,
        autoAI: null,
        driverVehicle: 0,
        commuterVehicle: null,
        commuter,
        // The phone views follow their person onto the new route.
        ...cameraFor(s.view, { driverVehicle: 0, commuter, shot: s.shot }),
      };
    }),
  setNetwork: (network) => set({ network }),
  setTripLegs: (tripLegs) => set({ tripLegs, tripLeg: 0, pendingJoin: null, tripPreview: null }),
  startLeg: (leg, routeId) => set({ tripLeg: leg, pendingJoin: { routeId, leg } }),
  clearPendingJoin: () => set({ pendingJoin: null }),
  upsertSession: (summary) =>
    set((s) => ({ sessions: { ...s.sessions, [summary.meta.sessionId]: summary } })),
  upsertSessions: (summaries) => {
    if (summaries.length === 0) return;
    set((s) => {
      const sessions = { ...s.sessions };
      for (const summary of summaries) sessions[summary.meta.sessionId] = summary;
      return { sessions };
    });
  },
  setWatchAreas: (watchAreas) => set({ watchAreas }),
  setMySessionId: (mySessionId) => set({ mySessionId }),
  dropSession: (id) =>
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      return { sessions, ...(s.follow?.kind === 'live' && s.follow.id === id && { follow: null }) };
    }),
  // Picking a vehicle in 3D on a phone view: the driver's phone goes to that
  // driver, the commuter's to someone riding it.
  setFollow: (follow) =>
    set((s) => ({
      follow,
      trackedRiderId: null,
      ...(s.view === 'driver' && follow?.kind === 'sim' ? { driverVehicle: follow.index } : {}),
      ...(s.view === 'commuter' && follow?.kind === 'sim'
        ? { commuterVehicle: follow.index, commuter: defaultTrip(s.route) }
        : {}),
    })),
  trackRider: (trackedRiderId) => set({ trackedRiderId, follow: null }),
  setAutoAI: (autoAI) => set({ autoAI }),
  setLocating: (locating, sharingAs = 'commuter') =>
    set({ locating, sharingAs, locateError: null }),
  setLocated: (located) => set({ located }),
  setLocateError: (locateError) => set({ locateError }),
  setShowFov: (showFov) => set({ showFov }),
  setLabVehicle: (labVehicle) => set({ labVehicle, labDoor: 0 }),
  setLabDoor: (labDoor) => set({ labDoor }),
  setFleetData: (fleetData) => set({ fleetData }),
  requestShot: (kind, area) =>
    set((s) => ({
      shot: { kind, seq: s.shot.seq + 1, ...(area && { area }) },
      follow: null,
      trackedRiderId: null,
    })),
  setMap: (map) => set({ map }),
}));

/** From the first stop to the end of its trip (the next terminal). */
function defaultTrip(route: Route): CommuterQuery {
  return { stop: 0, destination: stopsAhead(route, 0, 1).at(-1) ?? 0 };
}

/** Driver: the windscreen of their jeepney. Commuter: follow the rider, else look at the stop. */
function cameraFor(
  view: View,
  s: Pick<AppState, 'driverVehicle' | 'commuter' | 'shot'>,
): Partial<AppState> {
  if (view === 'driver')
    return { follow: { kind: 'sim', index: s.driverVehicle, view: 'pov' }, trackedRiderId: null };
  if (view !== 'commuter') return {};
  const q = s.commuter;
  return 'passenger' in q
    ? { follow: null, trackedRiderId: q.passenger }
    : {
        follow: null,
        trackedRiderId: null,
        shot: { kind: 'stop', stop: q.stop, seq: s.shot.seq + 1 },
      };
}

export function sameTarget(a: FollowTarget | null, b: FollowTarget | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'live') return b.kind === 'live' && a.id === b.id;
  return b.kind === 'sim' && a.index === b.index;
}
