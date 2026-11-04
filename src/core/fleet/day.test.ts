import { describe, expect, it } from 'vitest';
import { TwinRuntime } from '@/app/twinRuntime';
import { aheadOf, defaultRoute } from '../geo/routes';
import { RouteFlow } from '../network/flow';
import { VEHICLES, type FleetKind } from '../vehicles/specs';
import { DAY_ENDS_S, FIELD_SCENARIO, SERVICE_FROM_S } from './scenario';

const length = (k: FleetKind) => (k === 'jeepney' ? 6.9 : VEHICLES[k].lengthM);
const width = (k: FleetKind) => (k === 'jeepney' ? 2.0 : VEHICLES[k].widthM);

/** 20 jeepneys from 5 AM, a quarter of them owner-driven, in fast-forward steps (what 300× runs). */
const morning = () =>
  new TwinRuntime(defaultRoute(), undefined, {
    ...FIELD_SCENARIO,
    vehicles: 20,
    dailyTrips: 20 * 300,
  });

describe('a working day on the route', () => {
  it(
    'starts parked, sets out about 6 AM from the terminal or from home, refuels, parks at night, closes the day at 3 AM',
    { timeout: 300_000 },
    () => {
      const twin = morning();
      const { fleet } = twin;
      const route = twin.route;
      const terminals = route.stops.filter((s) => s.terminal).map((s) => s.s);
      const apart = (a: number, b: number) => Math.min(aheadOf(route, a, b), aheadOf(route, b, a));
      const nearTerminal = (s: number, within: number) =>
        terminals.some((t) => apart(s, t) < within);
      expect(fleet.vehicles.every((v) => v.duty === 'parked')).toBe(true);
      expect(fleet.vehicles.some((v) => v.owner)).toBe(true);
      expect(fleet.vehicles.some((v) => !v.owner)).toBe(true);
      // Boundary jeepneys both at a terminal and at garages along the route.
      expect(fleet.vehicles.some((v) => !v.owner && v.depot !== null)).toBe(true);
      expect(fleet.vehicles.some((v) => !v.owner && v.depot === null)).toBe(true);
      expect(fleet.vehicles.every((v) => !v.owner || v.depot === null)).toBe(true);
      for (const v of fleet.vehicles) {
        // Kept along the route (home or garage) away from the terminals, or at a terminal.
        if (v.depot === null) expect(nearTerminal(v.garageS, 799)).toBe(false);
        else expect(nearTerminal(v.garageS, 1)).toBe(true);
      }
      expect(fleet.dayNumber).toBe(1);

      let wasParked = fleet.vehicles.map(() => true);
      let outBy7 = 0;
      let overlaps = 0;
      let parkedRight = 0;
      let refuelled = 0;
      let lastTotals = fleet.vehicles.map((v) => ({ ...v.day, tankEndL: v.tankL }));
      while (fleet.dayNumber === 1) {
        lastTotals = fleet.vehicles.map((v) => ({ ...v.day, tankEndL: v.tankL }));
        const wasFilling = fleet.vehicles.map((v) => v.refuelLeftS > 0);
        twin.step(0.25, 0);
        const now = fleet.timeOfDay;
        fleet.vehicles.forEach((v, i) => {
          if (wasParked[i] && v.duty !== 'parked') {
            expect(now).toBeGreaterThanOrEqual(SERVICE_FROM_S - 1);
            expect(v.occupancy).toBe(0);
            // Out from its home or garage; or at its terminal, or the back of its line.
            if (v.depot === null) expect(Math.abs(v.s - v.garageS)).toBeLessThan(1);
            else expect(terminals.some((t) => aheadOf(route, v.s, t) < 1500)).toBe(true);
          }
          if (!wasParked[i] && v.duty === 'parked') {
            // Back at its home or garage; or at a terminal, with the operator.
            if (v.depot === null) expect(apart(v.s, v.garageS)).toBeLessThan(12);
            else expect(nearTerminal(v.s, 35)).toBe(true);
            parkedRight++;
          }
          // Filled up: a full tank, and never below empty.
          if (wasFilling[i] && v.refuelLeftS === 0) {
            refuelled++;
            expect(v.tankL).toBe(v.tankCapacityL);
          }
          expect(v.tankL).toBeGreaterThanOrEqual(0);
        });
        wasParked = fleet.vehicles.map((v) => v.duty === 'parked');
        if (Math.abs(now - 7 * 3600) < 0.2)
          outBy7 = fleet.vehicles.filter((v) => v.duty !== 'parked').length;
        // Nobody inside anybody, even in fast-forward steps (one at the pumps
        // is off the lane), by each one's length and width (a few are vans
        // and buses: see sizes.test.ts).
        const on = fleet.vehicles.filter((v) => v.duty !== 'parked');
        for (let a = 0; a < on.length; a++)
          for (let b = a + 1; b < on.length; b++) {
            const x = on[a]!;
            const y = on[b]!;
            if (
              apart(x.s, y.s) < (length(x.kind) + length(y.kind)) / 2 - 0.3 &&
              Math.abs(fleet.acrossOf(x) - fleet.acrossOf(y)) <
                (width(x.kind) + width(y.kind)) / 2 - 0.1
            )
              overlaps++;
          }
        if (now > 2.5 * 3600 && now < DAY_ENDS_S) expect(fleet.allParked).toBe(true);
      }
      expect(outBy7).toBe(20);
      expect(overlaps).toBe(0);
      expect(parkedRight).toBe(20);
      expect(refuelled).toBeGreaterThan(0);
      // Closed at 3 AM with exactly the day's totals; the new day starts from zero.
      expect(Math.abs(fleet.timeOfDay - DAY_ENDS_S)).toBeLessThan(1);
      expect(fleet.history).toHaveLength(1);
      expect(fleet.history[0]!.day).toBe(1);
      expect(fleet.history[0]!.totals).toEqual(lastTotals);
      expect(fleet.history[0]!.totals.every((d) => d.riders > 0)).toBe(true);
      expect(fleet.vehicles.every((v) => v.day.riders === 0 && v.day.metres === 0)).toBe(true);
      // Nobody waits through the night for a jeepney that is not coming.
      expect(twin.crew.log.length).toBeGreaterThan(0);
      expect(fleet.waiting.reduce((a, b) => a + b, 0)).toBe(0);
      // Day 2 starts the same way, at times of its own.
      while (fleet.timeOfDay < 7 * 3600) twin.step(0.25, 0);
      expect(fleet.vehicles.filter((v) => v.duty !== 'parked').length).toBe(20);
    },
  );

  it('gets the whole fleet out by 7 AM, a terminal’s line and all', { timeout: 300_000 }, () => {
    // Many boundary drivers collect their jeepney at the same two terminals:
    // they queue behind the one loading there rather than wait for an empty kerb.
    const twin = new TwinRuntime(defaultRoute(), undefined, FIELD_SCENARIO);
    while (twin.fleet.timeOfDay < 7 * 3600) twin.step(0.25, 0);
    expect(twin.fleet.vehicles.filter((v) => v.duty === 'parked')).toHaveLength(0);
  });

  it('runs the night at the speed chosen, and fast only when asked to skip it', () => {
    const atNight = () =>
      new TwinRuntime(defaultRoute(), undefined, { ...FIELD_SCENARIO, vehicles: 20, startHour: 1 });
    const run = (twin: TwinRuntime, skip: boolean) => {
      const start = twin.clockS;
      for (let frame = 0; frame < 60; frame++) twin.advance(1 / 60, 0, 1, skip);
      return twin.clockS - start;
    };
    const plain = atNight();
    expect(plain.night).toBe(true);
    // One second of frames at 1×: one simulated second, night or not.
    expect(run(plain, false)).toBeCloseTo(1, 1);
    expect(run(atNight(), true)).toBeGreaterThan(500);
  });

  it('runs the other routes the same way: out about 6 AM, none at night', () => {
    const route = defaultRoute();
    const flow = new RouteFlow(route, 60);
    const at = (h: number) => flow.vehicles(h * 3600);
    expect(at(2).every((v) => !v.inService && v.occupancy === 0)).toBe(true);
    expect(at(5).every((v) => !v.inService)).toBe(true);
    expect(at(12).every((v) => v.inService)).toBe(true);
    expect(at(26).some((v) => v.inService)).toBe(false);
    // Setting out over the early morning, a few at a time.
    const out = (h: number) => flow.vehicles(h * 3600).filter((v) => v.inService).length;
    expect(out(SERVICE_FROM_S / 3600 + 0.25)).toBeGreaterThan(0);
    expect(out(SERVICE_FROM_S / 3600 + 0.25)).toBeLessThan(flow.count);
    expect(out(7)).toBe(flow.count);
    // A parked one is never offered to a waiting rider.
    expect(flow.arrivals(route.stops[3]!.s, 2 * 3600)).toEqual([]);
  });

  it('brings the other routes’ jeepneys out all along the road, and back there at night', () => {
    const route = defaultRoute();
    const flow = new RouteFlow(route, 60);
    const terminals = route.stops.filter((st) => st.terminal).map((st) => st.s);
    const fromTerminal = (s: number) =>
      Math.min(...terminals.map((t) => Math.min(aheadOf(route, s, t), aheadOf(route, t, s))));
    // Where each one first appears in the morning, a minute at a time.
    const firstSeen: number[] = [];
    for (let t = SERVICE_FROM_S; t < 9 * 3600; t += 60)
      flow.vehicles(t).forEach((v, i) => {
        if (v.inService && firstSeen[i] === undefined) firstSeen[i] = v.s;
      });
    expect(firstSeen.filter((s) => s !== undefined)).toHaveLength(flow.count);
    const alongRoad = firstSeen.filter((s) => fromTerminal(s) > 700).length;
    expect(alongRoad).toBeGreaterThan(flow.count / 3);
    expect(alongRoad).toBeLessThan(flow.count);
    // All in by 1 AM.
    expect(flow.vehicles(25 * 3600).some((v) => v.inService)).toBe(false);
  });

  it('drives the other routes like jeepneys: forward only, a wait at each terminal, no platoons', () => {
    const route = defaultRoute();
    const flow = new RouteFlow(route, 60);
    const L = route.polyline.length;
    const terminals = route.stops.filter((st) => st.terminal).map((st) => st.s);
    let waiting = 0;
    for (let h = 7; h < 21; h += 0.25) {
      const now = flow.vehicles(h * 3600);
      const next = flow.vehicles(h * 3600 + 2);
      now.forEach((v, k) => {
        if (!v.inService || !next[k]!.inService) return;
        // Two seconds on: the same place or a little further round, never back.
        const d = (((next[k]!.s - v.s) % L) + L) % L;
        expect(d).toBeLessThan(60);
        if (v.speedMps === 0) {
          waiting++;
          // In the line at a terminal, moving up past it (round the loop: its start is its end).
          const off = (t: number) => Math.min(Math.abs(t - v.s), L - Math.abs(t - v.s));
          expect(Math.min(...terminals.map(off))).toBeLessThan(46);
        }
      });
      // On the open road no more than three nose to tail (a terminal's line is a line).
      const open = now
        .filter((v) => v.inService && v.speedMps > 0)
        .map((v) => v.s)
        .sort((x, y) => x - y);
      let run = 1;
      for (let i = 1; i < open.length; i++) {
        run = open[i]! - open[i - 1]! < 30 ? run + 1 : 1;
        expect(run).toBeLessThanOrEqual(3);
      }
    }
    expect(waiting).toBeGreaterThan(0);
  });
});
