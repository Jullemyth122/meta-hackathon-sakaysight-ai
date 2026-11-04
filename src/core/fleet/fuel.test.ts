import { describe, expect, it } from 'vitest';
import { TwinRuntime } from '@/app/twinRuntime';
import { defaultRoute } from '../geo/routes';
import { FUEL } from '../vehicles/specs';
import { FIELD_SCENARIO } from './scenario';

describe('diesel', () => {
  it(
    'tanks differ; nobody runs dry; they fill up in the forecourt, sometimes in line; the day’s diesel adds up and what is left carries over',
    { timeout: 900_000 },
    () => {
      const twin = new TwinRuntime(defaultRoute(), undefined, {
        ...FIELD_SCENARIO,
        vehicles: 24,
        dailyTrips: 24 * 60,
        startHour: 5,
      });
      const { fleet } = twin;
      const sizes = fleet.vehicles.map((v) => v.tankCapacityL);
      // Each in its own type's range (a modern jeepney's tank is bigger than a jeepney's).
      for (const v of fleet.vehicles) {
        const [smallest, largest] = FUEL[v.kind ?? 'jeepney'].tankL;
        expect(v.tankCapacityL).toBeGreaterThanOrEqual(smallest);
        expect(v.tankCapacityL).toBeLessThanOrEqual(largest);
      }
      expect(new Set(sizes.map((x) => x.toFixed(1))).size).toBeGreaterThan(10);

      // The first morning: some filled the night before, some not.
      const start = fleet.vehicles.map((v) => v.tankL / v.tankCapacityL);
      expect(Math.min(...start)).toBeGreaterThanOrEqual(0.2);
      expect(Math.max(...start) - Math.min(...start)).toBeGreaterThan(0.5);
      expect(start.filter((x) => x >= 0.9).length).toBeGreaterThan(3);
      expect(start.filter((x) => x < 0.6).length).toBeGreaterThan(3);

      let lowest = Infinity;
      let nightFills = 0;
      // How long each has stood in the road, and the longest any has: nothing is left stuck.
      const standing = new Map<number, number>();
      let longestStand = 0;
      // Each visit to a station: how long at the pump, whether it waited in line, how far off the road.
      type Visit = { pumpS: number; waited: boolean; offRoadM: number; largestL: number };
      const visiting = new Map<number, Visit>();
      const visits: Visit[] = [];
      while (fleet.dayNumber <= 2) {
        twin.step(1, 0);
        for (const v of fleet.vehicles) {
          if (v.duty !== 'parked') lowest = Math.min(lowest, v.tankL / v.tankCapacityL);
          // At a stop or its terminal it is waiting for riders, not stuck.
          const stands =
            v.duty !== 'parked' && !v.yard && v.speedMps < 0.1 && v.currentStop === null;
          const stood = stands ? (standing.get(v.id) ?? 0) + 1 : 0;
          standing.set(v.id, stood);
          longestStand = Math.max(longestStand, stood);
          if (v.duty === 'homebound' && v.refuelLeftS > 0) nightFills++;
          const y = v.yard;
          const visit = visiting.get(v.id);
          if (y) {
            const now = visit ?? {
              pumpS: 0,
              waited: false,
              offRoadM: 0,
              largestL: FUEL[v.kind ?? 'jeepney'].tankL[1],
            };
            if (v.refuelLeftS > 0) now.pumpS++;
            now.waited ||= y.ahead > 0;
            now.offRoadM = Math.max(now.offRoadM, v.laneShiftM);
            visiting.set(v.id, now);
          } else if (visit) {
            visits.push(visit);
            visiting.delete(v.id);
          }
        }
      }
      // Two minutes or a little more at the pump (a bigger tank takes longer:
      // the attendant's 90 s at most, and its litres at 35 a minute), in the
      // forecourt off the road.
      expect(visits.length).toBeGreaterThan(fleet.vehicles.length);
      for (const visit of visits) {
        expect(visit.pumpS).toBeGreaterThanOrEqual(119);
        expect(visit.pumpS).toBeLessThan(Math.max(200, 90 + (visit.largestL / 35) * 60 + 5));
        expect(visit.offRoadM).toBeGreaterThanOrEqual(4);
      }
      // Some wait their turn: a car at the pump, or a jeepney.
      expect(visits.some((x) => x.waited)).toBe(true);
      // Queues move: nobody stands in the road for ten minutes.
      expect(longestStand).toBeLessThan(10 * 60);
      // Never below a tenth of a tank on the road: always a station in reach.
      expect(lowest).toBeGreaterThan(0.1);
      // Some drivers fill up on the way home.
      expect(nightFills).toBeGreaterThan(0);

      expect(fleet.history.length).toBeGreaterThanOrEqual(2);
      fleet.history.forEach((h, k) =>
        h.totals.forEach((d, i) => {
          // In the tank at the start, less what was burnt, plus what was bought.
          expect(d.tankStartL - d.fuelUsedL + d.fuelBoughtL).toBeCloseTo(d.tankEndL!, 6);
          // The next day starts with what was left.
          const next = fleet.history[k + 1]?.totals[i];
          if (next) expect(next.tankStartL).toBeCloseTo(d.tankEndL!, 6);
          if (d.metres > 10_000) expect(d.fuelUsedL).toBeGreaterThan(0);
        }),
      );
      const refuels = fleet.history.reduce(
        (n, h) => n + h.totals.reduce((m, d) => m + d.refuels, 0),
        0,
      );
      expect(refuels).toBeGreaterThan(fleet.vehicles.length);
    },
  );
});
