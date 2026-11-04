/**
 * What the map is looking at right now, for the side panel: the place, how
 * many vehicles and riders are in view, and the busiest routes there. Filled
 * in by the network layer each time it looks over the view; read a few times
 * a second, so it is plain data, not store state.
 */

import type { FleetKind } from '@/core/vehicles/specs';

export interface RouteInView {
  /** Its index in the network. */
  route: number;
  name: string;
  vehicles: number;
}

export const viewArea = {
  place: null as string | null,
  vehicles: 0,
  /** Of those, how many are the simulated route's own. */
  ownVehicles: 0,
  riders: 0,
  /** Vehicles in view of each kind. */
  kinds: { jeepney: 0, modern: 0, bus: 0, uv: 0 } as Record<FleetKind, number>,
  routes: [] as RouteInView[],
  /** Named places on the map (suburbs, towns), for `place`. */
  labels: [] as ReadonlyArray<{ text: string; x: number; z: number }>,
};

/** The named place nearest (x, z), if one is near enough to mean anything. */
export function placeAt(x: number, z: number): string | null {
  let best: string | null = null;
  let nearest = PLACE_WITHIN_M;
  for (const l of viewArea.labels) {
    const d = Math.hypot(l.x - x, l.z - z);
    if (d < nearest) [best, nearest] = [l.text, d];
  }
  return best;
}

const PLACE_WITHIN_M = 6000;
