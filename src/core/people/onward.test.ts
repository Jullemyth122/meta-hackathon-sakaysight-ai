import { describe, expect, it } from 'vitest';
import { Polyline } from '../geo/polyline';
import { kerbAt, syntheticDemoRoute, type Route } from '../geo/routes';
import { besideRoad, onwardLine } from './onward';

/**
 * A road with two carriageways: the way out along z = 0 (its right kerb towards
 * +z), the way back along z = −24, a median between them.
 */
const dual: Route = {
  ...syntheticDemoRoute(),
  loop: true,
  polyline: new Polyline([
    { x: 0, z: 0 },
    { x: 2000, z: 0 },
    { x: 2000, z: -24 },
    { x: 0, z: -24 },
    { x: 0, z: 0 },
  ]),
  stops: [
    { name: 'Start', s: 0, terminal: true },
    { name: 'Far', s: 2012, terminal: true },
  ],
};
const K = kerbAt(dual, 500);
/** The map's street down the near carriageway: following its edge is the bad way. */
const street = (to: { x: number; z: number }) => ({
  points: [{ x: 500, z: 0 }, { x: 600, z: 0 }, to],
  widths: [14, 0],
});
const inRoad = (z: number) => Math.abs(z) < K - 0.01 || Math.abs(z + 24) < K - 0.01;

describe('off a vehicle and on to where you are going', () => {
  it('stays on your own pavement when it is on your side', () => {
    const to = { x: 600, z: K + 6 };
    const line = onwardLine(dual, 500, street(to));
    expect(line.some(([, , z]) => inRoad(z))).toBe(false);
    expect(line.at(-1)).toEqual([to.x, 0, to.z]);
  });

  it('crosses straight over first when it is on the far side, then goes along that pavement', () => {
    const to = { x: 600, z: -24 - K - 6 };
    const line = onwardLine(dual, 500, street(to));
    // From the kerb where they got off, level with it, to the far kerb.
    expect(line[0]![0]).toBeCloseTo(500, 0);
    expect(line[0]![2]).toBeGreaterThan(K);
    expect(line[1]![0]).toBeCloseTo(500, 0);
    expect(line[1]![2]).toBeLessThan(-24 - K);
    // Then never on the road again, median or carriageway.
    for (const [, , z] of line.slice(1)) expect(z).toBeLessThan(-24 - K + 0.01);
    expect(line.at(-1)).toEqual([to.x, 0, to.z]);
  });

  it('goes back the way the road came, when that is where it is', () => {
    const to = { x: 400, z: K + 6 };
    const line = onwardLine(dual, 500, street(to));
    expect(line.some(([, , z]) => inRoad(z))).toBe(false);
    expect(Math.max(...line.map(([x]) => x))).toBeLessThan(501);
  });

  it('leaves the road by the streets, once past it', () => {
    const to = { x: 600, z: 300 };
    const line = onwardLine(dual, 500, {
      points: [
        { x: 500, z: 0 },
        { x: 600, z: 0 },
        { x: 600, z: 300 },
      ],
      widths: [14, 7],
    });
    expect(line.at(-1)).toEqual([to.x, 0, to.z]);
    expect(line.some(([, , z]) => inRoad(z))).toBe(false);
  });
});

describe('a spot on the road itself', () => {
  it('belongs to the kerb on its side, never the median', () => {
    expect(besideRoad(dual, { x: 500, z: 2 }).z).toBeGreaterThan(K);
    expect(besideRoad(dual, { x: 500, z: -26 }).z).toBeLessThan(-24 - K);
    // Left of the way out, in the middle of the road: the far pavement.
    expect(besideRoad(dual, { x: 500, z: -2 }).z).toBeLessThan(-24 - K);
  });

  it('leaves a spot off the road alone', () => {
    const off = { x: 500, z: 30 };
    expect(besideRoad(dual, off)).toBe(off);
  });
});
