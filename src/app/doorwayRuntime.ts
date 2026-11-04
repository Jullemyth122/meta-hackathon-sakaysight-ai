/**
 * The sensor lab's state: ground-truth riders (DoorwaySim) and the counting
 * pipeline that only sees the virtual cabin camera. Comparing the two is the
 * point.
 */

import { DoorwaySim } from '@/core/doorway/doorwaySim';
import { CabinPipeline } from '@/core/doorway/pipeline';
import { VehicleStopSim } from '@/core/doorway/vehicleStopSim';
import { createRng } from '@/core/math/random';
import { VEHICLES, type VehicleKind } from '@/core/vehicles/specs';
import { CABIN, SEATS_AT } from '@/scene/jeepney/crew';
import { cabinViewFor, createCabinCamera } from '@/scene/doorway/cabinCamera';
import { DoorCounting } from '@/scene/vehicles/doorCounting';
import { puvLayout } from '@/scene/vehicles/puvCrew';

/** What a picture-in-picture camera feed shows: a pipeline and its clock. */
export interface CameraFeed {
  pipeline: CabinPipeline | null;
  /** Simulation clock in ms. Not wall time, so a hidden tab does not skew FPS. */
  clockMs: number;
}

/** The lab's modern jeepney, UV Express or bus: its riders and door cameras. */
export class VehicleLabRuntime implements CameraFeed {
  readonly sim: VehicleStopSim;
  readonly counting: DoorCounting;
  /** The door whose camera is shown. */
  door = 0;

  constructor(kind: VehicleKind, seed: number) {
    const S = VEHICLES[kind];
    const door = S.doors[0]!;
    this.sim = new VehicleStopSim(createRng(seed), puvLayout(kind), [
      (door.x0 + door.x1) / 2,
      0,
      S.widthM / 2 + 1.1,
    ]);
    this.counting = new DoorCounting(kind, seed + 1, this.sim.truth.inside, (see) =>
      this.sim.forEachRider((id, pose, _place, size) => see(id, pose, size)),
    );
  }

  get pipeline(): CabinPipeline {
    return this.counting.pipelines[Math.min(this.door, this.counting.pipelines.length - 1)]!;
  }

  get clockMs(): number {
    return this.counting.clockMs;
  }

  step(dtS: number): void {
    this.sim.step(dtS);
    this.counting.step(dtS);
  }
}

export class DoorwayRuntime implements CameraFeed {
  readonly sim: DoorwaySim;
  readonly pipeline: CabinPipeline;
  clockMs = 0;

  constructor(seed = 7) {
    this.sim = new DoorwaySim(createRng(seed), CABIN, SEATS_AT);
    this.pipeline = new CabinPipeline(
      createRng(seed + 1),
      this.sim.truth.inside,
      cabinViewFor(createCabinCamera()),
    );
  }

  private readonly vehicles = new Map<VehicleKind, VehicleLabRuntime>();

  /** The lab's vehicle of this kind, going on where it left off. */
  vehicleLab(kind: VehicleKind): VehicleLabRuntime {
    let lab = this.vehicles.get(kind);
    if (!lab) this.vehicles.set(kind, (lab = new VehicleLabRuntime(kind, 40)));
    return lab;
  }
}
