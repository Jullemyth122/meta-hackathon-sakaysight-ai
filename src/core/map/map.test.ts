import { describe, expect, it } from 'vitest';
import { createProjection, haversineM } from '../geo/projection';
import { MeshBuilder, type MeshData } from './meshBuilder';
import { laneLines, roadWidth, ROADS } from './style';
import { lngLatToTile, tilesAround, tilesInBounds, tileToLngLat, tileToLocal } from './tiles';

const FAIRVIEW = { lat: 14.7335, lng: 121.0584 };

/** Geometric normal of triangle t (counter-clockwise front face). */
function faceNormal(m: MeshData, t: number): [number, number, number] {
  const v = (k: number) => {
    const i = m.index[t * 3 + k]! * 3;
    return [m.position[i]!, m.position[i + 1]!, m.position[i + 2]!] as const;
  };
  const [a, b, c] = [v(0), v(1), v(2)];
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [
    e1[1]! * e2[2]! - e1[2]! * e2[1]!,
    e1[2]! * e2[0]! - e1[0]! * e2[2]!,
    e1[0]! * e2[1]! - e1[1]! * e2[0]!,
  ];
}

const triangles = (m: MeshData) => Array.from({ length: m.index.length / 3 }, (_, t) => t);

describe('tiles', () => {
  it('round-trips geographic <-> tile coordinates', () => {
    const t = lngLatToTile(FAIRVIEW, 14);
    const back = tileToLngLat(t.x, t.y, 14);
    expect(haversineM(FAIRVIEW, back)).toBeLessThan(0.01);
  });

  it('lists every tile touching a box', () => {
    const tiles = tilesInBounds({ lat: 14.73, lng: 121.05 }, { lat: 14.77, lng: 121.08 }, 14);
    expect(tiles.length).toBeGreaterThanOrEqual(4);
    expect(new Set(tiles.map((t) => `${t.x}/${t.y}`)).size).toBe(tiles.length);
  });

  it('orders tiles nearest to the first point first', () => {
    const proj = createProjection(FAIRVIEW);
    const pts = [
      { x: 0, z: 0 },
      { x: 3000, z: -4000 },
    ];
    const [first] = tilesAround(pts, proj, 300, 14);
    const start = lngLatToTile(FAIRVIEW, 14);
    expect(first).toMatchObject({ x: Math.floor(start.x), y: Math.floor(start.y) });
  });

  it('maps tile corners onto the projection within centimetres', () => {
    const proj = createProjection(FAIRVIEW);
    const t = lngLatToTile(FAIRVIEW, 14);
    const tile = { z: 14, x: Math.floor(t.x), y: Math.floor(t.y) };
    const toLocal = tileToLocal(tile, 4096, proj);
    // Middle of the tile: the linear interpolation's worst case.
    const mid = toLocal(2048, 2048);
    const exact = proj.toLocal(tileToLngLat(tile.x + 0.5, tile.y + 0.5, 14));
    expect(Math.hypot(mid.x - exact.x, mid.z - exact.z)).toBeLessThan(0.1);
  });
});

describe('mesh builder', () => {
  it('builds ribbons that face up', () => {
    const b = new MeshBuilder();
    b.ribbon(
      [
        { x: 0, z: 0 },
        { x: 10, z: 0 },
        { x: 20, z: 10 },
      ],
      4,
      0,
      [255, 255, 255],
    );
    const m = b.build()!;
    for (const t of triangles(m)) expect(faceNormal(m, t)[1]).toBeGreaterThan(0);
  });

  it('extends ribbon ends by half the width', () => {
    const b = new MeshBuilder();
    b.ribbon(
      [
        { x: 0, z: 0 },
        { x: 10, z: 0 },
      ],
      4,
      0,
      [0, 0, 0],
    );
    const xs = Array.from(b.build()!.position).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(-2);
    expect(Math.max(...xs)).toBeCloseTo(12);
  });

  it('triangulates polygons with holes, facing up, whatever the winding', () => {
    const square = (s: number) => [
      { x: -s, z: -s },
      { x: s, z: -s },
      { x: s, z: s },
      { x: -s, z: s },
    ];
    for (const outer of [square(10), square(10).reverse()]) {
      const b = new MeshBuilder();
      b.polygon([outer, square(4)], 0, [0, 0, 0]);
      const m = b.build()!;
      for (const t of triangles(m)) expect(faceNormal(m, t)[1]).toBeGreaterThan(0);
      const area = triangles(m).reduce((sum, t) => sum + faceNormal(m, t)[1] / 2, 0);
      expect(area).toBeCloseTo(20 * 20 - 8 * 8);
    }
  });

  it('extrudes walls that face outward and away from courtyards', () => {
    const square = (s: number) => [
      { x: -s, z: -s },
      { x: s, z: -s },
      { x: s, z: s },
      { x: -s, z: s },
    ];
    for (const outer of [square(10), square(10).reverse()]) {
      const b = new MeshBuilder();
      b.extrusion([outer, square(4).reverse()], 0, 6, [0, 0, 0], [0, 0, 0]);
      const m = b.build()!;
      for (const t of triangles(m)) {
        const [nx, ny, nz] = faceNormal(m, t);
        if (Math.abs(ny) > 1e-9) {
          expect(ny).toBeGreaterThan(0); // roof
          continue;
        }
        // Wall: a point on it, and whether it belongs to the outer or inner ring.
        const i = m.index[t * 3]! * 3;
        const px = m.position[i]!;
        const pz = m.position[i + 2]!;
        const onOuter = Math.max(Math.abs(px), Math.abs(pz)) > 7;
        const outward = nx * px + nz * pz > 0;
        expect(outward).toBe(onOuter);
        // The stored vertex normal agrees with the triangle's winding.
        const len = Math.hypot(nx, nz);
        expect(m.normal[i]! * (nx / len) + m.normal[i + 2]! * (nz / len)).toBeCloseTo(1);
      }
    }
  });
});

describe('road widths', () => {
  it('draws one carriageway of a divided highway narrower than a two-way road', () => {
    const primary = ROADS.primary!;
    expect(roadWidth(primary, true)).toBeLessThan(roadWidth(primary, false));
    // Minor roads have no carriageway width: one-way or not, same street.
    // A small one-way street is narrower than the same street both ways.
    expect(roadWidth(ROADS.tertiary!, true)).toBeLessThan(roadWidth(ROADS.tertiary!, false));
    expect(roadWidth(ROADS.minor!, true)).toBeLessThan(roadWidth(ROADS.minor!, false));
  });

  it('ranks road classes from widest to narrowest', () => {
    const order = [
      'trunk',
      'motorway',
      'primary',
      'secondary',
      'tertiary',
      'minor',
      'service',
      'path',
    ];
    const widths = order.map((c) => ROADS[c]!.width);
    expect([...widths].sort((a, b) => b - a)).toEqual(widths);
  });

  it('paints what a road is: two ways down the middle, one way without', () => {
    expect(laneLines('tertiary', false)).toEqual([{ offset: 0, solid: true }]);
    expect(laneLines('tertiary', true)).toEqual([]);
    expect(laneLines('minor', false)).toEqual([]);
    // Most roads: four columns, two each way.
    expect(laneLines('secondary', false)).toHaveLength(3);
    // Divided: three lanes a side, two lines between them, none down the middle.
    const divided = laneLines('primary', true);
    expect(divided).toHaveLength(2);
    expect(divided.every((l) => !l.solid)).toBe(true);
  });
});
