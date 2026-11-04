import { describe, expect, it } from 'vitest';
import { FleetSim, DEFAULT_FLEET } from './fleet/fleetSim';
import { Polyline } from './geo/polyline';
import { aheadOf, defaultRoute, isTerminal, kerbAt, stopsAhead, type Route } from './geo/routes';

/** A 400 m square loop with a terminal at each end and a stop on each leg. */
const square: Route = {
  id: 'loop-test',
  name: 'Square loop',
  source: 'synthetic',
  projection: null,
  stopsSource: 'placeholder',
  loop: true,
  polyline: new Polyline([
    { x: 0, z: 0 },
    { x: 100, z: 0 },
    { x: 100, z: 100 },
    { x: 0, z: 100 },
    { x: 0, z: 0 },
  ]),
  stops: [
    { name: 'Home', s: 0, terminal: true },
    { name: 'Out', s: 100 },
    { name: 'Far', s: 200, terminal: true },
    { name: 'Back', s: 300 },
  ],
};

describe('loop routes', () => {
  it('measures distance forward around the loop', () => {
    expect(aheadOf(square, 350, 50)).toBe(100);
    expect(aheadOf(square, 50, 350)).toBe(300);
  });

  it('lets riders travel up to the next terminal, wrapping past the end', () => {
    expect(stopsAhead(square, 0, 1)).toEqual([1, 2]);
    expect(stopsAhead(square, 2, 1)).toEqual([3, 0]);
    expect(isTerminal(square, 2)).toBe(true);
  });

  it('drives jeepneys forward round and round, never turning back', () => {
    const fleet = new FleetSim(square, { ...DEFAULT_FLEET, count: 3, demandPerStopPerMin: 0 });
    const dt = 1 / 20;
    let laps = 0;
    const prev = fleet.vehicles.map((v) => v.s);
    for (let step = 0; step < 20 * 600; step++) {
      fleet.step(dt);
      fleet.vehicles.forEach((v, i) => {
        expect(v.direction).toBe(1);
        // Moving backwards would show as a large forward jump (wrapping the wrong way).
        const moved = aheadOf(square, prev[i]!, v.s);
        expect(moved).toBeLessThan(20);
        if (v.s < prev[i]! - 200) laps++;
        prev[i] = v.s;
      });
    }
    expect(laps).toBeGreaterThan(3);
  });
});

/**
 * Largest change of direction anywhere on the route, degrees, measured over
 * `span` metres either side of each point: a U-turn shows as ~180.
 */
function sharpestTurn(route: Route, span = 12): number {
  const L = route.polyline.length;
  const at = (s: number) => route.polyline.pointAt(route.loop ? ((s % L) + L) % L : s);
  let worst = 0;
  const from = route.loop ? 0 : span;
  const to = route.loop ? L : L - span;
  for (let s = from; s < to; s += 2) {
    const a = at(s - span);
    const p = at(s);
    const b = at(s + span);
    const h1 = Math.atan2(p.z - a.z, p.x - a.x);
    const h2 = Math.atan2(b.z - p.z, b.x - p.x);
    let d = (Math.abs(h2 - h1) * 180) / Math.PI;
    if (d > 180) d = 360 - d;
    worst = Math.max(worst, d);
  }
  return worst;
}

describe('Tungko – SM City Fairview', () => {
  const route = defaultRoute();

  it('is a loop between the Tungko jeepney station and the SM City Fairview terminal', () => {
    expect(route.loop).toBe(true);
    const terminals = route.stops.filter((s) => s.terminal).map((s) => s.name);
    expect(terminals).toEqual([
      'Tungko - San Jose Jeepney Station',
      'SM City Fairview Jeepney Terminal',
    ]);
  });

  it('never U-turns on the road: it turns round only around the terminal blocks', () => {
    expect(sharpestTurn(route)).toBeLessThan(150);
  });

  it('has its stops in order: southbound through Malaria, the SM terminal, back north', () => {
    const sm = route.stops.findIndex((s) => s.name === 'SM City Fairview Jeepney Terminal');
    expect(
      route.stops.slice(1, sm).every((s) => s.towards === 'SM City Fairview Jeepney Terminal'),
    ).toBe(true);
    expect(
      route.stops.slice(sm + 1).every((s) => s.towards === 'Tungko - San Jose Jeepney Station'),
    ).toBe(true);
    // Malaria and Lagro are served both ways, once on each side of the road.
    expect(route.stops.filter((s) => s.name === 'Lagro')).toHaveLength(2);
    expect(route.stops.filter((s) => s.name === 'Malaria').length).toBeGreaterThanOrEqual(1);
  });

  it('knows where the kerb is: Quirino Highway is two 10.5 m one-way carriageways here', () => {
    const lagro = route.stops.find((s) => s.name === 'Lagro')!;
    expect(kerbAt(route, lagro.s)).toBeCloseTo(5.25, 1);
    // Never further out than the widest road the map draws.
    for (let s = 0; s < route.polyline.length; s += 50) {
      expect(kerbAt(route, s)).toBeGreaterThan(1);
      expect(kerbAt(route, s)).toBeLessThanOrEqual(14);
    }
  });
});
