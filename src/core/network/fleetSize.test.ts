import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultRoute } from '../geo/routes';
import { fleetKinds } from '../vehicles/specs';
import { cityPull, fleetPlan, METRO_FLEET } from './fleetSize';
import { buildNetwork, type NetworkFile } from './network';

describe('each route’s fleet', () => {
  const file = JSON.parse(
    readFileSync('public/data/metro-manila-network.json', 'utf8'),
  ) as NetworkFile;
  const first = defaultRoute();
  const projection = first.projection!;
  const network = buildNetwork(file, projection, first);
  const routes = network.routes.map((r) => ({ route: r.route, roads: r.meta.roads }));
  const plans = fleetPlan(routes, projection);
  const total = plans.reduce((n, p) => n + p.fleet, 0);

  it('adds up to Metro Manila’s real fleet', () => {
    const real = METRO_FLEET.jeepney + METRO_FLEET.uv + METRO_FLEET.bus;
    expect(Math.abs(total - real) / real).toBeLessThan(0.03);
  });

  it('no two parts of the city alike: routes differ', () => {
    expect(new Set(plans.map((p) => p.fleet)).size).toBeGreaterThan(100);
    const sizes = plans.map((p) => p.fleet).sort((a, b) => a - b);
    expect(sizes[sizes.length - 1]! / sizes[Math.floor(sizes.length / 2)]!).toBeGreaterThan(2);
  });

  it('Makati pulls far less public transport than Manila, for its size', () => {
    const makati = cityPull({ lat: 14.5547, lng: 121.0244 });
    const manila = cityPull({ lat: 14.5995, lng: 120.9842 });
    expect(makati).toBeLessThan(manila * 0.5);
  });

  it('routes on the big roads have far more vehicles and buses', () => {
    const on = (id: string) => plans[network.routes.findIndex((r) => r.route.id === id)]!;
    const main = on('corr-sjdm-philcoa');
    const mean = total / plans.length;
    expect(main.fleet).toBeGreaterThan(mean);
    // Most buses have lines of their own: only a few run among the jeepneys.
    const busy = plans.filter((p) => p.mix.bus > 0.005).length;
    expect(busy).toBeGreaterThan(20);
    expect(busy).toBeLessThan(plans.length);
  });

  it('keeps jeepneys off expressways, and every stop off them but a bus line’s terminal', () => {
    for (const { meta } of network.routes) {
      const roads = meta.roads ?? [];
      const stretches = roads.flatMap(([s, cls], i) =>
        cls === 'motorway' ? [[s, roads[i + 1]?.[0] ?? meta.length] as const] : [],
      );
      const onIt = (m: number) => stretches.some(([a, b]) => m >= a && m <= b);
      if (meta.kind !== 'bus')
        expect(
          stretches.reduce((m, [a, b]) => m + b - a, 0),
          meta.id,
        ).toBeLessThanOrEqual(300);
      else
        meta.stops.forEach(([name, m], i) => {
          if (!meta.terminals.includes(i)) expect(onIt(m), `${meta.id} ${name}`).toBe(false);
        });
    }
  });

  it('a whole fleet’s mix matches the real numbers of buses and vans', () => {
    let buses = 0;
    let vans = 0;
    plans.forEach((p, i) => {
      const kinds = fleetKinds(p.fleet, network.routes[i]!.route.kind, p.mix);
      buses += kinds.filter((k) => k === 'bus').length;
      vans += kinds.filter((k) => k === 'uv').length;
    });
    expect(buses / METRO_FLEET.bus).toBeGreaterThan(0.75);
    expect(buses / METRO_FLEET.bus).toBeLessThan(1.3);
    expect(vans / METRO_FLEET.uv).toBeGreaterThan(0.75);
    expect(vans / METRO_FLEET.uv).toBeLessThan(1.3);
  });
});
