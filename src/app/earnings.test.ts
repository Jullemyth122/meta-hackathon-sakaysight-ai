import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENARIO } from '@/core/fleet/scenario';
import { defaultRoute } from '@/core/geo/routes';
import { fareFor } from '@/core/fare';
import { riderDiscounted } from '@/core/people/passengerSystem';
import { FUEL } from '@/core/vehicles/specs';
import { BOUNDARY_RANGE_PHP, clockText, dayMoney } from './earnings';
import { TwinRuntime } from './twinRuntime';

describe('a jeepney’s money today, live from the twin', () => {
  it(
    'collects one legal fare per rider who gets off, and counts its kilometres and idling',
    { timeout: 30_000 },
    () => {
      const route = defaultRoute();
      const twin = new TwinRuntime(route, undefined, DEFAULT_SCENARIO);
      for (let i = 0; i < 600 * 10; i++) twin.step(0.1, i * 100);
      const vs = twin.fleet.vehicles;
      const riders = vs.reduce((n, v) => n + v.day.riders, 0);
      const fares = vs.reduce((n, v) => n + v.day.fareCentavos, 0);
      expect(riders).toBeGreaterThan(0);
      // Every fare is between the discounted minimum and the full fare for the
      // longest ride on this loop.
      expect(fares / riders).toBeGreaterThanOrEqual(fareFor(0, true) * 100);
      expect(fares / riders).toBeLessThanOrEqual(fareFor(route.polyline.length / 1000) * 100);
      for (const v of vs) {
        // 10 minutes at up to ~36 km/h: driven, and stood at stops or in queues.
        expect(v.day.metres).toBeGreaterThan(0);
        expect(v.day.metres).toBeLessThan(6500);
        expect(v.day.idleS).toBeGreaterThanOrEqual(0);
        expect(v.day.idleS).toBeLessThanOrEqual(600 + 1e-6);
      }
    },
  );

  it('gives a third of riders the 20% discount, as the profit lab assumes', () => {
    let eligible = 0;
    for (let id = 0; id < 20_000; id++) if (riderDiscounted(id)) eligible++;
    // Students 20% + seniors 8% + PWD 5% = 33%.
    expect(eligible / 20_000).toBeGreaterThan(0.31);
    expect(eligible / 20_000).toBeLessThan(0.35);
  });

  it('works out each vehicle’s money the same way everywhere, by its kind: fares less diesel and the day’s costs', () => {
    const twin = new TwinRuntime(defaultRoute(), undefined, DEFAULT_SCENARIO);
    for (let i = 0; i < 600 * 5; i++) twin.step(0.1, i * 100);
    for (const v of twin.fleet.vehicles) {
      const m = dayMoney(v);
      expect(m.fares).toBeCloseTo(v.day.fareCentavos / 100, 9);
      expect(m.km).toBeCloseTo(v.day.metres / 1000, 9);
      // Its own kind's diesel: a jeepney 6 km a litre moving, 0.8 L an hour idling.
      const fuel = FUEL[v.kind ?? 'jeepney'];
      expect(m.litres).toBeCloseTo(m.km / fuel.kmPerL + (v.day.idleS / 3600) * fuel.idleLPerH, 9);
      // ₱700 boundary for a jeepney, each other kind within its range; or ₱200
      // upkeep for an owner-driver; ₱100 other costs.
      const kind = v.kind ?? 'jeepney';
      const boundary = kind === 'jeepney' ? 700 : m.boundary;
      if (kind !== 'jeepney' && !v.owner) {
        expect(boundary).toBeGreaterThanOrEqual(BOUNDARY_RANGE_PHP[kind][0]);
        expect(boundary).toBeLessThanOrEqual(BOUNDARY_RANGE_PHP[kind][1]);
      }
      expect(m.boundary).toBe(v.owner ? 0 : boundary);
      expect(m.fixed).toBe(v.owner ? 300 : boundary + 100);
      expect(m.net).toBeCloseTo(m.fares - m.diesel - m.fixed, 9);
    }
  });

  it('tells the time of day', () => {
    expect(clockText(7 * 3600 + 5 * 60 + 9)).toBe('07:05:09');
    expect(clockText(86_400 + 60)).toBe('00:01:00');
  });
});
