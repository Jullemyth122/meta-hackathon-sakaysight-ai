import { describe, expect, it } from 'vitest';
import { fuelPlan, type FuelPlanInput } from './plan';

/** A 50 L tank (5 L reserve), 0.2 L a km: 225 km on a full tank. */
const base: Omit<FuelPlanInput, 'tankL' | 'kmToGo' | 'stations'> = {
  tankCapacityL: 50,
  litresPerKm: 0.2,
};
const station = (name: string, km: number, pesoPerL: number | null) => ({
  name,
  metresAhead: km * 1000,
  pesoPerL,
});

describe('where to buy diesel', () => {
  it('no stop when the tank covers the way', () => {
    // 25 L: 100 km down to the reserve, for 60 km.
    const plan = fuelPlan({ ...base, tankL: 25, kmToGo: 60, stations: [station('A', 5, 60)] });
    expect(plan.enough).toBe(true);
    expect(plan.reachKm).toBe(100);
    expect(plan.stops).toEqual([]);
  });

  it('only enough at the dear one to reach the cheaper one, the rest there', () => {
    // 7 L: 10 km of reach. A (dear) at 5 km, B (cheaper) at 30 km, 120 km to go.
    const plan = fuelPlan({
      ...base,
      tankL: 7,
      kmToGo: 120,
      stations: [station('A', 5, 62), station('B', 30, 58)],
    });
    expect(plan.enough).toBe(false);
    // At A, 6 L left: buy to reach B (25 km = 5 L) plus the reserve, 10 L: 4 L.
    expect(plan.stops[0]).toMatchObject({ name: 'A', litres: 4, php: 248 });
    // At B, 5 L left: the remaining 90 km (18 L) plus the reserve: 18 L.
    expect(plan.stops[1]).toMatchObject({ name: 'B', litres: 18, php: 1044 });
    expect(plan.totalLitres).toBe(22);
    // All 22 L at A would be ₱1,364: ₱72 saved.
    expect(plan.atNearestPhp).toBe(1364);
    expect(plan.savingPhp).toBe(72);
  });

  it('passes the dear one when the cheaper one is in reach already', () => {
    const plan = fuelPlan({
      ...base,
      tankL: 20, // 75 km of reach
      kmToGo: 150,
      stations: [station('A', 5, 62), station('B', 40, 58)],
    });
    expect(plan.stops.map((s) => s.name)).toEqual(['B']);
  });

  it('fills up where nothing cheaper is in reach and the end is not', () => {
    const plan = fuelPlan({
      ...base,
      tankL: 10,
      kmToGo: 400,
      stations: [station('A', 10, 58), station('B', 100, 61), station('C', 220, 61)],
    });
    expect(plan.stops[0]).toMatchObject({ name: 'A', litres: 42 });
  });

  it('says how far short when no station is in reach', () => {
    const plan = fuelPlan({ ...base, tankL: 6, kmToGo: 50, stations: [station('A', 30, 60)] });
    expect(plan.stops).toEqual([]);
    expect(plan.shortKm).toBe(25);
  });

  it('plans on known prices only', () => {
    const plan = fuelPlan({
      ...base,
      tankL: 7,
      kmToGo: 60,
      stations: [station('Unknown', 2, null), station('A', 8, 60)],
    });
    expect(plan.stops.map((s) => s.name)).toEqual(['A']);
  });
});
