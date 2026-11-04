import { describe, expect, it } from 'vitest';
import {
  aiCost,
  DEFAULT_EXPERIMENT,
  fareCentavos,
  generateDemand,
  GROUPS,
  isOwner,
  ledgerCsv,
  MODEL_VERSION,
  problems,
  runDay,
  simulateDay,
  summarize,
  validate,
  type Corridor,
  type Demand,
  type Experiment,
} from './model';
import { economicCorridor } from './routes';

const route: Corridor = {
  name: 'Test 4 km',
  note: 'Fixture',
  stops: [
    { name: 'A', km: 0 },
    { name: 'B', km: 4 },
  ],
};
const config = (patch: Partial<Experiment> = {}): Experiment => ({
  ...DEFAULT_EXPERIMENT,
  days: 2,
  repetitions: 1,
  vehicles: 4,
  dailyTrips: 500,
  hours: 2,
  ...patch,
});
describe('economic accounting', () => {
  it('uses 20% eligible discounts and no pregnancy-only or regular discount', () => {
    expect(fareCentavos(4, 'regular')).toBe(1400);
    expect(fareCentavos(4, 'pregnant')).toBe(1400);
    for (const g of ['student', 'senior', 'pwd'] as const) expect(fareCentavos(4, g)).toBe(1125);
    expect(fareCentavos(4.00000001, 'regular')).toBe(1600);
    expect(fareCentavos(9, 'regular')).toBe(2400);
    expect(() => fareCentavos(NaN, 'regular')).toThrow();
  });
  it('reproduces demand exactly and changes it with seed; shares count once', () => {
    const c = config();
    const a = generateDemand(c, route, 1),
      b = generateDemand(c, route, 1);
    expect(a).toEqual(b);
    expect(a.hash).not.toBe(generateDemand(c, route, 2).hash);
    expect(Object.values(a.groupCounts).reduce((x, y) => x + y, 0)).toBe(c.dailyTrips);
    expect(a.queues.flat().length).toBe(c.dailyTrips);
    for (const q of a.queues)
      expect(q.map((p) => p.at)).toEqual(q.map((p) => p.at).sort((x, y) => x - y));
  });
  it('keeps the shares for a weekday as a whole; fewer students at the weekend; no two days alike', () => {
    const corridor = economicCorridor('fairview');
    const c = config({ dailyTrips: 20_000, hours: 14, startHour: 6 });
    const days = Array.from({ length: 7 }, (_, day) => generateDemand(c, corridor, 7 + day, day));
    const share = (day: number, g: (typeof GROUPS)[number]) =>
      days[day]!.groupCounts[g] / c.dailyTrips;
    // Monday to Friday: each day within its swing of the shares set, and
    // the five together close to them.
    const weekdays = [0, 1, 2, 3, 4];
    for (const g of GROUPS) {
      for (const day of weekdays) {
        expect(share(day, g)).toBeGreaterThan(c.groups[g] * 0.65);
        expect(share(day, g)).toBeLessThan(c.groups[g] * 1.35);
      }
      const mean = weekdays.reduce((a, d) => a + share(d, g), 0) / weekdays.length;
      expect(mean).toBeGreaterThan(c.groups[g] * 0.85);
      expect(mean).toBeLessThan(c.groups[g] * 1.15);
    }
    // Saturday (day 6 of the month) and Sunday.
    expect(share(5, 'student')).toBeLessThan(share(4, 'student') / 2);
    expect(share(6, 'student')).toBeLessThan(share(0, 'student') / 2);
    expect(new Set([0, 1, 2, 3, 4].map((d) => share(d, 'student').toFixed(4))).size).toBe(5);
  });
  it('reconciles an independently calculated capacity-limited two-trip day including overtime', () => {
    const c = config({
      vehicles: 1,
      capacity: 1,
      hours: 1,
      dailyTrips: 2,
      speedKmh: 10,
      peakSpeedFactor: 1,
      movingKmPerL: 10,
      idleLPerHour: 0,
      startLitres: 0,
      serviceSeconds: 0,
      passengerSeconds: 0,
      terminalSeconds: 0,
      extraTerminalSeconds: 0,
      emptyStopProbability: 0,
      boundaryPhp: 0,
      ownerUpkeepPhp: 0,
      otherDailyPhp: 0,
      maintenancePhpPerKm: 0,
      dieselPhp: 100,
    });
    const make = (id: number) => ({
      id,
      at: 0,
      origin: 0,
      destination: 1,
      group: 'regular' as const,
      fare: 1400,
      km: 4,
    });
    const demand: Demand = {
      queues: [[make(0), make(1)], [], [], []],
      groupCounts: { regular: 2, student: 0, senior: 0, pwd: 0, pregnant: 0 },
      hash: 'fixture',
      count: 2,
    };
    const r = simulateDay(c, route, demand, 1, 'baseline', 10);
    expect(r.completed).toBe(2);
    expect(r.unserved).toBe(0);
    expect(r.km).toBe(12);
    expect(r.revenueCentavos).toBe(2800);
    expect(r.fuelLitres).toBeCloseTo(1.2);
    expect(r.profitPhp).toBeCloseTo(-92);
    expect(r.overtimeSeconds).toBe(720);
    expect(r.waitSeconds).toBe(2880);
    expect(r.logs[1]!.completedS).toBe(4320);
  });
  it('does not fabricate AI operational gains when adoption is equal', () => {
    const c = config();
    const row = runDay(c, route, 0, 0, 30);
    const [base, plan, muse] = row.results;
    expect(muse!.revenueCentavos).toBe(plan!.revenueCentavos);
    expect(muse!.fuelLitres).toBe(plan!.fuelLitres);
    expect(muse!.logs).toEqual(plan!.logs);
    expect(muse!.profitPhp).toBeCloseTo(plan!.profitPhp - muse!.aiPhp);
    expect(base!.appPhp).toBe(0);
    expect(row).toEqual(runDay(c, route, 0, 0, 30));
  });
  it('conserves passengers, centavos and per-vehicle money under overload', () => {
    const c = config({ dailyTrips: 20000, vehicles: 2, capacity: 3 });
    for (const r of runDay(c, route, 0, 0, 20000).results) {
      expect(r.completed + r.unserved).toBe(c.dailyTrips);
      expect(r.unserved).toBeGreaterThan(0);
      expect(r.completed).toBe(r.boarded);
      expect(Object.values(r.groups).reduce((a, b) => a + b, 0)).toBe(r.completed);
      expect(Object.values(r.groupRevenueCentavos).reduce((a, b) => a + b, 0)).toBe(
        r.revenueCentavos,
      );
      expect(r.vehicleProfitPhp.reduce((a, b) => a + b, 0)).toBeCloseTo(r.profitPhp, 6);
      for (let v = 0; v < c.vehicles; v++) {
        const events = r.logs
          .filter((l) => l.vehicle === v)
          .flatMap((l) => [
            { at: l.boardedS, change: 1 },
            { at: l.completedS, change: -1 },
          ])
          .sort((a, b) => a.at - b.at || a.change - b.change);
        let aboard = 0;
        for (const e of events) {
          aboard += e.change;
          expect(aboard).toBeLessThanOrEqual(c.capacity);
          expect(aboard).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
  it('has no phantom fare revenue or time savings with zero demand', () => {
    for (const r of runDay(config({ dailyTrips: 0 }), route, 0, 0).results) {
      expect(r.revenueCentavos).toBe(0);
      expect(r.completed).toBe(0);
      expect(r.waitSeconds).toBe(0);
      expect(r.profitPhp).toBeLessThan(0);
    }
  });
  it('calculates tokens and audio separately, including audio on cache hits', () => {
    const c = config({ cacheHitShare: 0, voiceShare: 1 });
    expect(aiCost(c, 100).php).toBeCloseTo(
      100 * (((1000 * 1.25 + 200 * 4.25) / 1e6) * 58 + (5 / 3600) * 0.18 * 58),
    );
    expect(aiCost({ ...c, cacheHitShare: 1 }, 100).php).toBeCloseTo(1.45);
  });
  it('keeps daily and repeated month units separate and exports reconciled rows', () => {
    const c = config({ days: 2, repetitions: 2 });
    const days = [
      runDay(c, route, 0, 0),
      runDay(c, route, 0, 1),
      runDay(c, route, 1, 0),
      runDay(c, route, 1, 1),
    ];
    const run = { version: MODEL_VERSION, config: c, route, days };
    for (const s of summarize(run)) expect(s.monthlyPerVehicle).toBeCloseTo(s.dailyPerVehicle * 2);
    expect(ledgerCsv(run).split('\n')).toHaveLength(13);
  });
  it('rejects invalid inputs rather than silently changing the experiment', () => {
    for (const patch of [
      { vehicles: 0 },
      { days: 32 },
      { repetitions: 51 },
      { dailyTrips: 200001 },
      { hours: 20 },
      { speedKmh: NaN },
      { movingKmPerL: 0 },
      { plannerAdoption: 1.01 },
      { seed: 0 },
      { fillShare: 1.2 },
      { maxHoldSeconds: 600, holdStepSeconds: 0 },
    ])
      expect(() => validate(config(patch), route)).toThrow();
    expect(() =>
      validate(
        config({ groups: { regular: 1, student: 1, pwd: 0, senior: 0, pregnant: 0 } }),
        route,
      ),
    ).toThrow();
    expect(() =>
      validate(config(), {
        ...route,
        stops: [
          { name: 'A', km: 0 },
          { name: 'B', km: 0 },
        ],
      }),
    ).toThrow();
  });
  it('keeps each jeepney’s own day when asked, adding up exactly to the fleet’s', () => {
    const c = config({ vehicles: 12, dailyTrips: 12 * 250 });
    expect(runDay(c, route, 0, 0).results[0]!.vehicleDays).toEqual([]);
    for (const r of runDay(c, route, 0, 0, 0, true).results) {
      const vs = r.vehicleDays;
      expect(vs).toHaveLength(12);
      const sum = (f: (v: (typeof vs)[number]) => number) => vs.reduce((s, v) => s + f(v), 0);
      expect(sum((v) => v.riders)).toBe(r.completed);
      expect(sum((v) => v.fareCentavos)).toBe(r.revenueCentavos);
      expect(sum((v) => v.km)).toBeCloseTo(r.km, 6);
      expect(sum((v) => v.litres)).toBeCloseTo(r.fuelLitres, 6);
      expect(sum((v) => v.waitS)).toBeCloseTo(r.waitSeconds, 6);
      expect(sum((v) => v.holdS)).toBe(r.holdSeconds);
      expect(sum((v) => v.driveS)).toBeCloseTo(r.driveSeconds, 6);
      expect(sum((v) => v.profitPhp)).toBeCloseTo(r.profitPhp, 6);
      for (const v of vs) {
        // A one-way trip covers the corridor: its kilometres are trips × 4 km,
        // give or take the trip it was on when the day ended.
        expect(v.km).toBeGreaterThanOrEqual(v.trips * 4 - 1e-9);
        expect(v.km).toBeLessThanOrEqual((v.trips + 1) * 4 + 1e-9);
      }
    }
  });
  it('changes the start order every day, so over a month every jeepney gets its share', () => {
    const corridor = economicCorridor('fairview');
    const c = config({ vehicles: 20, dailyTrips: 20 * 250 });
    const days = Array.from({ length: 26 }, (_, d) => runDay(c, corridor, 0, d, 0, true));
    const month = Array.from({ length: 20 }, (_, i) =>
      days.reduce((s, d) => s + d.results[0]!.vehicleDays[i]!.riders, 0),
    );
    const mean = month.reduce((a, b) => a + b, 0) / month.length;
    // No jeepney is always the one right behind another.
    for (const riders of month) {
      expect(riders).toBeGreaterThan(mean * 0.75);
      expect(riders).toBeLessThan(mean * 1.25);
    }
  });
  it('charges boundary only to drivers who do not own their jeepney; owners pay upkeep', () => {
    const c = config({ vehicles: 40, dailyTrips: 40 * 250, ownerShare: 0.25, ownerUpkeepPhp: 200 });
    const owners = Array.from({ length: 40 }, (_, i) => isOwner(c, i)).filter(Boolean).length;
    // About a quarter, and the same jeepneys every day of the run.
    expect(owners).toBeGreaterThan(4);
    expect(owners).toBeLessThan(18);
    for (const r of runDay(c, route, 0, 0).results) {
      expect(r.boundaryPhp).toBe(700 * (40 - owners));
      expect(r.upkeepPhp).toBe(200 * owners);
      expect(r.vehicleProfitPhp.reduce((x, y) => x + y, 0)).toBeCloseTo(r.profitPhp, 6);
    }
    expect(runDay(config({ ownerShare: 0 }), route, 0, 0).results[0]!.upkeepPhp).toBe(0);
  });
  it('lists every problem at once, each with its setting, as the lab shows them', () => {
    expect(problems(config(), route)).toEqual([]);
    // The settings of the lab screenshot: 100 runs and shares adding up to 127%.
    const issues = problems(
      config({
        repetitions: 100,
        groups: { regular: 0.65, student: 0.45, pwd: 0.05, senior: 0.1, pregnant: 0.02 },
      }),
      route,
    );
    expect(issues.map((p) => p.key)).toEqual(['repetitions', 'groups']);
    expect(issues[0]!.message).toContain('1–50 (now 100)');
    expect(issues[1]!.message).toContain('127%');
  });
  it('waits for riders at a quiet terminal instead of driving near-empty: less diesel, same riders', () => {
    // 600 trips a day for 10 jeepneys on 4 km: far more seats than riders.
    const c = config({
      vehicles: 10,
      dailyTrips: 600,
      hours: 8,
      plannerAdoption: 1,
      museAdoption: 1,
    });
    const [base, plan] = runDay(c, route, 0, 0).results;
    expect(plan!.holdSeconds).toBeGreaterThan(0);
    expect(base!.holdSeconds).toBe(0);
    expect(plan!.km).toBeLessThan(base!.km);
    expect(plan!.fuelLitres).toBeLessThan(base!.fuelLitres);
    // Waiting for riders does not lose them…
    expect(plan!.completed).toBeGreaterThanOrEqual(base!.completed * 0.99);
    // …and the diesel saved is more than the app costs, at this demand.
    expect(plan!.profitPhp).toBeGreaterThan(base!.profitPhp);
  });
  it('leaves a busy terminal at once: never serves fewer riders than the habit', () => {
    // Heavy demand fills every jeepney at the terminal.
    const c = config({ vehicles: 4, dailyTrips: 20000, plannerAdoption: 1, museAdoption: 1 });
    const [base, plan] = runDay(c, route, 0, 0).results;
    // Only the first trips of the day, before riders gather, wait at all.
    expect(plan!.holdSeconds).toBeLessThanOrEqual(c.vehicles * 2 * c.holdStepSeconds);
    expect(plan!.completed).toBeGreaterThanOrEqual(base!.completed);
  });
  it('never holds past the cap, and not at all without the advice', () => {
    const c = config({
      vehicles: 3,
      dailyTrips: 50,
      plannerAdoption: 1,
      museAdoption: 1,
      maxHoldSeconds: 180,
    });
    const [base, plan] = runDay(c, route, 0, 0).results;
    expect(base!.holdSeconds).toBe(0);
    // At most 3 steps of 60 s per terminal visit, and visits ≤ service stops.
    expect(plan!.holdSeconds).toBeLessThanOrEqual(plan!.serviceStops * 180);
    expect(plan!.holdSeconds % 60).toBe(0);
  });
  it('builds both named corridors from the actual mapped SM stop', () => {
    const full = economicCorridor('fairview'),
      short = economicCorridor('lagro');
    expect(full.stops[0]!.name).toContain('San Jose del Monte');
    expect(short.stops.at(-1)!.name).toBe('Lagro');
    expect(full.stops.at(-1)!.km).toBeCloseTo(8.56, 1);
    expect(short.stops.at(-1)!.km).toBeLessThan(full.stops.at(-1)!.km);
    expect(GROUPS).toHaveLength(5);
  });
});
