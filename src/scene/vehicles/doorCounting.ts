/**
 * Counting riders with a vehicle's door cameras (doorCamera.ts): one pipeline
 * per door, all adding to one count, so a rider in at a bus's front door and
 * out at its middle one comes to nothing.
 *
 * Unlike the jeepney's cabin camera, a door camera sees only the doorway, so
 * there are no heads in the cabin to check the count against: it is the
 * crossings alone, what overhead door counters do.
 *
 * Everything is in the vehicle's own frame (a door camera rides with it, and
 * so do its riders), on the simulation's clock: step() is called with each
 * simulation tick, so a fast-forwarded twin still gives the camera its frames.
 */

import { createRng } from '@/core/math/random';
import { CabinPipeline, DOOR_HEAD_DETECTOR, type VisiblePerson } from '@/core/doorway/pipeline';
import { PassengerCounter } from '@/core/doorway/occupancy';
import { VEHICLES, type VehicleKind } from '@/core/vehicles/specs';
import { projectPerson } from '../doorway/cabinCamera';
import { HEAD_CENTRE_Y } from '../people/personRig';
import { createDoorCamera, doorCameras, doorLineView } from './doorCamera';

/** One person the cameras might see, in the vehicle's frame. */
export type SeePerson = (
  id: number,
  pose: { x: number; y: number; z: number; stoop: number },
  size: number,
) => void;

export class DoorCounting {
  readonly pipelines: readonly CabinPipeline[];
  readonly counter: PassengerCounter;
  /** The door to show: stays on one until nobody is there and someone is at another. */
  shownDoor = 0;
  clockMs = 0;
  private readonly cameras;

  constructor(
    kind: VehicleKind,
    seed: number,
    startingCount: number,
    /** Calls `see` for everyone on the vehicle. */
    private readonly people: (see: SeePerson) => void,
  ) {
    const cams = doorCameras(kind);
    this.cameras = cams.map(createDoorCamera);
    this.counter = new PassengerCounter(startingCount);
    this.pipelines = cams.map(
      (cam, k) =>
        new CabinPipeline(
          createRng(seed + k),
          this.counter,
          doorLineView(cam, this.cameras[k]!, VEHICLES[kind].doors[k]!.name),
          DOOR_HEAD_DETECTOR,
          k,
        ),
    );
  }

  /** One simulation tick of `dtS`. */
  step(dtS: number): void {
    this.clockMs += dtS * 1000;
    this.pipelines.forEach((pipeline, k) =>
      pipeline.tick(this.clockMs, () => {
        const camera = this.cameras[k]!;
        const seen: VisiblePerson[] = [];
        this.people((id, m, size) => {
          const headY = m.y + HEAD_CENTRE_Y * size * m.stoop;
          const p = projectPerson(camera, id, m.x, headY, m.z);
          if (p) seen.push(p);
        });
        return seen;
      }),
    );
    if (this.pipelines[this.shownDoor]!.tracker.visible().length > 0) return;
    const busy = this.pipelines.findIndex((p) => p.tracker.visible().length > 0);
    if (busy >= 0) this.shownDoor = busy;
  }
}
