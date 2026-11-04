/**
 * A planned trip on the map, end to end, so it can be checked against the
 * streets: a pin at home, where "you" appear (green), at the waiting area
 * (amber) and where you are going (red), joined along the roads. The way
 * to the waiting area, on foot or by tricycle (purple: once the trip is
 * taken, the very streets "you" go by); each jeepney ride along its route
 * (green, a second one orange); the walk to change jeepneys (grey); and the
 * last stretch to where you are going (purple). Labels say which is which:
 * where to board, where to get off.
 *
 * Every stretch between two spots goes by the streets (app/streetWays.ts).
 * Until a way is in, only the pins show: no line across the houses meanwhile.
 *
 * The trip shown is the one being looked at in the planner, else the one
 * being travelled. The bands widen as the camera pulls back, like the
 * jeepneys, so the whole trip shows from far.
 */

import { MY_LOCATION } from '@/app/locate';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Group } from 'three';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp, type TripEnd, type TripLeg, type TripPoint } from '@/app/store';
import { askWay, knownWay, useStreetWaysVersion } from '@/app/streetWays';
import { Polyline } from '@/core/geo/polyline';
import type { LocalPoint } from '@/core/geo/projection';
import { aheadOf } from '@/core/geo/routes';
import { besideRoad, onwardLine } from '@/core/people/onward';
import { wayLine } from '@/core/people/streetGraph';
import type { Network } from '@/core/network/network';
import { newRiderPose } from '@/core/people/riderMotion';
import type { WayMode } from '@/core/people/streetWay';
import { WALK_TO_STOP_M } from '@/core/network/plan';
import { metres } from '@/ui/phone/format';
import { FLAT_ORDER } from '../map/flatLayers';
import { Labels, type SceneLabel } from './Labels';
import { bandMaterial, widthlessRibbon } from './RouteLine';
import { viewScale } from './viewScale';

const COLOURS = {
  access: '#7c3aed',
  ride: ['#15803d', '#c2410c'],
  change: '#475569',
  from: '#15803d',
  waiting: '#b45309',
  to: '#b91c1c',
  agent: '#0e7490',
};
/** Band and casing widths close up (metres); both widen with the view. */
const BAND_M = 3;
const CASING_M = 5;
/** Along a jeepney's route, a point this often (metres). */
const STEP_M = 10;
/** Label heights above the ground (metres; grow with the view like the pins). */
const PIN_LABEL_Y = 6;
/** Above the stop's own name and its waiting count, which stand at the same place. */
const WAITING_LABEL_Y = 9;
const STOP_LABEL_Y = 4;
/** With no jeepney trip to draw, spots this far apart (metres) are not joined by road. */
const NO_TRIP_ROAD_M = 12_000;

interface Piece {
  points: LocalPoint[];
  colour: string;
}

interface Trip {
  pieces: Piece[];
  labels: SceneLabel[];
  /** The ways by street this trip draws, each from one spot to the next. */
  wanted: Array<[LocalPoint, LocalPoint, WayMode]>;
  /** Where the From pin stands: the waiting area chosen, else the stop chosen for you. */
  waitingArea: LocalPoint | null;
  /** Where the To pin stands: where they end up, off the road. */
  toPin: LocalPoint | null;
}

/** Where along route `r` stop `i` is, as a point. */
const stopAt = (network: Network, r: number, i: number): LocalPoint => {
  const route = network.routes[r]!.route;
  const p = route.polyline.pointAt(route.stops[i]!.s);
  return { x: p.x, z: p.z };
};

const middle = (a: LocalPoint, b: LocalPoint) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
const apart = (a: LocalPoint, b: LocalPoint) => Math.hypot(a.x - b.x, a.z - b.z);
/** On foot within a walk of the stop, else by tricycle (as the planner decides). */
const by = (m: number) => (m <= WALK_TO_STOP_M ? 'Walk' : 'Tricycle');

/** The trip's pieces to draw, and its labels. */
function tripOf(
  network: Network,
  legs: readonly TripLeg[] | null,
  ends: Record<TripPoint, TripEnd | null>,
  /**
   * The way "you" go to the first stop, once the trip is taken and it goes
   * by the streets: drawn instead of the planner's way there.
   */
  firstWay: { points: readonly LocalPoint[] } | null,
  /** Under way: only what is still ahead is said; "you" are there to see where they are. */
  going: boolean,
): Trip {
  const pieces: Piece[] = [];
  const labels: SceneLabel[] = [];
  const wanted: Trip['wanted'] = [];
  const label = (text: string, kind: string, p: LocalPoint, y: number) =>
    labels.push({ text, kind, x: p.x, y, z: p.z, scaleWithView: true });
  /** From `a` to `b` by the streets, once that way is in; `what` says how it is gone. */
  const stretch = (
    a: LocalPoint,
    b: LocalPoint,
    colour: string,
    what: (m: number) => string,
    mode: WayMode = 'walk',
    /** Off a vehicle `s` metres along `route`, and ending at `goal`: by that road's kerbs. */
    off?: { route: Network['routes'][number]['route']; s: number; goal: LocalPoint },
  ) => {
    if (apart(a, b) <= 1) return;
    wanted.push([a, b, mode]);
    const way = knownWay(a, b, mode);
    if (way === undefined) return;
    // The very line "you" go by, not the middle of the roads.
    const line = way
      ? (off
          ? onwardLine(off.route, off.s, way, off.goal)
          : wayLine(way.points, way.widths, mode)
        ).map(([x, , z]) => ({
          x,
          z,
        }))
      : [a, b];
    pieces.push({ points: line, colour });
    if (!going)
      label(
        way
          ? `${what(way.metres)} by the road`
          : `${what(apart(a, b))} (straight line, no road found)`,
        'trip-way',
        way ? line[Math.floor(line.length / 2)]! : middle(a, b),
        1,
      );
  };
  // Waiting by the road: at the kerb there, the one thing between home and the ride.
  const flag = legs?.[0]?.flag;
  // At "My location" they stand there themselves: nothing to cover them with.
  if (ends.home && !going && ends.home.name !== MY_LOCATION)
    label(`Home: ${ends.home.name}`, 'trip-from', ends.home.at, PIN_LABEL_Y);
  if (ends.from && !going)
    label(
      `From: ${flag ? 'wait here by the road' : ends.from.name}`,
      'trip-waiting',
      flag?.at ?? ends.from.at,
      PIN_LABEL_Y,
    );
  const lastLeg = legs?.[legs.length - 1];
  const lastRoute = lastLeg && network.routes[lastLeg.route]!.route;
  let toPin = ends.to && lastRoute ? besideRoad(lastRoute, ends.to.at) : (ends.to?.at ?? null);
  if (ends.to && toPin) label(`To: ${ends.to.name}`, 'trip-to', toPin, PIN_LABEL_Y);
  if (!legs || legs.length === 0) {
    // No jeepney trip (yet): the spots chosen, joined by the road between them.
    const spots = [ends.home?.at, ends.from?.at, ends.to?.at].filter((p) => p !== undefined);
    spots.slice(1).forEach((b, i) => {
      const a = spots[i]!;
      if (apart(a, b) <= NO_TRIP_ROAD_M) stretch(a, b, COLOURS.access, (m) => metres(m));
    });
    return { pieces, labels, wanted, waitingArea: ends.from?.at ?? null, toPin };
  }

  const first = legs[0]!;
  const waitingArea = flag?.at ?? ends.from?.at ?? stopAt(network, first.route, first.board);
  legs.forEach((leg, k) => {
    const route = network.routes[leg.route]!.route;
    const board = stopAt(network, leg.route, leg.board);
    const alight = stopAt(network, leg.route, leg.alight);
    // To the stop: from where the trip starts, or from the jeepney before.
    const before =
      k === 0
        ? (leg.from ?? ends.home?.at)
        : stopAt(network, legs[k - 1]!.route, legs[k - 1]!.alight);
    if (k === 0 && firstWay && firstWay.points.length > 1) {
      const way = firstWay.points;
      let m = 0;
      for (let i = 1; i < way.length; i++) m += apart(way[i - 1]!, way[i]!);
      pieces.push({ points: [...way], colour: COLOURS.access });
      if (!going)
        label(
          `${leg.approachMode === 'tricycle' ? 'Tricycle' : 'Walk'} ${metres(m)} by the streets`,
          'trip-way',
          way[Math.floor(way.length / 2)]!,
          1,
        );
    } else if (k > 0) {
      stretch(before!, board, COLOURS.change, (m) => `Walk ${metres(m)} to change`);
    } else if (before) {
      // By way of the waiting area, when one was chosen: it can be a little off the stop.
      const how = (m: number) =>
        `${leg.approachMode === 'tricycle' ? 'Tricycle' : 'Walk'} ${metres(m)}`;
      const mode = leg.approachMode ?? 'walk';
      if (flag) stretch(before, flag.at, COLOURS.access, how, mode);
      else if (ends.from) {
        stretch(before, ends.from.at, COLOURS.access, how, mode);
        stretch(ends.from.at, board, COLOURS.access, how, mode);
      } else stretch(before, board, COLOURS.access, how, mode);
    }
    // The ride, along the route from stop to stop (round the loop's end if need be).
    const from = leg.flag?.s ?? route.stops[leg.board]!.s;
    const length = aheadOf(route, from, route.stops[leg.alight]!.s);
    const L = route.polyline.length;
    const ride: LocalPoint[] = [];
    for (let d = 0; d < length; d += STEP_M) {
      const p = route.polyline.pointAt((from + d) % L);
      ride.push({ x: p.x, z: p.z });
    }
    ride.push(alight);
    if (ride.length > 1) pieces.push({ points: ride, colour: COLOURS.ride[k % 2]! });
    if (leg.flag) {
      if (!going) label(`Flag down: ${route.name}`, 'trip-board', leg.flag.at, WAITING_LABEL_Y);
    } else if (!going || k > 0)
      label(
        `${k > 0 ? 'Change here' : ends.from ? 'Board here' : 'From'}: ${route.stops[leg.board]!.name} · ${route.name}`,
        k === 0 && !ends.from ? 'trip-waiting' : 'trip-board',
        board,
        WAITING_LABEL_Y,
      );
    label(`Get off: ${route.stops[leg.alight]!.name}`, 'trip-alight', alight, STOP_LABEL_Y);
  });

  // The last stretch, to where you are going.
  const last = legs[legs.length - 1]!;
  const off = stopAt(network, last.route, last.alight);
  if (ends.to) {
    const route = network.routes[last.route]!.route;
    toPin = besideRoad(route, ends.to.at);
    stretch(off, ends.to.at, COLOURS.access, (m) => `${by(m)} ${metres(m)}`, 'walk', {
      route,
      s: route.stops[last.alight]!.s,
      goal: toPin,
    });
  }
  return { pieces, labels, wanted, waitingArea, toPin };
}

/** With "you" this near, a pin would stand in front of you: only its ring on the ground shows. */
const CLEAR_OF_YOU_M = 45;
const you = newRiderPose();

/**
 * A pin standing on the ground, growing with the view like the jeepneys, and a
 * ring round its foot. `flat`, or with "you" near it, only the ring: nothing
 * stands between the camera and you.
 */
function Pin({ at, colour, flat = false }: { at: LocalPoint; colour: string; flat?: boolean }) {
  const { twin } = useRuntimes();
  const pin = useRef<Group>(null);
  const head = useRef<Group>(null);
  useFrame((state) => {
    if (pin.current) pin.current.scale.setScalar(viewScale(state));
    if (!head.current) return;
    const query = useApp.getState().commuter;
    const here = 'passenger' in query ? twin.crew.worldPose(query.passenger, you) : null;
    head.current.visible =
      !flat && !(here && Math.hypot(here.x - at.x, here.z - at.z) < CLEAR_OF_YOU_M);
  });
  return (
    <group ref={pin} position={[at.x, 0, at.z]}>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.06, 0]}>
        <ringGeometry args={[1.5, 2.1, 40]} />
        <meshBasicMaterial color={colour} />
      </mesh>
      <group ref={head}>
        <mesh position={[0, 3.2, 0]}>
          <sphereGeometry args={[1.1, 20, 14]} />
          <meshStandardMaterial color={colour} />
        </mesh>
        <mesh position={[0, 1.4, 0]}>
          <coneGeometry args={[0.6, 2.4, 16]} />
          <meshStandardMaterial color={colour} />
        </mesh>
      </group>
    </group>
  );
}

/** One piece of the trip: a band with a white casing. */
function Band({ piece }: { piece: Piece }) {
  const geometry = useMemo(() => widthlessRibbon(new Polyline(piece.points)), [piece]);
  const casing = useMemo(() => bandMaterial('#ffffff', CASING_M), []);
  const fill = useMemo(() => bandMaterial(piece.colour, BAND_M), [piece.colour]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => casing.material.dispose(), [casing]);
  useEffect(() => () => fill.material.dispose(), [fill]);
  useFrame((state) => {
    const k = viewScale(state);
    casing.width.value = CASING_M * k;
    fill.width.value = BAND_M * k;
  });
  return (
    <group>
      <mesh geometry={geometry} material={casing.material} renderOrder={FLAT_ORDER.tripCasing} />
      <mesh geometry={geometry} material={fill.material} renderOrder={FLAT_ORDER.tripFill} />
    </group>
  );
}

/** Seconds between looking for the rider's way (it changes when the streets come in). */
const WAY_EVERY_MS = 1000;

/** The way the commuter app's own rider goes to their first stop, once the trip is taken. */
function useFirstWay(on: boolean): { points: LocalPoint[] } | null {
  const { twin } = useRuntimes();
  const query = useApp((s) => s.commuter);
  const [streets, setStreets] = useState(false);
  const [way, setWay] = useState<ReadonlyArray<readonly [number, number, number]> | null>(null);
  useEffect(() => {
    if (!on || !('passenger' in query)) {
      setWay(null);
      return;
    }
    const look = () => {
      const r = twin.crew.passengers.get(query.passenger);
      setWay(r?.way ?? null);
      setStreets(!r?.offStreets);
    };
    look();
    const id = window.setInterval(look, WAY_EVERY_MS);
    return () => window.clearInterval(id);
  }, [on, query, twin]);
  return useMemo(
    () => (way && streets ? { points: way.map(([x, , z]) => ({ x, z })) } : null),
    [way, streets],
  );
}

/** No trip: what a driver's map shows of all this is only the way the agent found them. */
const NO_ENDS = { home: null, from: null, to: null };

export function TripPlanLayer({
  network,
  agentOnly = false,
}: {
  network: Network;
  agentOnly?: boolean;
}) {
  const preview = useApp((s) => s.tripPreview);
  const taken = useApp((s) => s.tripLegs);
  const leg = useApp((s) => s.tripLeg);
  const tripEnds = useApp((s) => s.tripEnds);
  const ends = agentOnly ? NO_ENDS : tripEnds;
  const legs = agentOnly ? null : (preview ?? taken);
  const going = !agentOnly && !preview && !!taken;
  const firstWay = useFirstWay(going && leg === 0);
  const { twin } = useRuntimes();
  // Changes as ways come in, so the stretches waiting for them can be drawn.
  const ways = useStreetWaysVersion();
  const agentWay = useApp((s) => s.agentWay);
  const agentWays = useApp((s) => s.agentWays);
  const { pieces, labels, wanted, waitingArea, toPin } = useMemo(() => {
    const trip = tripOf(network, legs, ends, firstWay, going);
    // Ways being weighed: each in its own colour, named at its far end, apart.
    for (const w of agentWays ?? []) {
      trip.pieces.push({ points: w.points, colour: w.colour });
      const end = w.points[Math.floor(w.points.length * 0.7)]!;
      trip.labels.push({
        text: w.label,
        kind: 'trip-way',
        tone: w.colour,
        x: end.x,
        y: 1,
        z: end.z,
        scaleWithView: true,
      });
    }
    if (agentWay) {
      trip.pieces.push({ points: agentWay.points, colour: COLOURS.agent });
      const middle = agentWay.points[Math.floor(agentWay.points.length / 2)]!;
      trip.labels.push({
        text: agentWay.label,
        kind: 'trip-way',
        x: middle.x,
        y: 1,
        z: middle.z,
        scaleWithView: true,
      });
    }
    return trip;
  }, [network, legs, ends, firstWay, ways, agentWay, agentWays, going]);
  useEffect(() => {
    const origin = twin.route.projection?.origin;
    if (origin) for (const [a, b, mode] of wanted) askWay(a, b, origin, mode);
  }, [wanted, twin]);
  return (
    <>
      {pieces.map((p, i) => (
        <Band key={i} piece={p} />
      ))}
      {ends.home && !going && ends.home.name !== MY_LOCATION && (
        <Pin at={ends.home.at} colour={COLOURS.from} />
      )}
      {waitingArea && <Pin at={waitingArea} colour={COLOURS.waiting} flat={going} />}
      {toPin && <Pin at={toPin} colour={COLOURS.to} />}
      <Labels labels={labels} />
    </>
  );
}
