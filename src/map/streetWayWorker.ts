/**
 * Finds a planned trip's ways by street (core/people/streetWay.ts) off the
 * page's thread: fetching and joining a few tiles of streets would stutter
 * the twin. One request at a time, in order, each answered by its id. Tiles
 * already read are kept, so a second pick nearby is immediate.
 */

import { createProjection, type LatLng, type LocalPoint } from '@/core/geo/projection';
import {
  eachLine,
  offRoads,
  riskAt,
  stationFit,
  streetLines,
  type RoadEdge,
  type RoadRisk,
  type StationFit,
  type StreetLines,
} from '@/core/map/streets';
import { tileKey, tilesAround, type TileId } from '@/core/map/tiles';
import { StreetGraph } from '@/core/people/streetGraph';
import {
  corridorTiles,
  drivingGraph,
  streetWay,
  type StreetWay,
  type WayMode,
} from '@/core/people/streetWay';
import { wayRound, type RoundAnswer, type RoundAsk } from '@/core/people/wayRound';
import { MAP_ZOOM, tileTemplate } from './tileSource';

export interface StreetWayRequest {
  id: number;
  origin: LatLng;
  from: LocalPoint;
  to: LocalPoint;
  mode: WayMode;
  /** A road to go round. */
  avoid?: LocalPoint[];
}

/** A way round traffic on the road ahead, for a vehicle. */
export interface RoundRequest {
  id: number;
  origin: LatLng;
  round: RoundAsk;
}

/** Whether a spot is somewhere to wait for a ride. */
export interface SpotRequest {
  id: number;
  origin: LatLng;
  spot: LocalPoint;
}

/** Where a pin dropped at a spot belongs: off the road, when it is on one. */
export interface BesideRequest {
  id: number;
  origin: LatLng;
  beside: LocalPoint;
}

/** Where gas stations fit, beside the road: `on`, one vehicles drive through, stays level with it. */
export interface FitsRequest {
  id: number;
  origin: LatLng;
  fits: Array<{ at: LocalPoint; on?: RoadEdge }>;
  length: number;
  depth: number;
}

export interface StreetWayReply {
  id: number;
  /** Null: no street joins them, or the tiles could not be had. */
  way: StreetWay | null;
  /** To a SpotRequest: why not to wait there; null when nothing is known against it. */
  risk?: RoadRisk | null;
  /** To a BesideRequest: where it belongs. */
  beside?: LocalPoint;
  /** To a FitsRequest: each one's place, null with no road near it. */
  fits?: Array<StationFit | null>;
  /** To a RoundRequest. */
  round?: RoundAnswer;
}

/** Tiles fetched at once. */
const PARALLEL = 4;
/** The last few graphs for driving, by their tiles: the road changes little from one ask to the next. */
const DRIVING_GRAPHS = 4;
/** Roads this far around a spot are looked at (metres). */
const SPOT_LOOK_M = 40;
/** And this far around a gas station. */
const FIT_LOOK_M = 110;

type WorkerRequest = StreetWayRequest | SpotRequest | BesideRequest | FitsRequest | RoundRequest;

/** The worker's global scope, typed by hand as in tileWorker.ts (no "webworker" lib beside "dom"). */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: StreetWayReply): void;
};

/** Read tiles by key; a tile with no data there is empty, not missing. */
const read = new Map<string, StreetLines | null>();
const drivingGraphs = new Map<string, StreetGraph>();

async function fetchTiles(tiles: readonly TileId[], origin: LatLng): Promise<void> {
  const template = await tileTemplate();
  const queue = tiles.filter((t) => !read.has(tileKey(t)));
  const fetchOne = async (): Promise<void> => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const url = template
        .replace('{z}', String(t.z))
        .replace('{x}', String(t.x))
        .replace('{y}', String(t.y));
      try {
        const res = await fetch(url);
        if (res.status === 204 || res.status === 404) read.set(tileKey(t), null);
        else if (res.ok) read.set(tileKey(t), streetLines(await res.arrayBuffer(), t, origin));
        // Anything else may pass: not kept, so the next way tries it again.
      } catch {
        // As above.
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, fetchOne));
}

async function riskOfSpot({ origin, spot }: SpotRequest): Promise<RoadRisk | null> {
  const tiles = tilesAround([spot], createProjection(origin), SPOT_LOOK_M, MAP_ZOOM);
  await fetchTiles(tiles, origin);
  return riskAt(
    tiles.flatMap((t) => read.get(tileKey(t)) ?? []),
    spot,
  );
}

async function besideRoads({ origin, beside }: BesideRequest): Promise<LocalPoint> {
  const tiles = tilesAround([beside], createProjection(origin), SPOT_LOOK_M, MAP_ZOOM);
  await fetchTiles(tiles, origin);
  return offRoads(
    tiles.flatMap((t) => read.get(tileKey(t)) ?? []),
    beside,
  );
}

async function fitsOf(request: FitsRequest): Promise<Array<StationFit | null>> {
  const { origin, fits, length, depth } = request;
  const projection = createProjection(origin);
  const each = fits.map(({ at }) => tilesAround([at], projection, FIT_LOOK_M, MAP_ZOOM));
  await fetchTiles(each.flat(), origin);
  return fits.map(({ at, on }, i) =>
    stationFit(
      each[i]!.flatMap((t) => read.get(tileKey(t)) ?? []),
      at,
      on,
      length,
      depth,
    ),
  );
}

async function find(request: StreetWayRequest): Promise<StreetWay | null> {
  const { origin, from, to, mode, avoid } = request;
  const tiles = corridorTiles(from, to, createProjection(origin), MAP_ZOOM);
  await fetchTiles(tiles, origin);
  const lines = tiles.flatMap((t) => {
    const part = read.get(tileKey(t));
    return part ? [...eachLine(part)] : [];
  });
  return lines.length > 0 ? streetWay(new StreetGraph(lines), from, to, mode, avoid) : null;
}

async function findRound({ origin, round }: RoundRequest): Promise<RoundAnswer> {
  const tiles = corridorTiles(
    round.road[0]!,
    round.road.at(-1)!,
    createProjection(origin),
    MAP_ZOOM,
  );
  await fetchTiles(tiles, origin);
  const lines = tiles.flatMap((t) => {
    const part = read.get(tileKey(t));
    return part ? [...eachLine(part)] : [];
  });
  const key = tiles.map(tileKey).join();
  const graph = drivingGraphs.get(key) ?? drivingGraph(lines);
  drivingGraphs.delete(key);
  drivingGraphs.set(key, graph);
  if (drivingGraphs.size > DRIVING_GRAPHS) drivingGraphs.delete(drivingGraphs.keys().next().value!);
  return wayRound(graph, lines, round);
}

let last: Promise<void> = Promise.resolve();

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const request = e.data;
  last = last.then(async () => {
    if ('round' in request) {
      const round = await findRound(request).catch(() => undefined);
      scope.postMessage({ id: request.id, way: null, round });
      return;
    }
    if ('fits' in request) {
      const fits = await fitsOf(request).catch(() => request.fits.map(() => null));
      scope.postMessage({ id: request.id, way: null, fits });
      return;
    }
    if ('beside' in request) {
      const beside = await besideRoads(request).catch(() => request.beside);
      scope.postMessage({ id: request.id, way: null, beside });
      return;
    }
    if ('spot' in request) {
      const risk = await riskOfSpot(request).catch(() => null);
      scope.postMessage({ id: request.id, way: null, risk });
      return;
    }
    const way = await find(request).catch(() => null);
    scope.postMessage({ id: request.id, way });
  });
};
