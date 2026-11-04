import { describe, expect, it } from 'vitest';
import { createProjection } from '../geo/projection';
import { StreetGraph, type GraphLine } from './streetGraph';
import { corridorTiles, streetWay } from './streetWay';

/** A street as points: `[[x, z], …]`. */
const street = (...pts: Array<[number, number]>): GraphLine => pts.map(([x, z]) => ({ x, z }));

const length = (points: ReadonlyArray<{ x: number; z: number }>) =>
  points.slice(1).reduce((m, p, i) => m + Math.hypot(p.x - points[i]!.x, p.z - points[i]!.z), 0);

describe('streetWay', () => {
  it('goes round by the streets, not straight across the block', () => {
    // An L of streets: the straight line from one end to the other is on neither.
    const g = new StreetGraph([street([0, 0], [500, 0], [500, 500])]);
    const way = streetWay(g, { x: 0, z: 0 }, { x: 500, z: 500 })!;
    expect(way.metres).toBeCloseTo(1000, 0);
    expect(way.points).toContainEqual({ x: 500, z: 0 });
  });

  it('starts and ends at the spots themselves, joined to the nearest street', () => {
    const g = new StreetGraph([street([0, 0], [1000, 0])]);
    const from = { x: 200, z: 30 };
    const to = { x: 700, z: -20 };
    const way = streetWay(g, from, to)!;
    expect(way.points[0]).toEqual(from);
    expect(way.points.at(-1)).toEqual(to);
    expect(way.points[1]).toEqual({ x: 200, z: 0 });
    expect(way.points.at(-2)).toEqual({ x: 700, z: 0 });
    expect(way.metres).toBeCloseTo(30 + 500 + 20, 5);
  });

  it('picks the shorter way round a loop of streets', () => {
    const g = new StreetGraph([
      street([0, 0], [100, 0], [100, 100], [0, 100], [0, 0]),
      street([100, 100], [900, 100]),
    ]);
    const way = streetWay(g, { x: 0, z: 0 }, { x: 900, z: 100 })!;
    expect(way.metres).toBeCloseTo(1000, 0);
  });

  it('ignores a loose bit of street beside the spot when the way lies elsewhere', () => {
    const g = new StreetGraph([
      // A car park's aisle, nearest the start, joined to nothing.
      street([0, 5], [40, 5]),
      street([0, 60], [2000, 60]),
    ]);
    const way = streetWay(g, { x: 10, z: 0 }, { x: 1500, z: 60 })!;
    expect(way.points[1]).toEqual({ x: 10, z: 60 });
  });

  it('has no way when a spot is far from every street, or nothing joins them', () => {
    const g = new StreetGraph([street([0, 0], [100, 0]), street([5000, 0], [5100, 0])]);
    expect(streetWay(g, { x: 0, z: 2000 }, { x: 50, z: 0 })).toBeNull();
    expect(streetWay(g, { x: 0, z: 0 }, { x: 5050, z: 0 })).toBeNull();
  });

  it('repeats no point, so the line drawn along it has no empty step', () => {
    const g = new StreetGraph([street([0, 0], [100, 0], [100, 100])]);
    const { points } = streetWay(g, { x: 0, z: 0 }, { x: 100, z: 100 })!;
    for (let i = 1; i < points.length; i++)
      expect(length([points[i - 1]!, points[i]!])).toBeGreaterThan(0.4);
  });
});

describe('choosing the street', () => {
  /** The near carriageway a side road meets, and the far one, joined only 2 km along. */
  const divided = (): GraphLine[] => [
    street([0, 0], [1000, 0]), // the side road, ending at the near carriageway
    street([1000, -1000], [1000, 1000]), // near carriageway
    street([1012, -1000], [1012, 1000]), // far carriageway
    street([1000, 1000], [1012, 1000]),
  ];

  it('does not go all the way round for the far carriageway of a divided road', () => {
    const g = new StreetGraph(divided());
    // A spot just past the near carriageway: nearest the far one.
    const way = streetWay(g, { x: 0, z: 0 }, { x: 1009, z: 0 })!;
    expect(way.metres).toBeLessThan(1100);
  });

  it('goes round to the road it can reach, never straight across another road', () => {
    // A spot beside a highway; a side lane right across it, joined to it 300 m on.
    const g = new StreetGraph([
      street([0, 0], [1000, 0]), // the highway
      street([0, 40], [1000, 40]), // a lane across it
      street([300, 0], [300, 40]), // where they meet
    ]);
    const way = streetWay(g, { x: 500, z: -6 }, { x: 800, z: 40 })!;
    for (let i = 1; i < way.points.length; i++) {
      const a = way.points[i - 1]!;
      const b = way.points[i]!;
      const crosses = (a.z < 0 && b.z > 0) || (a.z > 0 && b.z < 0);
      if (crosses) expect(`${a.x},${a.z} to ${b.x},${b.z}`).toBe('no line across the highway');
    }
    expect(way.points).toContainEqual({ x: 300, z: 40 });
  });

  const national = (pts: Array<[number, number]>) =>
    Object.assign(street(...pts), { national: true, width: 14 });
  const sideRoads = () => [
    national([
      [0, 0],
      [1000, 0],
    ]),
    Object.assign(street([0, 0], [0, 300], [1000, 300], [1000, 0]), { width: 6 }),
  ];

  it('takes a tricycle by the side streets, off the national road', () => {
    const way = streetWay(
      new StreetGraph(sideRoads()),
      { x: 0, z: 0 },
      { x: 1000, z: 0 },
      'tricycle',
    )!;
    expect(way.metres).toBeCloseTo(1600, 0);
    expect(way.points).toContainEqual({ x: 0, z: 300 });
  });

  it('lets someone on foot walk along the roadside of the same road', () => {
    const way = streetWay(new StreetGraph(sideRoads()), { x: 0, z: 0 }, { x: 1000, z: 0 }, 'walk')!;
    expect(way.metres).toBeCloseTo(1000, 0);
  });

  it('still takes a tricycle along it when nothing else goes there', () => {
    const g = new StreetGraph([
      national([
        [0, 0],
        [1000, 0],
      ]),
    ]);
    expect(streetWay(g, { x: 0, z: 0 }, { x: 1000, z: 0 }, 'tricycle')!.metres).toBeCloseTo(
      1000,
      0,
    );
  });

  it('gives each stretch its street’s width, for riders to keep to the side', () => {
    const g = new StreetGraph(sideRoads());
    const way = streetWay(g, { x: 0, z: 0 }, { x: 1000, z: 0 }, 'tricycle')!;
    expect(way.widths).toHaveLength(way.points.length - 1);
    expect(way.widths).toContain(6);
  });
});

describe('corridorTiles', () => {
  it('covers the way from end to end, each tile once', () => {
    const projection = createProjection({ lat: 14.65, lng: 121.05 });
    const tiles = corridorTiles({ x: 0, z: 0 }, { x: 12_000, z: -9_000 }, projection, 14);
    const keys = tiles.map((t) => `${t.x}/${t.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    // 15 km across z14 tiles of about 2.4 km.
    expect(tiles.length).toBeGreaterThan(6);
    expect(tiles.length).toBeLessThan(60);
  });
});
