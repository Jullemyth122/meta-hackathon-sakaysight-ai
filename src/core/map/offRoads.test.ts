import { describe, expect, it } from 'vitest';
import { offRoads, type StreetLines } from './streets';

/** Roads, each two points and a width. */
function roads(...lines: Array<[[number, number], [number, number], number]>): StreetLines {
  return {
    points: new Float32Array(lines.flatMap(([a, b]) => [...a, ...b])),
    starts: new Uint32Array(lines.map((_, i) => i * 2).concat(lines.length * 2)),
    widths: new Float32Array(lines.map(([, , w]) => w)),
    national: new Uint8Array(lines.length),
    risky: new Uint8Array(lines.length),
    hazards: { points: new Float32Array(), starts: new Uint32Array([0]), kinds: new Uint8Array() },
  };
}

describe('a pin dropped on the map', () => {
  const road = roads([[0, 0], [1000, 0], 14]);

  it('moves to the side of a road it lands on, the side it is nearest', () => {
    expect(offRoads([road], { x: 500, z: 3 })).toEqual({ x: 500, z: 8 });
    expect(offRoads([road], { x: 500, z: -3 })).toEqual({ x: 500, z: -8 });
  });

  it('is left alone off the road', () => {
    const off = { x: 500, z: 9 };
    expect(offRoads([road], off)).toBe(off);
  });

  it('stays on a footpath: someone can stand there', () => {
    const path = { x: 500, z: 0.5 };
    expect(offRoads([roads([[0, 0], [1000, 0], 3])], path)).toBe(path);
  });

  it('dead in the middle, it still goes to one side', () => {
    expect(Math.abs(offRoads([road], { x: 500, z: 0 }).z)).toBeCloseTo(8);
  });

  it('comes out of a junction clear of both roads', () => {
    const junction = roads([[0, 0], [1000, 0], 14], [[500, 0], [500, 1000], 14]);
    const { x, z } = offRoads([junction], { x: 503, z: 4 });
    expect(Math.abs(z) >= 7 || Math.abs(x - 500) >= 7).toBe(true);
    expect(z >= 7 && Math.abs(x - 500) >= 7).toBe(true);
  });
});
