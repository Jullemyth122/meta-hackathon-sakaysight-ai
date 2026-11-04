import { describe, expect, it } from 'vitest';
import { drivingGraph } from '../people/streetWay';
import { wayRound, type RoundAsk } from '../people/wayRound';
import { againstOneWay, type StreetLine } from './streets';

const line = (points: Array<[number, number]>, extra: Partial<StreetLine> = {}): StreetLine =>
  Object.assign(
    points.map(([x, z]) => ({ x, z })),
    { width: 6 },
    extra,
  );

describe('one-way streets', () => {
  const eastOnly = line(
    [
      [0, 0],
      [100, 0],
    ],
    { oneway: 1 },
  );

  it('finds a step against one, not along one, nor on a two-way street', () => {
    const west = [
      { x: 80, z: 0 },
      { x: 20, z: 0 },
    ];
    expect(againstOneWay(west, [eastOnly])).toEqual(west);
    expect(againstOneWay([...west].reverse(), [eastOnly])).toEqual([]);
    const twoWay = line([
      [0, 0],
      [100, 0],
    ]);
    expect(againstOneWay(west, [twoWay])).toEqual([]);
  });

  it('reads -1 as running against the order of the points', () => {
    const backwards = line(
      [
        [0, 0],
        [100, 0],
      ],
      { oneway: -1 },
    );
    const east = [
      { x: 20, z: 0 },
      { x: 80, z: 0 },
    ];
    expect(againstOneWay(east, [backwards])).toEqual(east);
  });
});

/**
 * The road runs east along z = 0, so the driver's right is +z. Junctions at
 * 200 m and 800 m lead to a street alongside it, 60 m off.
 */
describe('a way round traffic', () => {
  const road = line([
    [-100, 0],
    [200, 0],
    [800, 0],
    [1500, 0],
  ]);
  const alongside = [
    line([
      [200, 0],
      [200, 60],
    ]),
    line([
      [200, 60],
      [800, 60],
    ]),
    line([
      [800, 60],
      [800, 0],
    ]),
  ];
  const ask = (extra: Partial<RoundAsk> = {}): RoundAsk => ({
    road: Array.from({ length: 141 }, (_, i) => ({ x: i * 10, z: 0 })),
    stepM: 10,
    jam: { fromM: 250, toM: 750, mps: 1 },
    paceMps: 6,
    stopAtM: Infinity,
    ...extra,
  });
  const find = (lines: StreetLine[], a = ask()) => wayRound(drivingGraph(lines), lines, a);

  it('takes the street alongside, leaving and rejoining ahead', () => {
    const { round } = find([road, ...alongside]);
    expect(round).toMatchObject({ leaveM: 200, rejoinM: 800, metres: 720 });
    expect(round!.minutes).toBeLessThan(round!.roadMinutes);
    expect(round!.points[0]).toEqual({ x: 0, z: 0 });
    expect(round!.points.at(-1)).toEqual({ x: 800, z: 0 });
  });

  it('never goes back: a junction behind the vehicle is no use', () => {
    const past = ask({
      road: ask().road.slice(30),
      jam: { fromM: 0, toM: 450, mps: 1 },
    });
    expect(find([road, ...alongside], past).round).toBeNull();
  });

  it('never against a one-way street', () => {
    const lines = [
      road,
      alongside[0]!,
      line(
        [
          [800, 60],
          [200, 60],
        ],
        { oneway: 1 },
      ),
      alongside[2]!,
    ];
    expect(find(lines).round).toBeNull();
  });

  it('never over the road: the junctions must be on the side of the driver', () => {
    const flipped = alongside.map((l) => line(l.map((p) => [p.x, -p.z])));
    expect(find([road, ...flipped]).round).toBeNull();
  });

  it('not on a footpath', () => {
    const path = line(
      [
        [200, 60],
        [800, 60],
      ],
      { drivable: false },
    );
    expect(find([road, alongside[0]!, path, alongside[2]!]).round).toBeNull();
  });

  it('not a long way round, however bad the traffic', () => {
    const far = [
      line([
        [200, 0],
        [200, 400],
      ]),
      line([
        [200, 400],
        [800, 400],
      ]),
      line([
        [800, 400],
        [800, 0],
      ]),
    ];
    expect(find([road, ...far]).round).toBeNull();
  });

  it('comes back before the stop riders are getting off at, or stays on the road', () => {
    const answer = find([road, ...alongside], ask({ stopAtM: 600 }));
    expect(answer.round).toBeNull();
    expect(answer.skipsTheirStop).toBe(true);
  });

  it('is not worth it when the road is clear', () => {
    const clear = ask({ jam: { fromM: 0, toM: 0, mps: 1 } });
    expect(find([road, ...alongside], clear).round).toBeNull();
  });
});
