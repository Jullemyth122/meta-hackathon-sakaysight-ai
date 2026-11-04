import { describe, expect, it } from 'vitest';
import { TwinRuntime } from '@/app/twinRuntime';
import { FARE_BY_VEHICLE, fareFor } from '@/core/fare';
import { FIELD_SCENARIO } from '@/core/fleet/scenario';
import { defaultRoute, isTerminal } from '@/core/geo/routes';
import { newRiderPose } from '@/core/people/riderMotion';
import { fleetKinds, placesOf, type FleetKind } from '@/core/vehicles/specs';
import { puvLayout } from './puvCrew';

describe('modern jeepneys, UV Express and buses in the live twin', () => {
  it('a few of each in the fleet', () => {
    const kinds = fleetKinds(60);
    const count = (k: FleetKind) => kinds.filter((x) => x === k).length;
    // Shares of 12%, 8% and 8%, give or take one in sixty.
    expect(Math.abs(count('modern') - 7)).toBeLessThanOrEqual(1);
    expect(Math.abs(count('bus') - 5)).toBeLessThanOrEqual(1);
    expect(Math.abs(count('uv') - 5)).toBeLessThanOrEqual(1);
    expect(count('jeepney')).toBeGreaterThan(40);
    expect(fleetKinds(8).every((k) => k === 'jeepney')).toBe(true);
    expect(fleetKinds(20, 'bus').every((k) => k === 'bus')).toBe(true);
  });

  it('fares by the vehicle (LTFRB, 28 Sept 2026)', () => {
    expect(fareFor(4, false, FARE_BY_VEHICLE.jeepney)).toBe(14);
    expect(fareFor(6, false, FARE_BY_VEHICLE.modern)).toBe(21.75); // 17 + 2 × 2.40 = 21.80 → nearest 25 c
    expect(fareFor(5, false, FARE_BY_VEHICLE.bus)).toBe(18);
    expect(fareFor(7, false, FARE_BY_VEHICLE.bus)).toBe(24); // 18 + 2 × 2.98 = 23.96
    expect(fareFor(10, false, FARE_BY_VEHICLE.uv)).toBe(26);
    expect(fareFor(10, true, FARE_BY_VEHICLE.uv)).toBe(20.75); // 20% off 26 = 20.80
  });

  it(
    'riders get on each kind, sit in their own seats, and a UV Express loads only at its terminal',
    { timeout: 300_000 },
    () => {
      const twin = new TwinRuntime(defaultRoute(), undefined, { ...FIELD_SCENARIO, startHour: 6 });
      const { fleet, crew, route } = twin;
      const seen = new Map<FleetKind, Set<number>>();
      const uvBoardedAt = new Set<number>();
      const seat = newRiderPose();
      for (let k = 0; k < 2.5 * 3600 * 2; k++) {
        twin.step(0.5, 0);
        if (k % 20) continue;
        const bySeat = new Map<string, number>();
        for (const r of crew.passengers.values()) {
          if (r.vehicleId === null || r.seat === null) continue;
          const v = fleet.vehicles[r.vehicleId]!;
          // Nobody shares a seat, nor sits in the one kept beside a pregnant rider.
          for (const place of typeof r.room !== 'number' ? [r.seat] : [r.seat, r.room]) {
            const key = `${v.id}:${place}`;
            expect(bySeat.has(key), `two riders in seat ${key}`).toBe(false);
            bySeat.set(key, r.id);
          }
          if (v.kind === 'jeepney') continue;
          (seen.get(v.kind) ?? seen.set(v.kind, new Set()).get(v.kind)!).add(r.id);
          if (v.kind === 'uv' && r.phase === 'boarding') uvBoardedAt.add(r.originStop);
          // Riding: exactly in the place they were given (unless moving to a seat).
          // A pregnant rider with room: between her seat and the one kept.
          if (r.phase === 'seated' && !r.motion) {
            puvLayout(v.kind).seated(r.seat, seat);
            if (typeof r.room === 'number') {
              const beside = puvLayout(v.kind).seated(r.room, newRiderPose());
              seat.x = (seat.x + beside.x) / 2;
              seat.z = (seat.z + beside.z) / 2;
            }
            expect(
              Math.hypot(r.pose.x - seat.x, r.pose.y - seat.y, r.pose.z - seat.z),
            ).toBeLessThan(0.01);
          }
        }
      }
      // Riders on every kind, the capacity of each its seats and standing room,
      // less a seat kept free beside each pregnant rider on board.
      for (const kind of ['modern', 'uv', 'bus'] as const) {
        expect(seen.get(kind)?.size ?? 0, `riders on a ${kind}`).toBeGreaterThan(0);
        for (const v of fleet.vehicles.filter((x) => x.kind === kind)) {
          const kept = [...crew.passengers.values()].filter(
            (r) => r.vehicleId === v.id && typeof r.room === 'number',
          ).length;
          expect(v.capacity).toBe(placesOf(kind) - kept);
        }
      }
      for (const stop of uvBoardedAt) expect(isTerminal(route, stop)).toBe(true);
    },
  );
});
