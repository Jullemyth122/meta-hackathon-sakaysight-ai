import { describe, expect, it } from 'vitest';
import { VehicleLabRuntime } from '@/app/doorwayRuntime';
import { TwinRuntime } from '@/app/twinRuntime';
import { sideOf, doorLineOffset, type DoorLineView } from '@/core/doorway/pipeline';
import { FIELD_SCENARIO } from '@/core/fleet/scenario';
import { defaultRoute } from '@/core/geo/routes';
import { VEHICLES, type VehicleKind } from '@/core/vehicles/specs';
import { projectPerson } from '../doorway/cabinCamera';
import { createDoorCamera, doorCameras, doorLineView } from './doorCamera';
import { DoorCounting } from './doorCounting';

const KINDS: VehicleKind[] = ['modern', 'uv', 'bus'];

/** Long enough for a few stops' riders through the doors, even on a bus's long legs. */
const RIDE_S = 30 * 60;

describe('door cameras', () => {
  it.each(KINDS)('%s: the door line falls on the same pixels at any height', (kind) => {
    for (const cam of doorCameras(kind)) {
      const camera = createDoorCamera(cam);
      const view = doorLineView(cam, camera, cam.door.name);
      const { x, z } = cam.position;
      for (const y of [cam.door.y0 + 0.3, cam.door.y0 + 0.9, cam.position.y - 0.25]) {
        const on = projectPerson(camera, 1, x + 0.1, y, z);
        expect(Math.abs(doorLineOffset(on!.cx, on!.cy, view)), `${y} m up`).toBeLessThan(0.5);
      }
    }
  });

  it.each(KINDS)('%s: the cabin is inside the line, the pavement outside it', (kind) => {
    const half = VEHICLES[kind].widthM / 2;
    for (const cam of doorCameras(kind)) {
      const camera = createDoorCamera(cam);
      const view: DoorLineView = doorLineView(cam, camera, cam.door.name);
      const { x } = cam.position;
      const box = (z: number, y: number) => {
        const p = projectPerson(camera, 1, x, y, z);
        expect(p, `seen at z ${z}`).not.toBeNull();
        return { ...p!, score: 1 };
      };
      expect(sideOf(box(half + 0.05, cam.door.y0 + 1), view)).toBe('out');
      expect(sideOf(box(half - 0.6, VEHICLES[kind].floorM + 1.2), view)).toBe('in');
    }
  });

  it.each(KINDS)('%s: counts everyone through its doors in the lab', (kind) => {
    const lab = new VehicleLabRuntime(kind, 9);
    // Long enough for dozens through the doors, at a screen's 60 frames a second.
    for (let f = 0; f < 60 * 300; f++) lab.step(1 / 60);
    const { truth } = lab.sim;
    const { counts } = lab.counting.counter;
    expect(truth.boarded + truth.alighted).toBeGreaterThan(30);
    // Every crossing but the odd one, and the running count stays within a rider or two.
    expect(Math.abs(counts.boarded - truth.boarded)).toBeLessThanOrEqual(
      Math.max(1, truth.boarded * 0.1),
    );
    expect(Math.abs(counts.alighted - truth.alighted)).toBeLessThanOrEqual(
      Math.max(1, truth.alighted * 0.1),
    );
    expect(Math.abs(counts.current - truth.inside)).toBeLessThanOrEqual(2);
    expect(lab.pipeline.telemetry(lab.clockMs).fps).toBeGreaterThan(18);
  });

  it('a bus: boarders at the front door, leavers at the middle one, one count', () => {
    const lab = new VehicleLabRuntime('bus', 3);
    const seenAt = [0, 0];
    for (let f = 0; f < 60 * 120; f++) {
      lab.step(1 / 60);
      lab.counting.pipelines.forEach((p, k) => {
        seenAt[k]! += p.tracker.visible().length > 0 ? 1 : 0;
      });
    }
    expect(seenAt[0]).toBeGreaterThan(0);
    expect(seenAt[1]).toBeGreaterThan(0);
    expect(lab.counting.pipelines[0]!.counter).toBe(lab.counting.pipelines[1]!.counter);
  });

  it.each([
    ['modern', 'jeepney', 1 / 60],
    ['modern', 'jeepney', 1 / 30], // what 30× steps at
    ['bus', 'bus', 1 / 30],
  ] as const)(
    '%s riding along in the twin, %s route, ticks of %f s',
    (kind, routeKind, tick) => {
      const route = { ...defaultRoute(), kind: routeKind };
      const twin = new TwinRuntime(route, undefined, { ...FIELD_SCENARIO, startHour: 7 });
      const { fleet, crew } = twin;
      for (let t = 0; t < 300; t += 0.5) twin.step(0.5, 0);
      const v = fleet.vehicles.find((x) => x.kind === kind && x.duty === 'service')!;
      expect(v.capacity).toBe(VEHICLES[kind].seats + VEHICLES[kind].standing);
      const counting = new DoorCounting(kind, 5, v.occupancy, (see) =>
        crew.forEachRider(v.id, (id, pose) => see(id, pose, 1)),
      );
      twin.doorCounting = counting;
      const moved = { on: 0, off: 0, last: v.occupancy };
      for (let t = 0; t < RIDE_S; t += tick) {
        twin.step(tick, 0);
        if (v.occupancy > moved.last) moved.on += v.occupancy - moved.last;
        else moved.off += moved.last - v.occupancy;
        moved.last = v.occupancy;
      }
      const { counts } = counting.counter;
      expect(moved.on + moved.off, 'riders on and off').toBeGreaterThanOrEqual(4);
      // Within a tenth of everyone who went through the doors, at most.
      expect(Math.abs(counts.current - v.occupancy)).toBeLessThanOrEqual(
        Math.max(2, (moved.on + moved.off) * 0.1),
      );
    },
    120_000,
  );
});
