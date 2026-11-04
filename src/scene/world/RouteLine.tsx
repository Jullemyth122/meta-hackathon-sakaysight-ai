/**
 * The jeepney route, highlighted on top of the map: a white casing with a
 * blue band. Without a map (synthetic route) it also draws the road itself.
 *
 * The band stays at its physical width at every zoom, so it never expands
 * through roadside buildings. The geometry stores each vertex's centre-line
 * position plus a unit sideways offset; each material sets its width in metres.
 */

import { useEffect, useMemo } from 'react';
import { BufferAttribute, BufferGeometry } from 'three';
import { attribute, positionLocal, uniform, vec3 } from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import type { Polyline } from '@/core/geo/polyline';
import { ROUTE_ROAD_WIDTH_M } from '@/core/map/style';
import { flat, FLAT_ORDER } from '../map/flatLayers';

const ROUTE_COLOR = '#24407a';
/** True-scale widths, metres: a guide along the kerb lane, not a lane of its own. */
const CASING_WIDTH_M = 1.5;
const BAND_WIDTH_M = 0.9;

/**
 * Centre-line strip with an `offset` attribute: the unit vector from the
 * centre to each edge (half of it, so width × offset reaches the edge). Ends
 * are pushed out by half the width, as for map roads, so the band has square
 * caps instead of stopping short at the terminals.
 */
export function widthlessRibbon(line: Polyline): BufferGeometry {
  const pts = line.points;
  const n = pts.length;
  const position = new Float32Array(n * 6);
  const offset = new Float32Array(n * 4);
  const index: number[] = [];

  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)]!;
    const next = pts[Math.min(n - 1, i + 1)]!;
    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const cap = i === 0 ? -0.5 : i === n - 1 ? 0.5 : 0;
    const p = pts[i]!;
    position.set([p.x, 0, p.z, p.x, 0, p.z], i * 6);
    // Left edge (dz, -dx) and right edge (-dz, dx), plus the end cap.
    offset.set(
      [dz * 0.5 + dx * cap, -dx * 0.5 + dz * cap, -dz * 0.5 + dx * cap, dx * 0.5 + dz * cap],
      i * 4,
    );
    if (i < n - 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); // counter-clockwise from above
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('offset', new BufferAttribute(offset, 2));
  g.setIndex(index);
  // Include the fixed road edges and square end caps in the culling bounds.
  g.computeBoundingSphere();
  g.boundingSphere!.radius += ROUTE_ROAD_WIDTH_M;
  return g;
}

/** An unlit flat material whose width (metres) is set through `width.value`. */
export function bandMaterial(color: string, metres: number) {
  const width = uniform(metres);
  const side = attribute<'vec2'>('offset', 'vec2');
  const material = flat(new MeshBasicNodeMaterial({ color }));
  material.positionNode = positionLocal.add(vec3(side.x, 0, side.y).mul(width));
  return { material, width };
}

export function RouteLine({ line, withRoad }: { line: Polyline; withRoad: boolean }) {
  const geometry = useMemo(() => widthlessRibbon(line), [line]);
  const bands = useMemo(
    () => ({
      road: bandMaterial('#b9b6ae', ROUTE_ROAD_WIDTH_M),
      casing: bandMaterial('#ffffff', CASING_WIDTH_M),
      fill: bandMaterial(ROUTE_COLOR, BAND_WIDTH_M),
    }),
    [],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => Object.values(bands).forEach((b) => b.material.dispose()), [bands]);

  return (
    <group>
      {withRoad && (
        <mesh
          geometry={geometry}
          material={bands.road.material}
          renderOrder={FLAT_ORDER.routeRoad}
        />
      )}
      <mesh
        geometry={geometry}
        material={bands.casing.material}
        renderOrder={FLAT_ORDER.routeCasing}
      />
      <mesh geometry={geometry} material={bands.fill.material} renderOrder={FLAT_ORDER.routeFill} />
    </group>
  );
}
