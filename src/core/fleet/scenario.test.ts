import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCENARIO, expectedArrivals, normalizeScenario } from './scenario';
import { TwinRuntime } from '@/app/twinRuntime';
import { syntheticDemoRoute } from '../geo/routes';
import { DEFAULT_FLEET, FleetSim } from './fleetSim';

describe('single-route demand scenarios', () => {
  it.each(['flat', 'commute'] as const)(
    'integrates to the requested daily demand (%s)',
    (profile) => {
      const scenario = { ...DEFAULT_SCENARIO, dailyTrips: 12000, profile, startHour: 17 };
      expect(expectedArrivals(scenario, 0, 86400)).toBeCloseTo(12000, 7);
      const hourly = Array.from({ length: 24 }, (_, hour) =>
        expectedArrivals(scenario, hour * 3600, 3600),
      );
      expect(hourly.reduce((a, b) => a + b, 0)).toBeCloseTo(12000, 7);
      expect(expectedArrivals(scenario, 3590, 20)).toBeCloseTo(
        expectedArrivals(scenario, 3590, 10) + expectedArrivals(scenario, 3600, 10),
        7,
      );
    },
  );

  it('has stronger rush-hour arrivals while allowing a zero-demand scenario', () => {
    const s = { ...DEFAULT_SCENARIO, startHour: 0 };
    expect(expectedArrivals(s, 7 * 3600, 3600)).toBeGreaterThan(
      expectedArrivals(s, 12 * 3600, 3600),
    );
    expect(expectedArrivals({ ...s, dailyTrips: 0 }, 0, 86400)).toBe(0);
    expect(
      normalizeScenario({ ...s, vehicles: Infinity, dailyTrips: -4, startHour: 25 }),
    ).toMatchObject({ vehicles: DEFAULT_SCENARIO.vehicles, dailyTrips: 0, startHour: 23 });
  });

  it('keeps the same simulation result across display frame rates and acceleration', () => {
    const scenario = { ...DEFAULT_SCENARIO, dailyTrips: 8000, vehicles: 30 };
    // A frame's real-time budget guards the app's frame rate. On a slow machine
    // it would cut frames short, which is not what is compared here.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const run = (frames: number, dt: number, speed: number) => {
      const twin = new TwinRuntime(syntheticDemoRoute(), undefined, scenario);
      for (let i = 0; i < frames; i++) twin.advance(dt, i * dt * 1000, speed);
      return {
        positions: twin.fleet.vehicles.map((v) => v.s),
        waiting: twin.fleet.waiting,
        arrivals: twin.fleet.generatedDemand,
        elapsed: twin.fleet.elapsedS,
      };
    };
    const baseline = run(600, 1 / 60, 1);
    expect(run(300, 1 / 30, 1)).toEqual(baseline);
    expect(run(60, 1 / 60, 10)).toEqual(baseline);
    clock.mockRestore();
  });

  it(
    'retains a large queue and conserves every passenger under a larger fleet',
    { timeout: 60_000 },
    () => {
      const twin = new TwinRuntime(syntheticDemoRoute(), undefined, {
        ...DEFAULT_SCENARIO,
        vehicles: 120,
        dailyTrips: 16000,
      });
      const initial = twin.crew.passengers.size;
      twin.crew.demand(1, 1000, true);
      expect(twin.fleet.waiting[1]).toBeGreaterThanOrEqual(1000);
      for (let i = 0; i < 1200; i++) twin.step(0.1, i * 100);
      expect(twin.fleet.vehicles).toHaveLength(120);
      expect(twin.crew.passengers.size + twin.crew.delivered).toBe(
        initial + 1000 + twin.fleet.generatedDemand,
      );
      const people = [...twin.crew.passengers.values()];
      expect(twin.fleet.waiting.reduce((a, b) => a + b, 0)).toBe(
        people.filter((r) => r.phase === 'waiting' || r.phase === 'approaching').length,
      );
      for (const v of twin.fleet.vehicles) {
        expect(v.occupancy).toBe(people.filter((r) => r.vehicleId === v.id && r.inside).length);
        expect(v.occupancy).toBeLessThanOrEqual(v.capacity);
      }
      expect(twin.crew.metrics.completed).toBeGreaterThanOrEqual(twin.crew.delivered);
    },
  );

  it('pauses simulated time without changing any passenger state', () => {
    const twin = new TwinRuntime(syntheticDemoRoute(), undefined, DEFAULT_SCENARIO);
    const state = JSON.stringify([...twin.crew.passengers.values()]);
    twin.advance(10, 10000, 0);
    expect(twin.fleet.elapsedS).toBe(0);
    expect(JSON.stringify([...twin.crew.passengers.values()])).toBe(state);
  });

  it('uses the same passenger arrivals when comparing different fleet sizes', () => {
    const arrivalsFor = (count: number) => {
      const fleet = new FleetSim(syntheticDemoRoute(), {
        ...DEFAULT_FLEET,
        count,
        scenario: { ...DEFAULT_SCENARIO, vehicles: count, dailyTrips: 16000 },
      });
      const arrivals: number[][] = [];
      fleet.passengerService = {
        demand: (stop, n) => arrivals.push([stop, n]),
        arrive: () => {},
        pickUp: () => {},
        busy: () => false,
        wantsStop: () => true,
        dropsAt: () => false,
      };
      for (let i = 0; i < 600; i++) fleet.step(0.1);
      expect(fleet.generatedDemand).toBeGreaterThan(0);
      return arrivals;
    };
    expect(arrivalsFor(120)).toEqual(arrivalsFor(10));
  });
});
