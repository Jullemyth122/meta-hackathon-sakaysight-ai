/**
 * The rest of Metro Manila around the focused route: every network route as
 * a light line (operator view), the commuter's planned trip, and the
 * jeepneys of the network's flows (core/network/flow.ts) near the camera.
 *
 * What each person sees is what they would see on the street:
 *
 *   operator  whatever the camera sees (groundSight.ts), free to move
 *             anywhere: everything close by, fewer and fewer further off.
 *   driver    the road ahead to the end of their screen's horizon (1.5 km),
 *             the mirror's worth behind (100 m), side streets near by.
 *   commuter  around them, about a 1.5 km walk-and-look.
 *
 * Flow vehicles are drawn in three levels of detail, by how far off they
 * look: the nearest in full, then their outsides, then their outlines
 * (vehicles/trafficModels.ts). Every vehicle in the city is looked at, a few
 * each frame, and all those near the view are drawn, however it turns: only
 * far off are they thinned, each by a number of its own, so which are drawn
 * does not change as the view moves. Positions are recomputed every frame
 * (the flow is a function of the clock, so this is cheap). Clicking one
 * focuses its route: the twin takes it over from the flow.
 */

import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { flowOf, focusRoute, getNetwork, roadShareOf } from '@/app/network';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import type { TwinRuntime } from '@/app/twinRuntime';
import { placeAt, viewArea } from '@/app/viewArea';
import type { Livery } from '@/core/fleet/fleetSim';
import { simplify } from '@/core/geo/simplify';
import { standStraight } from '@/core/geo/standStraight';
import { driveLine } from '@/core/geo/driveLine';
import type { Route } from '@/core/geo/routes';
import type { Network } from '@/core/network/network';
import type { FleetSim } from '@/core/fleet/fleetSim';
import type { FlowVehicle } from '@/core/network/flow';
import type { Crossing } from '@/core/people/crossing';
import { LANE_M } from '@/core/map/style';
import { MAP_LAYER } from '../map/flatLayers';
import { homeLane, VEHICLES, type FleetKind, type VehicleKind } from '@/core/vehicles/specs';
import { JeepneyInstances, type GroundPose } from '../jeepney/JeepneyInstances';
import { PuvBodies, type PuvState } from '../vehicles/PuvBodies';
import {
  TRAFFIC_DETAILS,
  TRAFFIC_LOOKS,
  trafficLook,
  trafficModel,
  type TrafficDetail,
  type TrafficLook,
} from '../vehicles/trafficModels';
import { fleetPose, flowPose } from './lanes';
import { GroundSight } from './groundSight';
import { viewScale } from './viewScale';
import { TripPlanLayer } from './TripPlanLayer';
import { chooseDetail, keepSlots, type Detail, type Slotted } from './slots';

/**
 * The nearest of each kind are drawn in full (7,000–19,000 triangles each,
 * interiors and all); past them, each vehicle's outside.
 */
const DETAILED: Record<FleetKind, number> = { jeepney: 20, modern: 6, uv: 5, bus: 6 };
const DETAILED_ALL = DETAILED.jeepney + DETAILED.modern + DETAILED.uv + DETAILED.bus;
const PUV_KINDS: readonly VehicleKind[] = ['modern', 'uv', 'bus'];
/** Vehicles drawn besides those in full, and how many of them may have the nearer model. */
const TRAFFIC = 6000;
const TRAFFIC_NEAR = 1500;
/**
 * The outside model out to this far (metres, divided by the view's symbol
 * scale, so as far as a vehicle of that size on screen looks): a jeepney
 * there is still some 25 pixels long. Beyond it, the outline: window pillars
 * finer than a pixel fall between the samples and shimmer as the view moves.
 */
const NEAR_MODEL_WITHIN_M = 320;
/** A refill looks at vehicles for this long a frame (milliseconds), so it never stalls one. */
const LOOK_MS_A_FRAME = 2;
/**
 * The nearest vehicles move every frame; the rest, a sixth of them each frame
 * in turn: from where they are, a vehicle's step between turns is under a
 * pixel, and working out where every vehicle is was a quarter of the frame.
 */
const POSED_EVERY_FRAME = 250;
const FAR_POSE_TURNS = 6;
/**
 * Every vehicle within this of the camera's spot is drawn (metres), and
 * within this many camera heights: thinning starts beyond what fills the view.
 */
const ALL_WITHIN_M = 1500;
const ALL_WITHIN_HEIGHTS = 3;
/** The room a vehicle takes on the road, past its body each way (metres). */
const ROOM_ALONG_M = 0.5;
/**
 * Traffic is enlarged with the view this far and no more. Enlarged like the
 * route's own symbols, far off it merges into solid bars along the roads.
 */
const MAX_TRAFFIC_SCALE = 5;
/**
 * Each vehicle is a little larger than the last by a number of its own, up to
 * this share. Enlarged vehicles still touch, and two the same size would have
 * faces in one plane: the renderer could not tell which is in front.
 */
const SIZE_SPREAD = 0.05;
/** How far ahead a vehicle near the view keeps clear (metres). */
const YIELD_LOOK_M = 7;
const YIELD_CELL_M = 24;
/** Stopped, it sets off again with this much more room than it stopped for (metres). */
const GO_AGAIN_ROOM_M = 5;
/** Traffic keeps off this much of the road either side of someone crossing, in all (metres). */
const CROSSING_WIDTH_M = 4;
/** Someone on foot, as traffic sees them (metres). */
const PERSON_M = 1.2;
/** Heading this far apart (cosine) is one stream of traffic, not a crossing. */
const SAME_STREAM_COS = 0.7;
/** Waiting, a vehicle eases to a stop and away again, this fast (per second). */
const YIELD_EASE = 2.5;
/** Having waited, it makes up the road it lost at this speed over its own (m/s). */
const CATCH_UP_MPS = 2;
/** A vehicle falls no further behind its timetable than this (metres). */
const MOST_LAG_M = 1500;
/** Above this much of the clock in a frame (seconds), everything is a blur: nobody waits. */
const NO_YIELD_OVER_STEP_S = 0.5;
/** Above this symbol scale vehicles are too small to tell one from another: nobody waits. */
const WAIT_BELOW_SCALE = 2;
/** A simulated vehicle sees what is within this ahead of it (metres)… */
const SEES_AHEAD_M = 60;
/** …in its lane, this far across, and beside it, this far across and along. */
const IN_LANE_M = 2.4;
const BESIDE_ACROSS_M = 5.8;
const BESIDE_ALONG_M = 14;
/** Looked over again this often while the view moves (seconds)… */
const REFILL_S = 0.25;
/** …moved this far (metres, and a share of the camera's height) or turned this much (cosine)… */
const MOVED_M = 15;
const MOVED_HEIGHTS = 0.05;
const TURNED_COS = 0.9995;
/** …and, otherwise, each time this much of the simulated clock has passed. */
const REFILL_STILL_S = 1.5;
/** Overview lines are simplified this much (metres): drawn thin, from far. */
const OVERVIEW_TOLERANCE_M = 12;
/** Slower than this (m/s), another route's vehicle is standing: short of any bend (standStraight). */
const STANDING_MPS = 0.5;
/** Pulled over: this far out past its kerb lane, onto the side of the road (metres). */
const PULLED_OVER_M = 1.4;
const LINE_Y = 0.35;
/** The overview lines show from this high (metres). */
const LINES_FROM_M = 1200;
const HIDDEN = 1e7;
/** Routes offered for what the camera is looking at. */
const ROUTES_IN_VIEW = 4;
const LIVERIES: Livery[] = ['red', 'yellow', 'green'];
/**
 * A flow jeepney's livery: its own, by its number on its route, as the twin
 * paints its jeepneys (FleetSim: i % 3), so it keeps its colour at every level
 * of detail, and when its route is focused and the twin takes it over.
 */
const liveryOf = (i: number): Livery => LIVERIES[i % 3]!;

/** A vehicle's key among all the flows. */
const keyOf = (r: number, i: number): number => r * 100_000 + i;

/** A flow jeepney's own number, 0–1, fixed by its route and place on it. */
const shareOf = (r: number, i: number): number =>
  (Math.imul(r * 1021 + i + 1, 0x9e3779b1) >>> 0) / 4_294_967_296;

/**
 * Which of the jeepneys in view to draw, at most `max`, nearest first. Plain
 * nearest-first would pack them round the camera and leave the rest of a wide
 * view empty, so each counts as nearer than it is by a share of its own: as
 * many drawn in each ring as in the ring twice as far out, on any view. The
 * share is fixed, so the same ones stay as the camera moves.
 */
export function flowsToDraw<T extends { r: number; i: number; d: number }>(
  found: readonly T[],
  max: number,
): T[] {
  const ranked = found.map((f) => ({ f, rank: f.d * Math.sqrt(shareOf(f.r, f.i)) }));
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked
    .slice(0, max)
    .map((x) => x.f)
    .sort((a, b) => a.d - b.d);
}

/** A vehicle placed on the road, with its own number. */
export interface PlacedFlow extends Footprint {
  share: number;
}

/** Where a vehicle stands on the road. Three.js yaw: forward is (cos h, −sin h) in x/z. */
export interface Footprint {
  x: number;
  z: number;
  heading: number;
  /** Its length and width (metres): a jeepney's when not given. */
  length?: number;
  width?: number;
  /** Pulled over at the side, waiting its time (at its terminal): in nobody's way. */
  aside?: boolean;
}

const JEEPNEY_LENGTH_M = 6.9;
const JEEPNEY_WIDTH_M = 2.2;
const lengthOf = (kind: FleetKind): number =>
  kind === 'jeepney' ? JEEPNEY_LENGTH_M : VEHICLES[kind].lengthM;
const widthOf = (kind: FleetKind): number =>
  kind === 'jeepney' ? JEEPNEY_WIDTH_M : VEHICLES[kind].widthM;

/**
 * Whether two vehicles' places on the road overlap, whatever the angle
 * between them (rectangles: separating axes). `spread` lengthens them,
 * `reach` grows them both ways.
 */
export function overlapping(a: Footprint, b: Footprint, spread = 1, reach = 1): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const al = (((a.length ?? JEEPNEY_LENGTH_M) * spread) / 2 + ROOM_ALONG_M) * reach;
  const bl = (((b.length ?? JEEPNEY_LENGTH_M) * spread) / 2 + ROOM_ALONG_M) * reach;
  const aw = ((a.width ?? JEEPNEY_WIDTH_M) / 2) * reach;
  const bw = ((b.width ?? JEEPNEY_WIDTH_M) / 2) * reach;
  const far = al + aw + bl + bw;
  if (Math.abs(dx) > far || Math.abs(dz) > far) return false;
  const ac = Math.cos(a.heading);
  const as = Math.sin(a.heading);
  const bc = Math.cos(b.heading);
  const bs = Math.sin(b.heading);
  // The angle between them, as a cosine and sine: all the axes need.
  const c = Math.abs(ac * bc + as * bs);
  const n = Math.abs(as * bc - ac * bs);
  const clear = (along: number, room: number) => Math.abs(along) >= room;
  return !(
    clear(dx * ac - dz * as, al + bl * c + bw * n) ||
    clear(dx * as + dz * ac, aw + bl * n + bw * c) ||
    clear(dx * bc - dz * bs, bl + al * c + aw * n) ||
    clear(dx * bs + dz * bc, bw + al * n + aw * c)
  );
}

/**
 * Which of the vehicles near the view must wait this frame: those with
 * something just ahead of them. In one stream, whoever is behind waits. Where
 * they cross or meet, the one with the higher number waits for the other, and
 * everyone waits for `others`, the simulated route's vehicles.
 */
export function whoWaits<T extends PlacedFlow>(
  close: readonly T[],
  others: readonly Footprint[],
  /** Those stopped already: they wait until there is room to go, not only to stand. */
  stopped?: ReadonlySet<number>,
): Set<number> {
  const cells = new Map<number, Array<Footprint & { share?: number }>>();
  const cellOf = (x: number, z: number) => x * 100_003 + z;
  const note = (v: Footprint) => {
    const key = cellOf(Math.round(v.x / YIELD_CELL_M), Math.round(v.z / YIELD_CELL_M));
    const here = cells.get(key);
    if (here) here.push(v);
    else cells.set(key, [v]);
  };
  for (const v of others) note(v);
  for (const v of close) note(v);
  const waiting = new Set<number>();
  for (const v of close) {
    const fx = Math.cos(v.heading);
    const fz = -Math.sin(v.heading);
    const look = stopped?.has(v.share) ? YIELD_LOOK_M + GO_AGAIN_ROOM_M : YIELD_LOOK_M;
    const probe = { ...v, x: v.x + fx * look, z: v.z + fz * look };
    const cx = Math.round(probe.x / YIELD_CELL_M);
    const cz = Math.round(probe.z / YIELD_CELL_M);
    search: for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const o of cells.get(cellOf(cx + dx, cz + dz)) ?? []) {
          if (o === v || o.aside || (o.x - v.x) * fx + (o.z - v.z) * fz <= 0) continue; // not ahead of it
          const stream = Math.cos(v.heading - o.heading) > SAME_STREAM_COS;
          if (!stream && o.share !== undefined && o.share > v.share) continue; // it waits for us
          if (overlapping(probe, o)) {
            waiting.add(v.share);
            break search;
          }
        }
  }
  return waiting;
}

/** How far a flow vehicle has fallen behind its timetable, how fast it is really going, and where it really is. */
export interface FlowWait {
  lag: number;
  mps: number;
  on: number;
  /**
   * Where it is drawn, kept here, not worked out as timetable less lag: the
   * models read it a frame apart from the wait, and frames are uneven, so a
   * vehicle standing still would shiver back and forth by what the timetable moved.
   */
  s: number;
}

/**
 * One frame of a flow vehicle waiting, or catching up: `on` is where its
 * timetable has it on a line `length` long. What is drawn (on − lag) moves by
 * the speed it is really going, so never back, whatever the timetable does.
 */
export function waitOn(
  w: FlowWait,
  on: number,
  length: number,
  held: boolean,
  stepS: number,
  ease: number,
): void {
  // How far its timetable moved on this frame: nothing, at one of its stops.
  const ahead = (((on - w.on) % length) + length) % length;
  const timetable = Number.isNaN(ahead) || ahead > length / 2 ? 0 : ahead;
  w.on = on;
  const wanted = held ? 0 : stepS > 0 ? timetable / stepS + CATCH_UP_MPS : 0;
  w.mps = Math.max(0, w.mps + (wanted - w.mps) * ease);
  const moved = w.mps * stepS;
  const lag = Math.max(0, w.lag + timetable - moved);
  w.lag = Math.min(MOST_LAG_M, lag);
  // Back on time, or as far behind as it may be: the timetable says. Else as far as it went.
  const where = lag === w.lag && lag > 0 ? w.s + moved : on - w.lag;
  w.s = ((where % length) + length) % length;
}

/**
 * What each simulated vehicle can see of the traffic near the view, for it to
 * brake and to keep from pulling out into: the simulation knows nothing of the
 * other routes. `ahead` and `beside` are written by vehicle id.
 */
export function seeTraffic(
  fleet: ReadonlyArray<Footprint & { id: number }>,
  traffic: readonly Footprint[],
  ahead: Float32Array,
  beside: Uint8Array,
): void {
  ahead.fill(Infinity);
  beside.fill(0);
  for (const o of fleet) {
    const fx = Math.cos(o.heading);
    const fz = -Math.sin(o.heading);
    for (const v of traffic) {
      if (v.aside) continue;
      const dx = v.x - o.x;
      const dz = v.z - o.z;
      if (Math.abs(dx) > SEES_AHEAD_M || Math.abs(dz) > SEES_AHEAD_M) continue;
      if (Math.cos(v.heading - o.heading) < SAME_STREAM_COS) continue;
      const along = dx * fx + dz * fz;
      // Right of the way of travel is (sin h, cos h); negative is towards the middle.
      const across = dx * Math.sin(o.heading) + dz * Math.cos(o.heading);
      if (along > 0 && along < SEES_AHEAD_M && Math.abs(across) < IN_LANE_M)
        ahead[o.id] = Math.min(ahead[o.id]!, along);
      if (Math.abs(along) < BESIDE_ALONG_M && across < -IN_LANE_M && across > -BESIDE_ACROSS_M)
        beside[o.id] = 1;
    }
  }
}

/** The strip of road someone is crossing, as other traffic sees it. */
const stripOf = ({ x, z, heading, length }: Crossing): Footprint => ({
  x,
  z,
  heading,
  length,
  width: CROSSING_WIDTH_M,
});

/** What the simulated route has on the road now, written into `out`. */
function twinFootprints(fleet: FleetSim, out: Array<Required<Footprint> & { id: number }>): void {
  let n = 0;
  fleet.vehicles.forEach((v, i) => {
    if (v.duty === 'parked') return;
    const f = (out[n++] ??= { x: 0, z: 0, heading: 0, length: 0, width: 0, aside: false, id: 0 });
    fleetPose(fleet, i, f);
    f.length = lengthOf(v.kind);
    f.width = widthOf(v.kind);
    f.id = i;
  });
  out.length = n;
}

/** Which flow jeepneys a view shows, around a point looking along a heading. */
export interface ViewReach {
  x: number;
  z: number;
  /** Ahead/behind/side limits (metres) relative to `heading`, or a plain radius. */
  ahead: number;
  behind: number;
  side: number;
  /** Three.js yaw: forward is (cos h, −sin h) in x/z. */
  heading: number;
}

/** Whether point (x, z) is within reach. */
export function inReach(r: ViewReach, x: number, z: number): boolean {
  const dx = x - r.x;
  const dz = z - r.z;
  const fwd = dx * Math.cos(r.heading) - dz * Math.sin(r.heading);
  const lat = dx * Math.sin(r.heading) + dz * Math.cos(r.heading);
  return fwd <= r.ahead && fwd >= -r.behind && Math.abs(lat) <= r.side;
}

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function boundsOf(route: Route): Bounds {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const p of route.polyline.points) {
    b.minX = Math.min(b.minX, p.x);
    b.maxX = Math.max(b.maxX, p.x);
    b.minZ = Math.min(b.minZ, p.z);
    b.maxZ = Math.max(b.maxZ, p.z);
  }
  return b;
}

/** Every route as one set of thin line segments (the focused one is drawn over its own). */
function NetworkLines({ network }: { network: Network }) {
  const camera = useThree((s) => s.camera);
  const lines = useMemo(() => {
    const parts: number[] = [];
    for (const { route } of network.routes) {
      const pts = simplify(route.polyline.points, OVERVIEW_TOLERANCE_M);
      for (let i = 1; i < pts.length; i++)
        parts.push(pts[i - 1]!.x, LINE_Y, pts[i - 1]!.z, pts[i]!.x, LINE_Y, pts[i]!.z);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(parts), 3));
    const m = new LineBasicMaterial({ color: '#5b6b8c' });
    const l = new LineSegments(g, m);
    l.frustumCulled = false;
    l.renderOrder = 5;
    return l;
  }, [network]);
  useEffect(
    () => () => {
      lines.geometry.dispose();
      (lines.material as LineBasicMaterial).dispose();
    },
    [lines],
  );
  // An overview of the network: from close up, they would only scribble over the road.
  useFrame(() => {
    lines.visible = camera.position.y > LINES_FROM_M;
  });
  return <primitive object={lines} />;
}

/** The commuter's legs: green for the first jeepney, orange for the second. */
/** The current view's reach, from the camera target (and the driver's jeepney). */
function reachFor(
  view: string,
  twin: TwinRuntime,
  target: Vector3,
  cameraHeight: number,
  driver: number,
): ViewReach {
  if (view === 'driver' && twin.fleet.vehicles[driver]) {
    const v = twin.fleet.vehicles[driver]!;
    const p = twin.route.polyline.pointAt(v.s);
    const heading = twin.route.polyline.headingAt(v.s, 4.3);
    return { x: p.x, z: p.z, heading, ahead: 1500, behind: 100, side: 300 };
  }
  const r = view === 'commuter' ? 1500 : Math.max(600, Math.min(4000, cameraHeight * 2));
  return { x: target.x, z: target.z, heading: 0, ahead: r, behind: r, side: r };
}

/** A refill in progress: what it is looking at, how far it has got, and what it has found. */
interface Scan {
  t: number;
  reach: ViewReach | null;
  radius: number;
  /** Everything this near is drawn; further off, thinned (flowsToDraw). */
  allWithinM: number;
  routes: number[];
  route: number;
  vehicle: number;
  found: Array<{ r: number; i: number; d: number }>;
  /** In the frame and near enough to tell apart, for the side panel. */
  inView: Array<{ r: number; riders: number; kind: FleetKind }>;
  /** Share of the traffic drawn (the Simulate tab), and the kinds asked for. */
  density: number;
  left: Record<FleetKind, number>;
}

/** One kind's nearest flow vehicles, drawn in full. */
function FlowPuvs({
  kind,
  slots,
  placeFlow,
  drawnS,
  onSelect,
}: {
  kind: VehicleKind;
  slots: { current: Record<FleetKind, Array<Slotted | null>> };
  placeFlow: (r: number, i: number, out: GroundPose) => void;
  /** Metres it has really come round its route: a vehicle standing still has still wheels. */
  drawnS: (r: number, i: number) => number;
  onSelect: (slot: Slotted | null | undefined) => void;
}) {
  const stateAt = useCallback(
    (k: number, out: PuvState) => {
      const slot = slots.current[kind][k];
      out.shown = !!slot;
      out.open = false;
      if (!slot) return;
      // The wheels have turned as far as it has come round its route.
      out.spin = drawnS(slot[0], slot[1]) / VEHICLES[kind].wheelRadiusM;
    },
    [kind, slots, drawnS],
  );
  const poseAt = useCallback(
    (k: number, out: GroundPose) => {
      const slot = slots.current[kind][k];
      if (slot) placeFlow(slot[0], slot[1], out);
    },
    [kind, slots, placeFlow],
  );
  return (
    <PuvBodies
      kind={kind}
      count={DETAILED[kind]}
      poseAt={poseAt}
      stateAt={stateAt}
      castShadow={false}
      layer={MAP_LAYER}
      onSelect={(k) => onSelect(slots.current[kind][k])}
    />
  );
}

/** One look at one level of detail: a draw call, and who is in it, nearest first. */
interface TrafficPool {
  mesh: InstancedMesh;
  capacity: number;
  items: Slotted[];
  /** Each one's own size (SIZE_SPREAD). */
  sizes: number[];
  /** How many at the front are posed every frame, and whose turn is next among the rest. */
  head: number;
}

function FlowJeepneys({ network, twin }: { network: Network; twin: TwinRuntime }) {
  const setFocus = useApp((s) => s.setFocus);
  const setFollow = useApp((s) => s.setFollow);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: Vector3 } | null;
  const raycaster = useThree((s) => s.raycaster);
  const bounds = useMemo(() => network.routes.map((r) => boundsOf(r.route)), [network]);
  /** Each kind's detailed slot → [route, vehicle], or null. */
  const slots = useRef<Record<FleetKind, Array<Slotted | null>>>({
    jeepney: Array(DETAILED.jeepney).fill(null),
    modern: Array(DETAILED.modern).fill(null),
    uv: Array(DETAILED.uv).fill(null),
    bus: Array(DETAILED.bus).fill(null),
  });
  const since = useRef(Infinity);
  /** Where the camera was and what the clock said at the last look. */
  const lastLook = useRef({ eye: new Vector3(), aim: new Vector3(), t: -Infinity });
  const scan = useRef<Scan | null>(null);
  const frame = useRef(0);
  /** The pools changed hands: each moves to its new vehicle at once. */
  const freshPools = useRef(false);
  /** The view's symbol scale, and who was drawn how at the last refill. */
  const viewK = useRef(1);
  const details = useRef<ReadonlyMap<number, Detail>>(new Map());
  /**
   * How far each flow vehicle near the view has fallen behind its timetable,
   * waiting for what is ahead of it: how fast it is really going (m/s), where
   * its timetable had it last, and whether it is held. What is drawn only ever
   * moves on, by that speed: however the timetable changes, never back.
   */
  const waits = useRef(
    new Map<number, FlowWait & { r: number; i: number; held: boolean; frame: number }>(),
  );
  const lastClock = useRef(0);
  /** The flow vehicles near the view, and what the simulated route has on the road. */
  const close = useRef<
    Array<
      Required<PlacedFlow> & {
        key: number;
        r: number;
        i: number;
        speed: number;
        on: number;
        length_: number;
      }
    >
  >([]);
  const twinOnRoad = useRef<Array<Required<Footprint> & { id: number }>>([]);
  const scratch = useMemo(() => ({}) as FlowVehicle, []);
  const sight = useMemo(() => new GroundSight(), []);
  // Each slot painted as the jeepney in it (changed only when the slots change hands).
  const [liveries, setLiveries] = useState<Livery[]>(() =>
    Array(DETAILED.jeepney).fill(liveryOf(0)),
  );
  const focusedId = twin.route.id;
  const pools = useMemo(() => {
    const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.5 });
    const all = new Map<string, TrafficPool>();
    for (const look of TRAFFIC_LOOKS)
      for (const detail of TRAFFIC_DETAILS) {
        const capacity = detail === 'near' ? TRAFFIC_NEAR : TRAFFIC;
        const mesh = new InstancedMesh(trafficModel(look, detail), material, capacity);
        mesh.name = `traffic ${look} ${detail}`;
        mesh.count = 0;
        mesh.frustumCulled = false;
        // Not for a cabin camera: from inside, the far traffic is a few pixels.
        mesh.layers.set(MAP_LAYER);
        all.set(`${look}:${detail}`, { mesh, capacity, items: [], sizes: [], head: 0 });
      }
    return { all, material };
  }, []);
  const poolOf = useCallback(
    (look: TrafficLook, detail: TrafficDetail) => pools.all.get(`${look}:${detail}`)!,
    [pools],
  );
  useEffect(() => {
    camera.layers.enable(MAP_LAYER);
    raycaster.layers.enable(MAP_LAYER); // still clickable
  }, [camera, raycaster]);
  useEffect(() => () => pools.material.dispose(), [pools]);
  // Dev only: what is waiting and what is hidden, from the browser console.
  useEffect(() => {
    if (import.meta.env.DEV)
      Object.assign(window, { __traffic: { waits, close, twinOnRoad, details } });
  }, []);
  const pose = useMemo(() => ({ x: 0, z: 0, heading: 0 }), []);
  /** Whether the vehicle placeFlow placed last is pulled over (see there). */
  const aside = useRef(false);
  const matrix = useMemo(() => new Matrix4(), []);
  const turn = useMemo(() => new Quaternion(), []);
  const up = useMemo(() => new Vector3(0, 1, 0), []);
  const at = useMemo(() => new Vector3(), []);
  const look = useMemo(() => new Vector3(), []);
  const size = useMemo(() => new Vector3(), []);

  /** Where flow jeepney i of route r is now. */
  const placeFlow = useCallback(
    (r: number, i: number, out: GroundPose) => {
      const route = network.routes[r]!.route;
      const onTime = flowOf(r).vehicle(i, twin.clockS, scratch).s;
      // Behind its timetable by however long it has had to wait.
      const held = waits.current.size > 0 ? waits.current.get(keyOf(r, i)) : undefined;
      const s = held?.s ?? onTime;
      const standing = (held ? held.mps : scratch.speedMps) < STANDING_MPS;
      // Standing by its timetable (at its terminal, its time not come): pulled
      // over at the side, out of everyone's way. Held up by traffic: in its lane.
      aside.current = standing && !held;
      // In its own lane, room allowing; standing, short of any bend (its U-turn).
      flowPose(
        route,
        standing ? standStraight(route, s) : s,
        aside.current ? -PULLED_OVER_M : homeLane(i) * LANE_M,
        out,
      );
    },
    [network, twin, scratch],
  );

  const drawnS = useCallback(
    (r: number, i: number) =>
      waits.current.get(keyOf(r, i))?.s ?? flowOf(r).vehicle(i, twin.clockS, scratch).s,
    [twin, scratch],
  );

  // First the refill, then the poses: a pool that changed hands moves in the
  // same frame, and is never drawn for one with the last refill's vehicles.
  useFrame((_, dt) => {
    since.current += dt;
    if (!scan.current && since.current >= REFILL_S) {
      const last = lastLook.current;
      const moved =
        last.eye.distanceTo(camera.position) > MOVED_M + camera.position.y * MOVED_HEIGHTS ||
        last.aim.dot(camera.getWorldDirection(look)) < TURNED_COS;
      if (moved || twin.clockS - last.t >= REFILL_STILL_S) {
        since.current = 0;
        last.eye.copy(camera.position);
        last.aim.copy(look);
        last.t = twin.clockS;
        scan.current = startScan();
      }
    }
    if (scan.current && lookOn(scan.current)) {
      draw(scan.current.found);
      if (!scan.current.reach) tellPanel(scan.current);
      scan.current = null;
    }
  });

  /** The next entry of the near vehicles' list, at `pose`. */
  function noteClose(r: number, i: number, n: number): void {
    const v = (close.current[n] ??= {
      aside: false,
      key: 0,
      r: 0,
      i: 0,
      speed: 0,
      on: 0,
      length_: 1,
      share: 0,
      x: 0,
      z: 0,
      heading: 0,
      length: 0,
      width: 0,
    });
    const kind = flowOf(r).kinds[i]!;
    v.key = keyOf(r, i);
    v.r = r;
    v.i = i;
    v.speed = scratch.speedMps;
    v.on = scratch.s;
    v.length_ = network.routes[r]!.route.polyline.length;
    v.share = shareOf(r, i);
    v.x = pose.x;
    v.z = pose.z;
    v.heading = pose.heading;
    v.length = lengthOf(kind);
    v.width = widthOf(kind);
    v.aside = aside.current;
  }

  /**
   * The commuter app's own rider, on their way: nothing drives through them,
   * on any road. Standing at the kerb they are in nobody's way: traffic goes
   * by, as it must for their ride to get to them.
   */
  function yourselfOn(): Footprint[] {
    const q = useApp.getState().commuter;
    const r = 'passenger' in q ? twin.crew.passengers.get(q.passenger) : undefined;
    if (!r || r.vehicleId !== null || !r.motion) return [];
    const crossing = r.crossings?.[0];
    if (crossing?.hailing && !crossing.stepped) return [];
    const { x, z, yaw } = r.pose;
    return [{ x, z, heading: yaw, length: PERSON_M, width: PERSON_M }];
  }

  /** Everyone near the view with something ahead slows and waits; the rest make up time. */
  function giveWay(count: number, stepS: number): void {
    const list = close.current;
    list.length = count;
    const tick = frame.current;
    if (stepS > NO_YIELD_OVER_STEP_S) {
      for (const c of twin.crew.crossingsNow) c.flowBusy = false;
      waits.current.clear();
      twin.fleet.trafficAhead.fill(Infinity);
      twin.fleet.trafficBeside.fill(0);
      return;
    }
    seeTraffic(twinOnRoad.current, list, twin.fleet.trafficAhead, twin.fleet.trafficBeside);
    const crossing = twin.crew.crossingsNow;
    const strips = crossing.map(stripOf);
    // Someone at the kerb steps out once no traffic of other routes is on their strip.
    crossing.forEach((c, i) => (c.flowBusy = list.some((v) => overlapping(strips[i]!, v))));
    const stopped = new Set<number>();
    for (const v of list) if (waits.current.get(v.key)?.held) stopped.add(v.share);
    const waiting = whoWaits(list, [...twinOnRoad.current, ...strips, ...yourselfOn()], stopped);
    const ease = Math.min(1, stepS * YIELD_EASE);
    for (const v of list) {
      const held = waiting.has(v.share);
      let w = waits.current.get(v.key);
      if (!w) {
        if (!held) continue;
        w = { lag: 0, mps: v.speed, on: v.on, s: v.on, r: v.r, i: v.i, held, frame: tick };
        waits.current.set(v.key, w);
      }
      w.frame = tick;
      w.held = held;
      waitOn(w, v.on, v.length_, held, stepS, ease);
      if (w.lag <= 0 && !held) waits.current.delete(v.key);
    }
    // Gone from near the view: it gets back on time out there, unseen.
    for (const [key, w] of waits.current) {
      if (w.frame === tick) continue;
      w.lag -= CATCH_UP_MPS * stepS;
      if (w.lag <= 0) {
        waits.current.delete(key);
        continue;
      }
      const L = network.routes[w.r]!.route.polyline.length;
      w.on = flowOf(w.r).vehicle(w.i, twin.clockS, scratch).s;
      w.s = (((w.on - w.lag) % L) + L) % L;
    }
  }

  // The traffic follows its vehicles every frame, growing with the view like the rest.
  useFrame((state) => {
    const k = Math.min(viewScale(state), MAX_TRAFFIC_SCALE);
    viewK.current = k;
    const turnNow = frame.current++ % FAR_POSE_TURNS;
    const all = freshPools.current;
    freshPools.current = false;
    const watchTwin = k < WAIT_BELOW_SCALE;
    const stepS = Math.max(0, twin.clockS - lastClock.current);
    lastClock.current = twin.clockS;
    if (watchTwin) {
      twinFootprints(twin.fleet, twinOnRoad.current);
      let n = 0;
      for (const kind of Object.keys(slots.current) as FleetKind[])
        for (const slot of slots.current[kind]) {
          if (!slot) continue;
          placeFlow(slot[0], slot[1], pose);
          noteClose(slot[0], slot[1], n++);
        }
      for (const { items, head } of pools.all.values())
        for (let m = 0; m < head; m++) {
          const [r, i] = items[m]!;
          placeFlow(r, i, pose);
          noteClose(r, i, n++);
        }
      giveWay(n, stepS);
    } else {
      // Zoomed out: nobody near to wait for.
      for (const c of twin.crew.crossingsNow) c.flowBusy = false;
      twin.fleet.trafficAhead.fill(Infinity);
      twin.fleet.trafficBeside.fill(0);
      if (waits.current.size > 0) giveWay(0, stepS);
    }
    for (const pool of pools.all.values()) {
      const { mesh, items, sizes, head } = pool;
      mesh.count = items.length;
      if (items.length === 0) continue;
      // The front of the pool, and one turn's worth of the rest.
      const rest = items.length - head;
      const chunk = Math.ceil(rest / FAR_POSE_TURNS);
      const from = all ? head : head + turnNow * chunk;
      const to = all ? items.length : Math.min(items.length, from + chunk);
      const place = (n: number) => {
        const [r, i] = items[n]!;
        placeFlow(r, i, pose);
        turn.setFromAxisAngle(up, pose.heading);
        matrix.compose(at.set(pose.x, 0, pose.z), turn, size.setScalar(k * sizes[n]!));
        mesh.setMatrixAt(n, matrix);
      };
      for (let n = 0; n < head; n++) place(n);
      for (let n = from; n < to; n++) place(n);
      const attribute = mesh.instanceMatrix;
      attribute.clearUpdateRanges();
      if (head > 0) attribute.addUpdateRange(0, head * 16);
      if (to > from) attribute.addUpdateRange(from * 16, (to - from) * 16);
      attribute.needsUpdate = true;
    }
  });

  /** A refill begun: which routes the view takes in, and how many of each to look at. */
  function startScan(): Scan {
    const { view, driverVehicle, trafficShare, scenario } = useApp.getState();
    // The operator sees what the camera sees; a driver or commuter what they would on the street.
    const reach =
      view === 'twin'
        ? null
        : reachFor(view, twin, controls?.target ?? new Vector3(), camera.position.y, driverVehicle);
    const radius = reach ? Math.max(reach.ahead, reach.behind, reach.side) : 0;
    if (!reach) sight.update(camera);
    const wanted = network.routes.flatMap(({ route }, r) => {
      if (route.id === focusedId) return []; // the twin draws these
      const b = bounds[r]!;
      const seen = reach
        ? b.maxX >= reach.x - radius &&
          b.minX <= reach.x + radius &&
          b.maxZ >= reach.z - radius &&
          b.minZ <= reach.z + radius
        : b.maxX >= sight.minX &&
          b.minX <= sight.maxX &&
          b.maxZ >= sight.minZ &&
          b.minZ <= sight.maxZ;
      return seen ? [r] : [];
    });
    return {
      t: twin.clockS,
      reach,
      radius,
      allWithinM: reach ? Infinity : Math.max(ALL_WITHIN_M, camera.position.y * ALL_WITHIN_HEIGHTS),
      routes: wanted,
      route: 0,
      vehicle: 0,
      found: [],
      inView: [],
      density: trafficShare,
      left: scenario.mix ?? { jeepney: 1, modern: 1, uv: 1, bus: 1 },
    };
  }

  /** Look at a frame's worth of vehicles; true when all are done. */
  function lookOn(s: Scan): boolean {
    const until = performance.now() + LOOK_MS_A_FRAME;
    const { reach, allWithinM } = s;
    let looked = 0;
    while (s.route < s.routes.length) {
      const r = s.routes[s.route]!;
      const flow = flowOf(r);
      const line = network.routes[r]!.route.polyline;
      // Its drive line, made while looking: one a frame at most, not all at once when drawn.
      if (s.vehicle === 0) {
        driveLine(network.routes[r]!.route);
        if (performance.now() > until) return false;
      }
      for (; s.vehicle < flow.count; s.vehicle++) {
        if (++looked % 64 === 0 && performance.now() > until) return false;
        const v = flow.vehicle(s.vehicle, s.t, scratch);
        if (!v.inService) continue; // parked for the night
        const share = shareOf(r, s.vehicle);
        // Each road shows what it has room for, and each vehicle stays drawn or not all the way.
        if (share > s.density * roadShareOf(r) || s.left[v.kind] === 0) continue;
        const p = line.pointAt(v.s);
        if (reach ? !inReach(reach, p.x, p.z) : !sight.sees(p.x, p.z)) continue;
        const d = reach ? Math.hypot(p.x - reach.x, p.z - reach.z) : sight.away(p.x, p.z);
        if (!reach && sight.framed && d <= allWithinM)
          s.inView.push({ r, riders: v.occupancy, kind: v.kind });
        // As many in each ring as in the ring twice as far out, whichever way it looks.
        if (d * Math.sqrt(share) <= allWithinM) s.found.push({ r, i: s.vehicle, d });
      }
      s.route++;
      s.vehicle = 0;
    }
    return true;
  }

  /** The side panel's picture of what the camera is looking at. */
  function tellPanel({ inView, allWithinM }: Scan): void {
    const onRoute = new Map<number, number>();
    const kinds: Record<FleetKind, number> = { jeepney: 0, modern: 0, bus: 0, uv: 0 };
    let vehicles = inView.length;
    let own = 0;
    let people = 0;
    for (const { r, riders, kind } of inView) {
      onRoute.set(r, (onRoute.get(r) ?? 0) + 1);
      kinds[kind]++;
      people += riders;
    }
    // The route simulated in full is not among the flows.
    const line = twin.route.polyline;
    for (const v of twin.fleet.vehicles) {
      if (v.duty === 'parked') continue;
      const p = line.pointAt(v.s);
      if (!sight.sees(p.x, p.z) || !sight.framed || sight.away(p.x, p.z) > allWithinM) continue;
      vehicles++;
      own++;
      people += v.occupancy;
      kinds[v.kind]++;
    }
    viewArea.vehicles = vehicles;
    viewArea.ownVehicles = own;
    viewArea.kinds = kinds;
    viewArea.riders = people;
    viewArea.place = placeAt(sight.midX, sight.midZ);
    viewArea.routes = [...onRoute]
      .sort((a, b) => b[1] - a[1])
      .slice(0, ROUTES_IN_VIEW)
      .map(([route, count]) => ({
        route,
        name: network.routes[route]!.route.name,
        vehicles: count,
      }));
  }

  /** A refill finished: each vehicle in the detail its distance calls for. */
  function draw(found: Scan['found']): void {
    const k = viewK.current;
    const placed = flowsToDraw(found, DETAILED_ALL + TRAFFIC).map(({ r, i, d }) => {
      placeFlow(r, i, pose);
      const kind = flowOf(r).kinds[i]!;
      return {
        r,
        i,
        d,
        x: pose.x,
        z: pose.z,
        heading: pose.heading,
        share: shareOf(r, i),
        length: lengthOf(kind),
        width: widthOf(kind),
      };
    });
    twinFootprints(twin.fleet, twinOnRoad.current);
    const kept = [...placed].sort((a, b) => a.d - b.d);

    const height = camera.position.y;
    const chosen = chooseDetail(
      kept.map(({ r, i, d }) => ({
        key: keyOf(r, i),
        kind: flowOf(r).kinds[i]!,
        away: Math.hypot(d, height) / k,
      })),
      details.current,
      { full: DETAILED, nearM: NEAR_MODEL_WITHIN_M, near: TRAFFIC_NEAR },
    );
    details.current = chosen;

    const full: Record<FleetKind, Slotted[]> = { jeepney: [], modern: [], uv: [], bus: [] };
    for (const pool of pools.all.values()) {
      pool.items = [];
      pool.sizes = [];
      pool.head = 0;
      pool.mesh.boundingSphere = null; // for clicks: they have all moved
    }
    kept.forEach(({ r, i, share }, rank) => {
      const kind = flowOf(r).kinds[i]!;
      const detail = chosen.get(keyOf(r, i))!;
      if (detail === 'full') {
        full[kind].push([r, i]);
        return;
      }
      const pool = poolOf(trafficLook(kind, liveryOf(i)), detail);
      if (pool.items.length >= pool.capacity) return;
      pool.items.push([r, i]);
      pool.sizes.push(1 + SIZE_SPREAD * share);
      if (rank < POSED_EVERY_FRAME) pool.head = pool.items.length;
    });
    // One already drawn keeps its slot, and so its look.
    for (const kind of Object.keys(full) as FleetKind[])
      slots.current[kind] = keepSlots(slots.current[kind], full[kind]);
    const painted = slots.current.jeepney.map((slot) => liveryOf(slot?.[1] ?? 0));
    setLiveries((now) => (now.every((l, n) => l === painted[n]) ? now : painted));
    freshPools.current = true;
  }

  const poseAt = useCallback(
    (k: number, out: GroundPose) => {
      const slot = slots.current.jeepney[k];
      if (!slot) {
        out.x = out.z = HIDDEN;
        out.heading = 0;
        return;
      }
      placeFlow(slot[0], slot[1], out);
    },
    [placeFlow],
  );

  /** Focus a flow vehicle's route: the new twin has that very vehicle, and the view follows it. */
  const select = useCallback(
    (slot: Slotted | null | undefined) => {
      if (!slot) return;
      const [r, i] = slot;
      const focus = focusRoute(r, twin, i);
      setFocus(focus);
      if (useApp.getState().view === 'twin')
        setFollow({ kind: 'sim', index: focus.clickedAt, view: 'chase' });
    },
    [twin, setFocus, setFollow],
  );

  return (
    <>
      <JeepneyInstances
        count={DETAILED.jeepney}
        liveries={liveries}
        poseAt={poseAt}
        scaleWithView
        castShadow={false}
        layer={MAP_LAYER}
        onSelect={(k) => select(slots.current.jeepney[k])}
      />
      {PUV_KINDS.map((kind) => (
        <FlowPuvs
          key={kind}
          kind={kind}
          slots={slots}
          placeFlow={placeFlow}
          drawnS={drawnS}
          onSelect={select}
        />
      ))}
      {[...pools.all].map(([key, pool]) => (
        <primitive
          key={key}
          object={pool.mesh}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation();
            if (e.instanceId !== undefined) select(pool.items[e.instanceId]);
          }}
        />
      ))}
    </>
  );
}

export function NetworkLayer() {
  const { twin } = useRuntimes();
  const state = useApp((s) => s.network.state);
  const view = useApp((s) => s.view);
  const otherRoutes = useApp((s) => s.otherRoutes);
  const network = state === 'ready' ? getNetwork() : null;
  if (!network) return null;
  return (
    <>
      {view === 'twin' && <NetworkLines network={network} />}
      {(view === 'commuter' || view === 'driver') && (
        <TripPlanLayer network={network} agentOnly={view === 'driver'} />
      )}
      {otherRoutes && <FlowJeepneys network={network} twin={twin} />}
    </>
  );
}
