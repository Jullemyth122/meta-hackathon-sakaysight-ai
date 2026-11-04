import { describe, expect, it } from 'vitest';
import { Box3, Vector3, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { VEHICLES, type VehicleKind } from '@/core/vehicles/specs';
import { ARCH_GAP_M, WALL, type Slot, type VehicleParts } from './bodyKit';
import { createDoorCamera, doorCameras } from './doorCamera';
import { vehicleGeometry } from './vehicleGeometry';
import { zFights } from './zFighting';

const KINDS: VehicleKind[] = ['modern', 'uv', 'bus'];

describe('modern jeepney, UV Express and bus', () => {
  it.each(KINDS)('%s: built to its size, with the seats its spec has', (kind) => {
    const S = VEHICLES[kind];
    const { parts, seats, standing } = vehicleGeometry(kind);
    expect(seats.length).toBe(S.seats);
    expect(standing.length).toBe(S.standing);
    const all = new Box3();
    for (const g of Object.values(parts)) {
      g!.computeBoundingBox();
      all.union(g!.boundingBox!);
    }
    const size = all.getSize(new Vector3());
    // The body to its length (bumpers and mirrors a little beyond), width (mirrors out), height.
    expect(size.x).toBeGreaterThan(S.lengthM - 0.05);
    expect(size.x).toBeLessThan(S.lengthM + 0.65); // a bus's mirrors reach forward
    expect(all.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(all.max.y).toBeGreaterThan(S.heightM - 0.05);
    expect(all.max.y).toBeLessThan(S.heightM + 0.1);
    expect(size.z).toBeLessThan(S.widthM + 0.5);
    // The body sits low between the wheels, which are drawn apart from it (Axle).
    expect(all.min.y).toBeLessThan(S.wheelRadiusM);
    // Every door on the kerb side, within the body, clear of the wheels (or,
    // a van's cab door, its sill above the wheel's arch).
    for (const d of S.doors) {
      expect(d.x0).toBeGreaterThan(-S.lengthM / 2);
      expect(d.x1).toBeLessThan(S.lengthM / 2);
      for (const x of S.axles)
        expect(
          d.x1 < x - S.wheelRadiusM ||
            d.x0 > x + S.wheelRadiusM ||
            d.y0 > 2 * S.wheelRadiusM + ARCH_GAP_M,
        ).toBe(true);
      expect(d.y1 - d.y0).toBeGreaterThan(d.opens === 'hinged' ? 0.9 : 1.5);
    }
  });

  it.each(KINDS)('%s: no z-fighting (no two colours in one face anywhere)', (kind) => {
    const built = vehicleGeometry(kind);
    // With its doors open, and shut.
    for (const doors of [built.doors.open, built.doors.closed]) {
      const all: VehicleParts = { ...built.parts };
      for (const [slot, g] of Object.entries(doors) as [Slot, BufferGeometry][])
        all[slot] = all[slot] ? mergeGeometries([all[slot]!, g]) : g;
      const fights = zFights(all);
      expect(fights.map((f) => `${f.slots.join('/')} at ${f.at.map((c) => c.toFixed(2))}`)).toEqual(
        [],
      );
    }
  });

  it.each(KINDS)('%s: each door camera sees the door, its steps and the floor inside', (kind) => {
    const S = VEHICLES[kind];
    const half = S.widthM / 2;
    for (const cam of doorCameras(kind)) {
      const camera = createDoorCamera(cam);
      const d = cam.door;
      const inFrame = (p: Vector3) => {
        const v = p.clone().project(camera);
        return Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z < 1;
      };
      // The stairs: as many steps as the rise needs, 0.28 m deep (bodyKit).
      const stairs = Math.max(1, Math.ceil((S.floorM - d.y0) / 0.2 - 0.01)) * 0.28;
      for (const x of [d.x0 + 0.15, (d.x0 + d.x1) / 2, d.x1 - 0.15]) {
        // The bottom step at the door edge (someone outside about to board)…
        expect(inFrame(new Vector3(x, d.y0, half - WALL))).toBe(true);
        // …the head of someone on it (1.6 m tall, ducking under a van's low opening),
        // under the camera, which is above the opening…
        const duck = (y: number) => Math.min(y, d.y1 - 0.08);
        const head = new Vector3(x, duck(d.y0 + 1.6), half - 0.15);
        expect(inFrame(head)).toBe(true);
        expect(cam.position.y).toBeGreaterThan(d.y1);
        // …halfway up the stairs, and the floor at the top of them.
        const halfway = new Vector3(x, duck((d.y0 + S.floorM) / 2 + 1.5), half - WALL - stairs / 2);
        expect(inFrame(halfway)).toBe(true);
        expect(inFrame(new Vector3(x, S.floorM, half - WALL - stairs - 0.1))).toBe(true);
      }
      // Under the ceiling, inside the body.
      expect(cam.position.y).toBeLessThan(S.floorM + S.headroomM);
      expect(cam.position.z).toBeLessThan(half - WALL);
    }
  });
});
