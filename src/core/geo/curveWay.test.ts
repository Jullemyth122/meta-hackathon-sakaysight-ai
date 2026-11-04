import { describe, expect, it } from 'vitest';
import { curveWay } from './curveWay';

const biggestTurn = (line: ReadonlyArray<{ x: number; z: number }>) => {
  let most = 0;
  for (let i = 1; i + 1 < line.length; i++) {
    const a = Math.atan2(line[i]!.z - line[i - 1]!.z, line[i]!.x - line[i - 1]!.x);
    const b = Math.atan2(line[i + 1]!.z - line[i]!.z, line[i + 1]!.x - line[i]!.x);
    const turn = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
    most = Math.max(most, turn);
  }
  return (most * 180) / Math.PI;
};

describe('a way as a vehicle drives it', () => {
  const corner = [
    { x: 0, z: 0 },
    { x: 100, z: 0 },
    { x: 100, z: 100 },
  ];

  it('turns a square corner into a curve, its ends where they were', () => {
    const way = curveWay(corner, 14);
    expect(biggestTurn(corner)).toBeCloseTo(90);
    expect(biggestTurn(way)).toBeLessThan(12);
    expect(way[0]).toEqual(corner[0]);
    expect(way.at(-1)).toEqual(corner[2]);
  });

  it('takes out the little jogs of the map', () => {
    const jog = [
      { x: 0, z: 0 },
      { x: 50, z: 0 },
      { x: 51, z: 1.5 },
      { x: 52, z: 0 },
      { x: 100, z: 0 },
    ];
    expect(curveWay(jog, 14)).toHaveLength(2);
  });

  it('fits the curve to a short stretch', () => {
    const short = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 10 },
      { x: 20, z: 10 },
    ];
    expect(biggestTurn(curveWay(short, 14))).toBeLessThan(15);
  });
});
