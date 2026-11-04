import { describe, expect, it } from 'vitest';
import { Polyline } from '../geo/polyline';
import { syntheticDemoRoute, type Route, type Stop } from '../geo/routes';
import { roadsideBoardings } from './roadside';

/** Out along z = 0 and back along z = −40: right of the way out is +z. */
function loop(kind?: Route['kind']): Route {
  const polyline = new Polyline([
    { x: 0, z: 0 },
    { x: 2000, z: 0 },
    { x: 2000, z: -40 },
    { x: 0, z: -40 },
    { x: 0, z: 0 },
  ]);
  const stops = [0, 1000, 2020, 3000].map((s, i): Stop => ({
    name: `S${i}`,
    s,
    terminal: i === 0 || i === 2,
  }));
  return { ...syntheticDemoRoute(), polyline, loop: true, stops, kind };
}

describe('waiting by the road', () => {
  it('boards where you stand, going your way, on the kerb that way pulls in to', () => {
    const [here] = roadsideBoardings(loop(), { x: 500, z: 8 });
    expect(here!.stop).toBe(1);
    expect(here!.flag!.s).toBeCloseTo(500, 3);
    expect(here!.flag!.across).toBe(false);
    expect(here!.flag!.at.z).toBeGreaterThan(0);
    expect(here!.flag!.at.x).toBeCloseTo(500, 3);
  });

  it('says so when that way runs along the far side of the road', () => {
    const [here] = roadsideBoardings(loop(), { x: 500, z: -8 });
    expect(here!.flag!.across).toBe(true);
    expect(here!.flag!.at.z).toBeGreaterThan(0);
  });

  it('is the stop itself when the spot is at a stop', () => {
    expect(roadsideBoardings(loop(), { x: 985, z: 8 })[0]).toEqual({ stop: 1, flag: null });
    expect(roadsideBoardings(loop(), { x: 1015, z: 8 })[0]).toEqual({ stop: 1, flag: null });
  });

  it('is nowhere well off the road, or just short of a terminal, or for a UV Express', () => {
    expect(roadsideBoardings(loop(), { x: 500, z: 200 })).toEqual([]);
    expect(roadsideBoardings(loop(), { x: 1900, z: 8 })).toEqual([]);
    expect(roadsideBoardings(loop('uv'), { x: 500, z: 8 })).toEqual([]);
  });
});
