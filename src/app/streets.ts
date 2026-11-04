/**
 * The side streets around the focused route's stops, loaded from the map's
 * vector tiles and handed to the twin's riders: where people come from and
 * go to (core/people/streetGraph.ts). A worker fetches the tiles and builds
 * them (map/streetsWorker.ts), so a long route's few hundred thousand
 * street points never freeze the twin; the page only puts the result back
 * together.
 *
 * Loaded once per route and kept, so going back to a route is instant.
 * Until they are in (or if the tiles cannot be had: offline), riders come
 * along the route's pavement as before.
 */

import { tilesAround, tileKey, type TileId } from '@/core/map/tiles';
import { ENTRY_M, MAX_REACH_M, type Catchments } from '@/core/people/streetGraph';
import { fromStreetsState, streetsRoute } from '@/core/people/streetsBuild';
import { MAP_ZOOM } from '@/map/tileSource';
import type { StreetsReply, StreetsRequest } from '@/map/streetsWorker';
import type { TwinRuntime } from './twinRuntime';

const loaded = new Map<string, Catchments>();

/** The side streets of `route`, if loaded already (loadStreets keeps them). */
export function knownStreets(routeId: string): Catchments | null {
  return loaded.get(routeId) ?? null;
}

/** Load the streets around `twin`'s stops and give them to its riders. Returns a cancel. */
export function loadStreets(twin: TwinRuntime): () => void {
  const { route } = twin;
  const known = loaded.get(route.id);
  if (known) {
    twin.crew.setStreets(known);
    return () => {};
  }
  const projection = route.projection;
  if (!projection) return () => {};
  // Every tile within a catchment of some stop, once.
  const tiles = new Map<string, TileId>();
  for (const stop of route.stops)
    for (const t of tilesAround(
      [route.polyline.pointAt(stop.s)],
      projection,
      ENTRY_M + MAX_REACH_M,
      MAP_ZOOM,
    ))
      tiles.set(tileKey(t), t);
  let cancelled = false;
  const worker = new Worker(new URL('../map/streetsWorker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (e: MessageEvent<StreetsReply>) => {
    worker.terminate();
    if (cancelled) return;
    const reply = e.data;
    if (!reply.ok) {
      console.warn('Streets not loaded; riders come along the route.', reply.error);
      return;
    }
    const catchments = fromStreetsState(route, reply.state);
    loaded.set(route.id, catchments);
    twin.crew.setStreets(catchments);
    console.info(
      `Streets for ${route.name}: ${reply.points} street points from ${reply.tiles} tiles` +
        (reply.failed ? ` (${reply.failed} failed)` : ''),
    );
  };
  worker.onerror = (e) => {
    e.preventDefault();
    worker.terminate();
    if (!cancelled) console.warn('Streets not loaded; riders come along the route.', e.message);
  };
  worker.postMessage({
    route: streetsRoute(route),
    tiles: [...tiles.values()],
    origin: projection.origin,
  } satisfies StreetsRequest);
  return () => {
    cancelled = true;
    worker.terminate();
  };
}
