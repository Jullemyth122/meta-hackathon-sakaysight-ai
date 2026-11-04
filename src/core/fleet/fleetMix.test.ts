import { describe, expect, it } from 'vitest';
import type { FleetKind } from '../vehicles/specs';
import {
  alignKinds,
  FIELD_SCENARIO,
  MAX_SCENARIO_VEHICLES,
  mixKinds,
  mixTotal,
  normalizeScenario,
  pickFleet,
} from './scenario';

describe('a fleet chosen by hand', () => {
  const mix = { jeepney: 10, modern: 4, uv: 3, bus: 2 };

  it('has exactly what was asked for', () => {
    const kinds = mixKinds(mix);
    expect(kinds).toHaveLength(19);
    for (const kind of ['jeepney', 'modern', 'uv', 'bus'] as const)
      expect(kinds.filter((k) => k === kind)).toHaveLength(mix[kind]);
  });

  it('is scattered, not one kind after another', () => {
    const kinds = mixKinds({ jeepney: 30, modern: 0, uv: 0, bus: 30 });
    let longest = 1;
    let run = 1;
    for (let i = 1; i < kinds.length; i++) {
      run = kinds[i] === kinds[i - 1] ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThan(8);
  });

  it('sets the number of vehicles, and is kept', () => {
    const s = normalizeScenario({ ...FIELD_SCENARIO, vehicles: 999, mix });
    expect(s.vehicles).toBe(19);
    expect(s.mix).toEqual(mix);
  });

  it('can leave a kind out altogether', () => {
    const s = normalizeScenario({
      ...FIELD_SCENARIO,
      mix: { jeepney: 0, modern: 0, uv: 5, bus: 0 },
    });
    expect(s.vehicles).toBe(5);
    expect(mixKinds(s.mix!)).toEqual(Array(5).fill('uv'));
  });

  it('never leaves a route empty, nor takes nonsense', () => {
    const none = normalizeScenario({
      ...FIELD_SCENARIO,
      mix: { jeepney: 0, modern: -3, uv: Number.NaN, bus: 0 },
    });
    expect(none.vehicles).toBe(1);
    expect(mixTotal(none.mix!)).toBe(1);
  });

  it('is cut to what can be simulated, in proportion', () => {
    const s = normalizeScenario({
      ...FIELD_SCENARIO,
      mix: { jeepney: 3000, modern: 0, uv: 0, bus: 1000 },
    });
    expect(s.vehicles).toBeLessThanOrEqual(MAX_SCENARIO_VEHICLES);
    expect(s.mix!.jeepney / s.mix!.bus).toBeCloseTo(3, 1);
  });

  it('without one, a scenario stays as it was', () => {
    const s = normalizeScenario(FIELD_SCENARIO);
    expect(s.vehicles).toBe(60);
    expect(s.mix).toBeUndefined();
  });
});

describe('handing a route from the flows to the simulation', () => {
  /** 300 vehicles, every fifth a bus, the rest jeepneys. */
  const fleet = Array.from({ length: 300 }, (_, index) => ({
    index,
    kind: (index % 5 === 0 ? 'bus' : 'jeepney') as FleetKind,
  }));

  it('keeps the vehicle clicked, however far down the fleet it is', () => {
    const chosen = pickFleet(fleet, 120, undefined, 295);
    expect(chosen).toHaveLength(120);
    expect(chosen.map((v) => v.index)).toContain(295);
  });

  it('with no click, takes the first of them', () => {
    expect(pickFleet(fleet, 3).map((v) => v.index)).toEqual([0, 1, 2]);
  });

  it('keeps to a mix chosen by hand, the clicked one counted in it', () => {
    const mix = { jeepney: 4, modern: 0, uv: 0, bus: 2 };
    const chosen = pickFleet(fleet, 6, mix, 295);
    expect(chosen.map((v) => v.index)).toContain(295);
    expect(chosen.filter((v) => v.kind === 'bus')).toHaveLength(2);
    expect(chosen.filter((v) => v.kind === 'jeepney')).toHaveLength(4);
  });

  it('stays in the fleet order', () => {
    const at = pickFleet(fleet, 120, undefined, 295).map((v) => v.index);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('gives each vehicle handed over its own kind, and the fleet its numbers', () => {
    const kinds: FleetKind[] = ['jeepney', 'jeepney', 'bus', 'uv'];
    const out = alignKinds(kinds, [{ kind: 'bus' }, { kind: 'jeepney' }]);
    expect(out.slice(0, 2)).toEqual(['bus', 'jeepney']);
    expect([...out].sort()).toEqual([...kinds].sort());
  });

  it('adds a kind the fleet had none of, rather than change what was clicked', () => {
    expect(alignKinds(['jeepney', 'jeepney'], [{ kind: 'bus' }])).toEqual(['bus', 'jeepney']);
  });

  it('leaves a fleet with no flow behind it as it is', () => {
    const kinds: FleetKind[] = ['jeepney', 'bus'];
    expect(alignKinds(kinds, [])).toEqual(kinds);
    expect(alignKinds(kinds, [{}, {}])).toEqual(kinds);
  });
});
