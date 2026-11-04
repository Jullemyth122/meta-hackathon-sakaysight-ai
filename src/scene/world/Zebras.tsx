/**
 * The white stripes of the pedestrian crossings at the stops (core/people/zebra.ts),
 * where people walking to or from a stop cross the road.
 */

import { useEffect, useMemo } from 'react';
import { BufferAttribute, BufferGeometry, MeshBasicMaterial } from 'three';
import type { LocalPoint } from '@/core/geo/projection';
import { stripesOf } from '@/core/people/zebra';
import type { CrewState } from '../jeepney/crewState';
import { flat, FLAT_ORDER } from '../map/flatLayers';

const PAINT = '#f4f4f0';

function stripesGeometry(quads: readonly LocalPoint[][]): BufferGeometry {
  const position: number[] = [];
  // Wound to face up, whichever way the quad goes round.
  const triangle = (a: LocalPoint, b: LocalPoint, c: LocalPoint) => {
    const up = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z) > 0;
    for (const p of up ? [a, b, c] : [a, c, b]) position.push(p.x, 0, p.z);
  };
  for (const [a, b, c, d] of quads) {
    triangle(a!, b!, c!);
    triangle(a!, c!, d!);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  g.computeBoundingSphere();
  return g;
}

export function Zebras({ crew }: { crew: CrewState }) {
  const geometry = useMemo(
    () => stripesGeometry(crew.zebras.flatMap((z) => stripesOf(z, crew.road))),
    [crew],
  );
  const material = useMemo(() => flat(new MeshBasicMaterial({ color: PAINT })), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  return <mesh geometry={geometry} material={material} renderOrder={FLAT_ORDER.zebra} />;
}
