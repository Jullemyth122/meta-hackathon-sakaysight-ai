/**
 * Off a vehicle and on to where you are going. Whatever side of the road you
 * got off, the way on goes by that road's real kerbs, as you would walk it:
 * along your own pavement if where you are going is on your side; else straight
 * over first, then along the far pavement. Never down the middle of a road: the
 * map's streets run down its carriageways, so their edges can be its median.
 * Past the point the way leaves this road, it goes by the streets.
 */

import { kerbAt, type Route } from '../geo/routes';
import type { LocalPoint } from '../geo/projection';
import { rounded, wayLine, type Point3 } from './streetGraph';
import { roadsidePoint } from './stopLayout';

/** A point of the way this far from the route's line is still on this road (metres)… */
const ON_ROAD_M = 40;
/** …and the route's other way along it is within this (metres). */
const OTHER_WAY_M = 70;
/** Along a kerb, a point this often (metres): it follows the road's bends. */
const KERB_STEP_M = 8;
/** On the pavement, this far in from the kerb (metres). */
const IN_FROM_KERB_M = 1;
/** Headings this far apart (cosine, negative) are the two ways of a road. */
const OPPOSED_COS = -0.5;
/** Where the road is looked at around where they got off (metres either way). */
const LOOK_M = 1500;

/** The nearest place the route runs the other way along the road at `p`, heading against `s`. */
function otherWay(route: Route, s: number, p: LocalPoint): number | null {
  const { points, cumulative } = route.polyline;
  const here = route.polyline.pointAt(s);
  const hx = Math.cos(here.heading);
  const hz = -Math.sin(here.heading);
  let best: number | null = null;
  let least = OTHER_WAY_M;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const ex = points[i + 1]!.x - a.x;
    const ez = points[i + 1]!.z - a.z;
    const len = Math.hypot(ex, ez);
    if (len === 0 || (ex * hx + ez * hz) / len > OPPOSED_COS) continue;
    const along = Math.max(0, Math.min(len, ((p.x - a.x) * ex + (p.z - a.z) * ez) / len));
    const d = Math.hypot(a.x + (ex * along) / len - p.x, a.z + (ez * along) / len - p.z);
    if (d < least) [least, best] = [d, cumulative[i]! + along];
  }
  return best;
}

/** Whether `p` is right of the route's way along it at `s`. */
function onRight(route: Route, s: number, p: LocalPoint): boolean {
  const c = route.polyline.pointAt(s);
  return (p.x - c.x) * Math.sin(c.heading) + (p.z - c.z) * Math.cos(c.heading) >= 0;
}

/** Along the kerb the route's way pulls in to, from `from` to `to` metres along it, either way. */
function alongKerb(route: Route, from: number, to: number): Point3[] {
  const out: Point3[] = [];
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / KERB_STEP_M));
  for (let k = 0; k <= steps; k++) {
    const p = roadsidePoint(route, from + ((to - from) * k) / steps, 1, IN_FROM_KERB_M);
    out.push([p.x, 0, p.z]);
  }
  return out;
}

const around = (route: Route, s: number): [number, number] => [
  Math.max(0, s - LOOK_M),
  Math.min(route.polyline.length, s + LOOK_M),
];

/**
 * `p`, or where to stand for it when it is on the road itself: every kerb is
 * the one on the right of some way along the road, so a spot left of the way
 * nearest it (the middle of the road) belongs to the other way's kerb.
 */
export function besideRoad(route: Route, p: LocalPoint): LocalPoint {
  const { s, offset } = route.polyline.project(p);
  if (offset >= kerbAt(route, s)) return p;
  if (onRight(route, s, p)) return roadsidePoint(route, s, 1, IN_FROM_KERB_M);
  const other = otherWay(route, s, p);
  if (other !== null) return roadsidePoint(route, other, 1, IN_FROM_KERB_M);
  return roadsidePoint(route, s, -1, IN_FROM_KERB_M);
}

/**
 * From the kerb at `s` along the route, where someone got off going forward,
 * by `way` to `goal`. Starts on that kerb and stays off the road but for going
 * straight over it (crossing.ts sees to the traffic).
 */
export function onwardLine(
  route: Route,
  s: number,
  way: { points: readonly LocalPoint[]; widths: readonly number[] },
  goal: LocalPoint = way.points[way.points.length - 1]!,
): Point3[] {
  const window = around(route, s);
  const onRoad = (p: LocalPoint) => route.polyline.project(p, window).offset <= ON_ROAD_M;
  // How much of the way is along this road; the rest goes by the streets.
  let last = way.points.length - 1;
  const all = onRoad(goal);
  if (!all) while (last > 0 && !onRoad(way.points[last]!)) last--;
  const leave = all ? goal : way.points[last]!;
  const offKerb = ([x, , z]: Point3) => {
    const at = route.polyline.project({ x, z }, window);
    return at.offset > kerbAt(route, at.s);
  };
  // From the kerb there, not the middle of the road it turns off.
  const street = all ? [] : wayLine(way.points.slice(last), way.widths.slice(last), 'walk', goal);
  const rest = street.slice(Math.max(0, street.findIndex(offKerb)));
  const start = roadsidePoint(route, s, 1, 0.6);
  const kerb: Point3 = [start.x, 0, start.z];
  const level = route.polyline.project(leave, window).s;
  const finish = (line: Point3[]): Point3[] => {
    const end: Point3 = [goal.x, 0, goal.z];
    return [kerb, ...rounded(all ? [...line, end] : [...line, ...rest])];
  };
  if (onRight(route, level, leave)) return finish(alongKerb(route, s, level));
  // Over first, from where they got off, then along the far pavement.
  const over = otherWay(route, s, route.polyline.pointAt(s));
  if (over !== null) {
    const there = route.polyline.project(leave, around(route, over)).s;
    return finish(alongKerb(route, over, there));
  }
  // One way along the road, nothing the other way: its far kerb all the same.
  const near = route.polyline;
  const far: Point3[] = alongKerb(route, s, level).map(([x, , z], i, line) => {
    const u = i / Math.max(1, line.length - 1);
    const at = near.pointAt(s + (level - s) * u);
    return [2 * at.x - x, 0, 2 * at.z - z];
  });
  return finish(far);
}
