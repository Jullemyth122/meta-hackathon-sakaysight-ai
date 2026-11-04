/**
 * Everything that lies flat on the ground (land, water, roads, the route) is
 * drawn first, in a fixed order, without depth testing.
 *
 * Why: these surfaces are all at y = 0. Separating them by small heights
 * z-fights at a distance (a 6 km route needs a deep depth range). Painting
 * them in order instead is exact at any zoom and cheaper. Buildings, jeepneys
 * and people are drawn afterwards with normal depth testing, so they still
 * cover the ground correctly.
 */

import {
  BufferAttribute,
  BufferGeometry,
  MeshLambertMaterial,
  type Material,
  type Sphere,
} from 'three';
import type { MeshData } from '@/core/map/meshBuilder';

export const FLAT_ORDER = {
  ground: -100,
  areas: -90,
  water: -80,
  roadCasing: -70,
  roadFill: -60,
  laneLines: -59,
  /** Gas station forecourts: over the roads they open onto, under the route. */
  fuel: -58,
  routeRoad: -55,
  routeCasing: -50,
  routeFill: -45,
  /** Pedestrian crossings: painted over the road and the route's band. */
  zebra: -44,
  /** A planned trip end to end (TripPlanLayer.tsx): over the route it rides. */
  tripCasing: -42,
  tripFill: -40,
} as const;

/**
 * The map's layer. The main view draws it; a cabin camera, which only needs
 * the people in the cabin, does not (its first picture would otherwise build
 * every material of the city over again for its own render target).
 */
export const MAP_LAYER = 1;

/** Make a material paint in order instead of depth testing (see above). */
export function flat<M extends Material>(material: M): M {
  material.depthTest = false;
  material.depthWrite = false;
  return material;
}

/** Shared vertex-coloured material for one flat map layer. */
export const flatMapMaterial = () => flat(new MeshLambertMaterial({ vertexColors: true }));

/** `sphere`: around all of it, known already (going through every vertex takes a while). */
export function toGeometry(m: MeshData, sphere?: Sphere): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.position, 3));
  g.setAttribute('normal', new BufferAttribute(m.normal, 3));
  g.setAttribute('color', new BufferAttribute(m.color, 4, true));
  g.setIndex(new BufferAttribute(m.index, 1));
  if (sphere) g.boundingSphere = sphere;
  else g.computeBoundingSphere();
  return g;
}
