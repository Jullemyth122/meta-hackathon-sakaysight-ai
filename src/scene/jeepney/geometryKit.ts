/**
 * Small geometry helpers for building vehicles out of primitives, then
 * merging everything that shares a material into one BufferGeometry.
 *
 * Why merge: a jeepney is ~120 primitives. Merged per material it becomes
 * ~12 draw calls, and with instancing the whole fleet stays ~12 draw calls.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Shape,
  type MeshStandardMaterial,
} from 'three';

export type Axis = 'x' | 'y' | 'z';

/** Axis-aligned box between two corners (order of each pair does not matter). */
export function box(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): BufferGeometry {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const [az, bz] = [Math.min(z0, z1), Math.max(z0, z1)];
  const g = new BoxGeometry(bx - ax, by - ay, bz - az);
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

/** Box with bevelled edges of radius r. Falls back to a plain box when r is tiny. */
export function roundedBox(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  radius: number,
): BufferGeometry {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const [az, bz] = [Math.min(z0, z1), Math.max(z0, z1)];
  const w = bx - ax;
  const h = by - ay;
  const d = bz - az;
  const r = Math.min(radius, w / 2 - 0.002, h / 2 - 0.002, d / 2 - 0.002);
  if (r <= 0.004) return box(x0, x1, y0, y1, z0, z1);

  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const shape = new Shape();
  shape.moveTo(-hw, -hh);
  shape.lineTo(hw, -hh);
  shape.lineTo(hw, hh);
  shape.lineTo(-hw, hh);

  const g = new ExtrudeGeometry(shape, {
    depth: d - 2 * r,
    bevelEnabled: true,
    bevelThickness: r,
    bevelSize: r,
    bevelSegments: 2,
    curveSegments: 1,
    steps: 1,
  });
  g.translate((ax + bx) / 2, (ay + by) / 2, az + r);
  return g;
}

/** Cylinder whose length runs along `axis`, centred at (x, y, z). */
export function cylinder(
  radiusTop: number,
  radiusBottom: number,
  length: number,
  segments: number,
  axis: Axis,
  x: number,
  y: number,
  z: number,
): BufferGeometry {
  const g = new CylinderGeometry(radiusTop, radiusBottom, length, segments);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/**
 * An arch (e.g. a fender) approximated by `segments` small boxes on a circle
 * of radius r centred at (cx, cy), spanning angles a0..a1, extruded along z.
 */
export function arch(
  out: BufferGeometry[],
  cx: number,
  cy: number,
  r: number,
  thickness: number,
  z0: number,
  z1: number,
  a0: number,
  a1: number,
  segments: number,
): void {
  for (let k = 0; k < segments; k++) {
    const a = a0 + ((k + 0.5) * (a1 - a0)) / segments;
    const len = ((r * (a1 - a0)) / segments) * 1.1 + 0.01;
    const g = new BoxGeometry(len, thickness, Math.abs(z1 - z0));
    g.rotateZ(a + Math.PI / 2);
    g.translate(cx + r * Math.cos(a), cy + r * Math.sin(a), (z0 + z1) / 2);
    out.push(g);
  }
}

/**
 * Merge geometries into one non-indexed geometry with position + normal only.
 * Disposes the inputs. Returns null for an empty list.
 */
export function mergeParts(parts: BufferGeometry[]): BufferGeometry | null {
  if (parts.length === 0) return null;

  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const vertexCount = flat.reduce((n, g) => n + g.attributes.position!.count, 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);

  let offset = 0;
  flat.forEach((g, i) => {
    positions.set(g.attributes.position!.array as Float32Array, offset);
    normals.set(g.attributes.normal!.array as Float32Array, offset);
    offset += g.attributes.position!.array.length;
    if (g !== parts[i]) g.dispose();
    parts[i]!.dispose();
  });

  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(positions, 3));
  merged.setAttribute('normal', new BufferAttribute(normals, 3));
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Merge parts that differ only in colour into one geometry with those colours
 * baked in, so they cost one draw call together. Every extra mesh is drawn,
 * and prepared by the renderer, again in each pass (screen, shadow, cabin
 * camera), which is what limits the frame rate here, not the triangles.
 */
export function bakeColours(
  parts: ReadonlyArray<readonly [BufferGeometry, Color]>,
): BufferGeometry {
  const vertices = parts.reduce((n, [g]) => n + g.attributes.position!.count, 0);
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const colour = new Float32Array(vertices * 3);
  let at = 0;
  for (const [g, c] of parts) {
    const count = g.attributes.position!.count;
    position.set(g.attributes.position!.array as Float32Array, at * 3);
    normal.set(g.attributes.normal!.array as Float32Array, at * 3);
    for (let n = 0; n < count; n++, at++) c.toArray(colour, at * 3);
  }
  const baked = new BufferGeometry();
  baked.setAttribute('position', new BufferAttribute(position, 3));
  baked.setAttribute('normal', new BufferAttribute(normal, 3));
  baked.setAttribute('color', new BufferAttribute(colour, 3));
  baked.computeBoundingSphere();
  return baked;
}

/** What a material looks like baked into vertex colours: its colour plus its glow. */
export function bakedColour(m: MeshStandardMaterial): Color {
  return m.color.clone().add(m.emissive.clone().multiplyScalar(m.emissiveIntensity));
}
