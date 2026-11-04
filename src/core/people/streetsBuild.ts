/**
 * Building a route's street catchments (streetGraph.ts) away from the page:
 * for a long route that is a few hundred thousand street points and seconds
 * of work, which would freeze the twin. The streets worker
 * (src/map/streetsWorker.ts) fetches the tiles and builds; the page gets the
 * result as flat arrays and puts it back together (fromStreetsState).
 *
 * A route crosses to the worker as plain data (StreetsRoute): its line,
 * stops and kerbs are all the catchments need.
 */

import { Polyline } from '../geo/polyline';
import type { LocalPoint } from '../geo/projection';
import type { Route, Stop } from '../geo/routes';
import { eachLine, type StreetLines } from '../map/streets';
import { stopSides } from './stopLayout';
import { Catchments, StreetGraph, type CatchmentsState, type GraphState } from './streetGraph';

/** What of a route the catchments need, as plain data. */
export interface StreetsRoute {
  id: string;
  name: string;
  loop: boolean;
  points: LocalPoint[];
  stops: Stop[];
  kerbs?: { s: number[]; m: number[]; room: number[] };
}

/** A route's catchments as plain data (graph and working-out). */
export interface StreetsState {
  graph: GraphState;
  catchments: CatchmentsState;
}

export function streetsRoute(route: Route): StreetsRoute {
  return {
    id: route.id,
    name: route.name,
    loop: route.loop,
    points: [...route.polyline.points],
    stops: route.stops,
    ...(route.kerbs && { kerbs: route.kerbs }),
  };
}

/** The route again, from its plain data (no projection: the catchments do not need one). */
function routeOf(r: StreetsRoute): Route {
  return {
    id: r.id,
    name: r.name,
    source: 'osm',
    polyline: new Polyline(r.points),
    loop: r.loop,
    stops: r.stops,
    stopsSource: 'osm',
    projection: null,
    ...(r.kerbs && { kerbs: r.kerbs }),
  };
}

/** Build `route`'s catchments from its tiles' street lines (in the worker). */
export function buildStreets(route: StreetsRoute, parts: readonly StreetLines[]): Catchments {
  const r = routeOf(route);
  return new Catchments(new StreetGraph(parts.flatMap((p) => [...eachLine(p)])), r, stopSides(r));
}

/** The state to send, and the buffers that can move rather than be copied. */
export function streetsState(c: Catchments): { state: StreetsState; transfer: ArrayBuffer[] } {
  const graph = c.graph.toState();
  const catchments = c.toState();
  const transfer = [
    graph.x.buffer,
    graph.z.buffer,
    graph.starts.buffer,
    graph.edges.buffer,
    ...[graph.cells, graph.segments].flatMap((c) => [
      c.keys.buffer,
      c.starts.buffer,
      c.items.buffer,
    ]),
    ...catchments.passes.flatMap(([, p]) => [p.dist.buffer, p.label.buffer, p.prev.buffer]),
  ] as ArrayBuffer[];
  return { state: { graph, catchments }, transfer };
}

/** `route`'s catchments again, on the page, from what the worker sent. */
export function fromStreetsState(route: Route, state: StreetsState): Catchments {
  return new Catchments(
    new StreetGraph([], state.graph),
    route,
    stopSides(route),
    state.catchments,
  );
}
