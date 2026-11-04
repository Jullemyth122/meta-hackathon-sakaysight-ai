import { yardAngle, yardShift, type FleetSim, type FuelStopAt } from '@/core/fleet/fleetSim';
import { driveLine, drivePose } from '@/core/geo/driveLine';
import { Polyline, type PointOnPolyline } from '@/core/geo/polyline';
import { KERB_LANE_M, kerbAt, laneRoomAt, lineUpAt, type Route } from '@/core/geo/routes';
import type { GroundPose } from '../jeepney/JeepneyInstances';

/** Distance between a jeepney's axles, metres: the span its heading follows. */
const WHEELBASE_M = 4.3;
/** At a stop the body (1 m half-width) pulls in to 25 cm from the kerb. */
const AT_KERB_M = 1.25;
/** Pulling in starts this far before a stop and ends as far after it. */
const PULL_IN_M = 30;
/** A vehicle leaving the road from an inner lane has eased over this far along (metres). */
const EASE_OFF_LANE_M = 24;

/** Each route's stops in order along it: asked for every vehicle, every frame. */
const stopsInOrder = new WeakMap<Route, Float64Array>();

/** Metres to the nearest stop, ahead or behind. */
function nearestStopM(route: Route, s: number): number {
  let at = stopsInOrder.get(route);
  if (!at) {
    at = Float64Array.from(route.stops, (st) => st.s).sort();
    stopsInOrder.set(route, at);
  }
  const n = at.length;
  if (n === 0) return Infinity;
  // The first stop at or after s; the nearest is it or the one before.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid]! < s) lo = mid + 1;
    else hi = mid;
  }
  const after = lo < n ? at[lo]! : route.loop ? at[0]! + route.polyline.length : Infinity;
  const before = lo > 0 ? at[lo - 1]! : route.loop ? at[n - 1]! - route.polyline.length : -Infinity;
  return Math.min(after - s, s - before);
}

/**
 * Lane centre, metres right of the route line at s: the kerb-side lane,
 * easing in to the kerb around every stop (jeepneys stop at the kerb, so
 * riders step straight off the pavement).
 */
export function laneOffset(route: Route, s: number): number {
  const kerb = kerbAt(route, s);
  const t = Math.max(0, 1 - nearestStopM(route, s) / PULL_IN_M);
  const pull = t * t * (3 - 2 * t);
  const cruise = Math.max(0, kerb - KERB_LANE_M);
  const atKerb = Math.max(0, kerb - AT_KERB_M);
  return cruise + (atKerb - cruise) * pull;
}

/** How far right of its drive line a vehicle at s goes, as it faces (core/geo/driveLine.ts). */
function offLine(route: Route, s: number): number {
  const lane = laneOffset(route, s);
  return route.loop ? lane - Math.max(0, kerbAt(route, s) - KERB_LANE_M) : lane;
}

/** The kerb-side lane all along a route: the very line its vehicles drive, for the map's route band. */
export function laneLine(route: Route): Polyline {
  // A route both ways along one line has no one lane: the band stays on the line.
  if (!route.loop) return route.polyline;
  const { x, z } = driveLine(route);
  const points = Array.from(x, (px, i) => ({ x: px, z: z[i]! }));
  points.push({ ...points[0]! });
  return new Polyline(points);
}

/** How far right of its drive line a vehicle `across` in from its kerb lane is at s, room allowing. */
const inLaneAt = (route: Route, s: number, across: number): number =>
  offLine(route, s) - Math.min(across, laneRoomAt(route, s)) * lineUpAt(route, s);

const axle: GroundPose = { x: 0, z: 0, heading: 0 };

/**
 * On the line, `across` metres in from the kerb lane, pointing from its back
 * axle to its front one, both on the way it is going: it can only ever go where
 * it is pointing, however its lane changes.
 */
function onAxles(
  route: Route,
  s: number,
  direction: 1 | -1,
  across: number,
  out: GroundPose,
): GroundPose {
  const half = (direction * WHEELBASE_M) / 2;
  drivePose(route, s + half, direction, inLaneAt(route, s + half, across), axle);
  const frontX = axle.x;
  const frontZ = axle.z;
  drivePose(route, s - half, direction, inLaneAt(route, s - half, across), axle);
  drivePose(route, s, direction, inLaneAt(route, s, across), out);
  const dx = frontX - axle.x;
  const dz = frontZ - axle.z;
  if (Math.hypot(dx, dz) > 0.5) out.heading = Math.atan2(-dz, dx);
  return out;
}

/** Where the kerb lane is at s, going `direction`: what a way off the road starts and ends on. */
export const kerbLanePose = (
  route: Route,
  s: number,
  direction: 1 | -1,
  out: GroundPose,
): GroundPose => onAxles(route, s, direction, 0, out);

/** A vehicle of another route, `across` metres in from its kerb lane at s. */
export const flowPose = (route: Route, s: number, across: number, out: GroundPose): GroundPose =>
  onAxles(route, s, 1, across, out);

/**
 * Pose of simulated jeepney i: on its route's drive line, heading along it and
 * turned by any drift across the road (pulling in to a stop). One function for
 * the renderer, the chase camera and the cabin camera, so they always agree.
 */
export function fleetPose(fleet: FleetSim, i: number, out: GroundPose): GroundPose {
  const v = fleet.vehicles[i]!;
  const route = fleet.route;
  // Parked for the night: off the road where it is kept.
  if (v.duty === 'parked') {
    const spot = fleet.parkedSpot(v);
    return drivePose(route, spot.s, v.direction, offLine(route, spot.s) + spot.shift, out);
  }
  // Off the road on a way of its own, easing over from the lane it left.
  const d = v.detour;
  if (d?.on) {
    const p = d.line.pointAt(d.atM);
    const heading = d.line.headingAt(d.atM, WHEELBASE_M);
    const t = Math.min(1, d.atM / EASE_OFF_LANE_M);
    const across = d.fromAcross * (1 - t * t * (3 - 2 * t));
    out.x = p.x - Math.sin(heading) * across;
    out.z = p.z - Math.cos(heading) * across;
    out.heading = heading;
    return out;
  }
  // In its own lane, plus any swing out round a vehicle stopped ahead (fleetSim.ts), but
  // never over onto the other side of the road.
  onAxles(route, v.s, v.direction, v.cruiseLaneM - v.laneShiftM, out);
  // Turning into a station's forecourt, or back out of it.
  const y = v.yard;
  if (y) {
    // Pointing along its way through (fleetSim.ts swerve): that way is its
    // whole turn, not a lane change on top of it (that turned a bus broadside).
    out.heading -= yardAngle(y.stop, y.bay, y.u, v.kind ?? 'jeepney');
    return out;
  }
  // Changing lanes: the nose points the way it is moving (fleetSim.ts turnNose).
  out.heading += Math.atan(v.noseAcross);
  return out;
}

/**
 * Pose of something standing `u` metres into `stop`'s forecourt, in its
 * lane of pumps `bay`, facing the way a jeepney drives through it (a car at
 * the pumps, say).
 */
export function yardPose(
  route: Route,
  stop: FuelStopAt,
  bay: number,
  u: number,
  out: GroundPose,
): GroundPose {
  const direction = stop.side === 'right' ? 1 : -1;
  const L = route.polyline.length;
  const raw = stop.inS + direction * u;
  const s = route.loop ? ((raw % L) + L) % L : Math.max(0, Math.min(L, raw));
  const p = route.polyline.pointAt(s);
  p.heading = route.polyline.headingAt(s, WHEELBASE_M);
  return lanePose(p, direction, laneOffset(route, s) + yardShift(stop, bay, u), out);
}

/**
 * Pose of a vehicle at along-route distance s, driving in `direction`, kept in
 * the right-hand lane (Philippine traffic drives on the right).
 */
export function lanePose(
  p: PointOnPolyline,
  direction: 1 | -1,
  laneOffsetM: number,
  out: GroundPose,
): GroundPose {
  const heading = direction === 1 ? p.heading : p.heading + Math.PI;
  // Right of the direction of travel, in the X–Z plane: (sin θ, cos θ).
  out.x = p.x + Math.sin(heading) * laneOffsetM;
  out.z = p.z + Math.cos(heading) * laneOffsetM;
  out.heading = heading;
  return out;
}
