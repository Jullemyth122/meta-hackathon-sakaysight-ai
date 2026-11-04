/**
 * Where people stand at a stop, on the pavement beside the kerb the jeepney
 * pulls in to (kerbAt: the real road's width, from OpenStreetMap).
 *
 *   along   metres along the road from the stop: + ahead, − behind. The
 *           jeepney stops with its middle at 0, so its rear door is at
 *           about −3.
 *   in      metres onto the pavement from the kerb.
 *
 * A Philippine jeepney stop is not a queue. People wait wherever there is
 * room or shade, bunch up where they expect the rear door to stop, step to
 * the kerb edge when a jeepney comes, and the ones getting off walk out
 * through the same crowd. So there is one stop area, used both ways, and
 * everyone gets their own spot in it, scattered, not a grid. Who boards
 * first is still who came first (dispatch.ts and the commuter app rely on
 * it); only where they stand is loose.
 *
 * The area is drawn for the simulation, not a surveyed sidewalk.
 */

import { kerbAt, type Route } from '../geo/routes';
import type { LocalPoint } from '../geo/projection';
import type { StopSides } from './streetGraph';
import { createRng, gaussian } from '../math/random';

/** The one marked area per stop: centre along, length along, depth onto the pavement. */
export const STOP_AREA = { along: 0.5, length: 16, depth: 5.5 } as const;

/** People bunch around where the rear door stops (along ≈ −3)… */
const CROWD_ALONG_M = -2;
/** …and spread this far either way (one standard deviation). */
const CROWD_SPREAD_M = 4;
/** Nobody stands further than this from the stop, along the road. */
const CROWD_REACH_M = 10;
/** Closer than this to someone else is too close; try another spot. */
const PERSONAL_SPACE_M = 0.65;
/** Candidate spots tried per person (some fall in the road at a bend). */
const SPOT_TRIES = 20;

/** Metres from the route line to the kerb at a stop. */
export function kerbOf(route: Route, stop: number): number {
  return kerbAt(route, route.stops[stop]!.s);
}

/** Along-route position `along` metres from a stop, in the direction of travel. */
function sAlong(route: Route, stop: number, direction: 1 | -1, along: number): number {
  const L = route.polyline.length;
  const s = route.stops[stop]!.s + along * direction;
  return route.loop ? ((s % L) + L) % L : Math.max(0, Math.min(L, s));
}

/**
 * A point `along` metres from the stop, following the road (it bends at the
 * SM terminal and the Tungko block), and `out` metres to the right of it.
 */
export function stopPoint(
  route: Route,
  stop: number,
  direction: 1 | -1,
  along: number,
  out: number,
): LocalPoint {
  const s = sAlong(route, stop, direction, along);
  const p = route.polyline.pointAt(s);
  const yaw = route.polyline.headingAt(s, 4.3) + (direction === 1 ? 0 : Math.PI);
  // Right of the direction of travel: (sin θ, cos θ).
  return { x: p.x + Math.sin(yaw) * out, z: p.z + Math.cos(yaw) * out };
}

/** A point `inM` metres onto the pavement from the kerb, wherever the kerb is there. */
export function pavementPoint(
  route: Route,
  stop: number,
  direction: 1 | -1,
  along: number,
  inM: number,
): LocalPoint {
  const kerb = kerbAt(route, sAlong(route, stop, direction, along));
  return stopPoint(route, stop, direction, along, kerb + inM);
}

/**
 * Where someone waits at the side of the road, `s` metres along the route:
 * `inM` onto the pavement, on the kerb a vehicle going `direction` pulls in to.
 */
export function roadsidePoint(route: Route, s: number, direction: 1 | -1, inM = 1): LocalPoint {
  const p = route.polyline.pointAt(s);
  const yaw = route.polyline.headingAt(s, 4.3) + (direction === 1 ? 0 : Math.PI);
  const out = kerbAt(route, s) + inM;
  return { x: p.x + Math.sin(yaw) * out, z: p.z + Math.cos(yaw) * out };
}

/**
 * Whether `p` is on a road the route drives on: closer to the route line
 * than its kerb. Where the route doubles back (a terminal loop), one road's
 * pavement can be another road's lane.
 */
export function onRouteRoad(route: Route, p: LocalPoint): boolean {
  const hit = route.polyline.project(p);
  return hit.offset < kerbAt(route, hit.s) + 0.15;
}

/** Centre of the stop area. */
export function areaCentre(route: Route, stop: number, direction: 1 | -1): LocalPoint {
  return pavementPoint(route, stop, direction, STOP_AREA.along, 0.2 + STOP_AREA.depth / 2);
}

/**
 * The stop area as quads (four corners each) along the curve of the kerb,
 * 1 m long, leaving out any that would lie on the route's road.
 */
export function stopAreaQuads(route: Route, stop: number, direction: 1 | -1): LocalPoint[][] {
  const quads: LocalPoint[][] = [];
  const from = STOP_AREA.along - STOP_AREA.length / 2;
  const at = (along: number, inM: number) => pavementPoint(route, stop, direction, along, inM);
  for (let a = from; a < from + STOP_AREA.length - 1e-6; a += 1) {
    const inner = 0.2;
    const outer = 0.2 + STOP_AREA.depth;
    const q = [at(a, inner), at(a + 1, inner), at(a + 1, outer), at(a, outer)];
    if (!q.some((p) => onRouteRoad(route, p))) quads.push(q);
  }
  return quads;
}

/** A random place in the crowd: near the rear door, mostly close to the kerb. */
function crowdPlace(rng: () => number): { along: number; inM: number } {
  const along = CROWD_ALONG_M + gaussian(rng) * CROWD_SPREAD_M;
  const u = rng();
  return {
    along: Math.max(-CROWD_REACH_M, Math.min(CROWD_REACH_M, along)),
    // Most stand within a couple of metres of the kerb; a few hang back
    // (shade, a wall to lean on), some past the painted edge.
    inM: 0.3 + 6 * u * u,
  };
}

/**
 * Where person `seed` waits at a stop: a scattered spot in the crowd, kept
 * a step away from `others` already standing there. The same person always
 * gets the same spot for the same crowd (seeded), so replays are stable.
 */
export function waitingSpot(
  route: Route,
  stop: number,
  direction: 1 | -1,
  seed: number,
  others: readonly LocalPoint[],
): LocalPoint {
  const rng = createRng(seed * 7919 + stop * 104_729 + 17);
  let best: LocalPoint | null = null;
  let bestRoom = -1;
  for (let i = 0; i < SPOT_TRIES; i++) {
    const { along, inM } = crowdPlace(rng);
    const p = pavementPoint(route, stop, direction, along, inM);
    // Never in the road, where the route bends back past the stop.
    if (onRouteRoad(route, p)) continue;
    let room = Infinity;
    for (const o of others) room = Math.min(room, Math.hypot(o.x - p.x, o.z - p.z));
    if (room >= PERSONAL_SPACE_M) return p;
    // A packed stop: take the roomiest spot found.
    if (room > bestRoom) {
      bestRoom = room;
      best = p;
    }
  }
  // Nowhere else free: by the kerb where the rear door stops.
  return best ?? pavementPoint(route, stop, direction, CROWD_ALONG_M, 0.6);
}

/**
 * Where someone who got off walks to before they are gone: along the
 * pavement either way, or back from the road (a side street, a shop).
 */
export function leavingSpot(
  route: Route,
  stop: number,
  direction: 1 | -1,
  seed: number,
  /** Where along the road they got off (0 = at the stop; less if let off in a queue). */
  fromAlong = 0,
): LocalPoint {
  const rng = createRng(seed * 6007 + stop * 3_571 + 29);
  for (let i = 0; i < SPOT_TRIES; i++) {
    const side = rng() < 0.5 ? -1 : 1;
    const along = fromAlong + side * (6 + rng() * 8);
    const p = pavementPoint(route, stop, direction, along, 1 + rng() * 6);
    if (!onRouteRoad(route, p)) return p;
  }
  return pavementPoint(route, stop, direction, fromAlong + CROWD_ALONG_M, 3);
}

/** Walking along the pavement to a stop, a point this often (metres): it follows the road's bends. */
const PAVEMENT_STEP_M = 25;

/**
 * Someone coming out of a side street at `p`, on to the stop: the point
 * `inM` onto the stop's pavement level with `p` (from across the road, first
 * the far side's pavement there, then straight over), then along the
 * pavement towards the stop area. Null when `p` is more than `withinM` along
 * the road from the stop.
 */
export function pavementFrom(
  route: Route,
  stop: number,
  direction: 1 | -1,
  p: LocalPoint,
  withinM: number,
  inM = 2,
): { way: LocalPoint[]; across: boolean } | null {
  const along = alongFrom(route, stop, direction, p);
  if (Math.abs(along) > withinM) return null;
  const here = pavementPoint(route, stop, direction, along, inM);
  // The same place seen going the other way: the far side's pavement.
  const far = pavementPoint(route, stop, direction === 1 ? -1 : 1, -along, inM);
  const across = Math.hypot(p.x - far.x, p.z - far.z) < Math.hypot(p.x - here.x, p.z - here.z);
  const way = across ? [far, here] : [here];
  // Along the pavement to the stop area.
  const to = STOP_AREA.along;
  const steps = Math.floor(Math.abs(to - along) / PAVEMENT_STEP_M);
  for (let k = 1; k <= steps; k++)
    way.push(
      pavementPoint(
        route,
        stop,
        direction,
        along + Math.sign(to - along) * k * PAVEMENT_STEP_M,
        inM,
      ),
    );
  return { way, across };
}

/** How a route's stops meet the side streets (streetGraph.ts's StopSides). */
export function stopSides(route: Route): StopSides {
  return {
    spot: (stop, direction) => areaCentre(route, stop, direction),
    pavement: (stop, direction, p, withinM) => pavementFrom(route, stop, direction, p, withinM),
  };
}

/** How far along the road from `stop` point `p` is (negative: before it). */
export function alongFrom(route: Route, stop: number, direction: 1 | -1, p: LocalPoint): number {
  const d = route.polyline.project(p).s - route.stops[stop]!.s;
  if (!route.loop) return d * direction;
  const L = route.polyline.length;
  // The short way round the loop.
  return ((((d + L / 2) % L) + L) % L) - L / 2;
}

/**
 * Keep the stop area free of map building meshes. A loop stop is served in
 * one direction only, so it has one area, on its kerb.
 */
export function stopClearancePaths(route: Route): LocalPoint[][] {
  const directions = route.loop ? ([1] as const) : ([1, -1] as const);
  return route.stops.flatMap((_, stop) =>
    directions.map((direction) => [
      pavementPoint(route, stop, direction, -CROWD_REACH_M - 4, 3),
      pavementPoint(route, stop, direction, CROWD_REACH_M + 4, 3),
    ]),
  );
}
