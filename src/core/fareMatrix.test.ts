import { describe, expect, it } from 'vitest';
import {
  fareFor,
  FARE_BY_VEHICLE,
  PH_CITY_BUS_AIRCON,
  PH_TRADITIONAL_JEEPNEY,
  PH_UV_EXPRESS,
  resetFareRules,
  setFareRule,
  type FareRule,
} from './fare';
import { fareOnMatrix, parseRows, ruleFromMatrix } from './fareMatrix';

/** A matrix as posted: one row a km, regular and discounted. */
const matrix = (rule: FareRule, km = 16) =>
  Array.from({ length: km }, (_, i) => [
    i + 1,
    fareFor(i + 1, false, rule),
    fareFor(i + 1, true, rule),
  ]);

describe('a fare matrix read off a photo', () => {
  it('gives back the rule it was printed from, for each kind of vehicle', () => {
    for (const rule of [PH_TRADITIONAL_JEEPNEY, PH_CITY_BUS_AIRCON, PH_UV_EXPRESS]) {
      const read = ruleFromMatrix(parseRows(JSON.stringify(matrix(rule))));
      expect(read.rule).not.toBeNull();
      for (const km of [1, 3.2, 4, 7.6, 12, 16])
        for (const discounted of [false, true])
          expect(fareFor(km, discounted, read.rule!)).toBeCloseTo(fareFor(km, discounted, rule), 2);
    }
  });

  it('reads a new fare: ₱15 for 4 km, then ₱2.20 a km', () => {
    const rule = { base: 15, baseKm: 4, perKm: 2.2, discountPct: 20 };
    const read = ruleFromMatrix(parseRows(matrix(rule, 12)));
    expect(read.rule).toMatchObject({ base: 15, baseKm: 4, discountPct: 20 });
    expect(read.rule!.perKm).toBeCloseTo(2.2, 1);
  });

  it('takes rows as objects, with peso signs, in any order, once a km', () => {
    const rows = parseRows([
      { km: '5', regular: '₱16.00', discounted: 'P12.75' },
      { km: 1, regular: 14 },
      { km: 5, regular: 16 },
      ['x', 3],
      [4, 14, 11.25],
    ]);
    expect(rows.map((r) => r.km)).toEqual([1, 4, 5]);
    expect(rows[2]).toEqual({ km: 5, regular: 16, discounted: 12.75 });
    expect(parseRows('not json')).toEqual([]);
  });

  it('lets one misread row in ten pass, and says which it is', () => {
    const rows = parseRows(matrix(PH_TRADITIONAL_JEEPNEY));
    rows[8] = { ...rows[8]!, regular: rows[8]!.regular + 3 };
    const read = ruleFromMatrix(rows);
    expect(read.rule).toMatchObject({ base: 14, baseKm: 4, perKm: 2 });
    expect(read.offRows).toEqual([{ km: 9, read: 27, ruleSays: 24 }]);
  });

  it('refuses rows that follow no rule, or too few of them', () => {
    expect(
      ruleFromMatrix(
        parseRows([
          [1, 14],
          [2, 14],
        ]),
      ).rule,
    ).toBeNull();
    const jumbled = parseRows(matrix(PH_TRADITIONAL_JEEPNEY)).map((r, i) => ({
      ...r,
      regular: r.regular + (i % 3) * 1.5,
    }));
    const read = ruleFromMatrix(jumbled);
    expect(read.rule).toBeNull();
    expect(read.why).toMatch(/misread/);
  });

  it('a ride is charged by the row of the km started', () => {
    const rows = parseRows(matrix(PH_TRADITIONAL_JEEPNEY, 10));
    expect(fareOnMatrix(rows, PH_TRADITIONAL_JEEPNEY, 6.3, false)).toBe(20);
    expect(fareOnMatrix(rows, PH_TRADITIONAL_JEEPNEY, 6.3, true)).toBe(16);
    // Past the rows: by the rule.
    expect(fareOnMatrix(rows, PH_TRADITIONAL_JEEPNEY, 14, false)).toBe(34);
  });

  it('a fare set from a matrix is used everywhere, until reset', () => {
    setFareRule('jeepney', { base: 15, baseKm: 4, perKm: 2.2, discountPct: 20 });
    expect(fareFor(4, false, FARE_BY_VEHICLE.jeepney)).toBe(15);
    resetFareRules();
    expect(FARE_BY_VEHICLE.jeepney).toBe(PH_TRADITIONAL_JEEPNEY);
  });
});
