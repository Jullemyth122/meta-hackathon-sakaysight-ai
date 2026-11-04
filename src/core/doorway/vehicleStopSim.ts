/**
 * Ground truth for the sensor lab's modern jeepney, UV Express and bus, as
 * DoorwaySim is for the jeepney: one vehicle parked at a stop with riders
 * getting on and off through its own doors. The counting pipelines never read
 * this; they only see what the door cameras see.
 */

import type { Rng } from '../math/random';
import type { PassengerLayout } from '../people/passengerSystem';
import { newRiderPose, type RiderMotion, type RiderPose, type Seat } from '../people/riderMotion';

/** One person at a door at a time. */
const DOOR_GAP_S = 1.6;

interface StopRider {
  id: number;
  seat: number;
  mode: 'boarding' | 'riding' | 'alighting';
  /** Present while boarding or alighting. */
  motion: RiderMotion | null;
  /** Seconds since the current motion started. */
  t: number;
  /** Whether they are on board (truth for counting). */
  inside: boolean;
  /** Per-rider build, so the detector sees varied box sizes. */
  size: number;
}

export class VehicleStopSim {
  /** True counts. The pipelines' estimate is compared against these. */
  readonly truth = { inside: 0, boarded: 0, alighted: 0 };
  private readonly riders: StopRider[] = [];
  private readonly queue: Array<'board' | 'alight'> = [];
  private readonly scratch = newRiderPose();
  private nextId = 1;
  private sinceSpawnS = Infinity;
  private untilNextStopS = 3;

  constructor(
    private readonly rng: Rng,
    private readonly layout: PassengerLayout,
    /** Where boarders walk up from, on the pavement. */
    private readonly pavement: readonly [number, number, number],
    initialRiding = 8,
  ) {
    const seats = Math.min(initialRiding, layout.seatOrder.length);
    for (let k = 0; k < seats; k++) {
      this.riders.push(this.newRider(layout.seatOrder[k]!, 'riding'));
      this.truth.inside++;
    }
  }

  /** Everyone at the vehicle, in its frame. */
  forEachRider(visit: (id: number, pose: RiderPose, place: Seat, size: number) => void): void {
    for (const r of this.riders)
      visit(r.id, this.pose(r, this.scratch), this.layout.seats[r.seat]!, r.size);
  }

  step(dtS: number): void {
    this.scheduleStops(dtS);
    this.sinceSpawnS += dtS;
    if (this.queue.length > 0 && this.sinceSpawnS >= DOOR_GAP_S) this.spawn(this.queue.shift()!);
    for (let i = this.riders.length - 1; i >= 0; i--) {
      const r = this.riders[i]!;
      if (!r.motion) continue;
      r.t += dtS;
      const inside = this.layout.isInside(this.pose(r, this.scratch));
      if (inside !== r.inside) {
        r.inside = inside;
        this.truth.inside += inside ? 1 : -1;
        if (inside) this.truth.boarded++;
        else this.truth.alighted++;
      }
      if (r.t < r.motion.duration) continue;
      if (r.mode === 'alighting') this.riders.splice(i, 1);
      else {
        r.mode = 'riding';
        r.motion = null;
      }
    }
  }

  private pose(r: StopRider, out: RiderPose): RiderPose {
    return r.motion ? r.motion.poseAt(r.t, out) : this.layout.seated(r.seat, out);
  }

  private newRider(seat: number, mode: StopRider['mode']): StopRider {
    return {
      id: this.nextId++,
      seat,
      mode,
      motion: null,
      t: 0,
      inside: mode === 'riding',
      size: 0.93 + this.rng() * 0.11,
    };
  }

  /** A stop: a few people get off, then a few get on. */
  private scheduleStops(dtS: number): void {
    this.untilNextStopS -= dtS;
    if (this.untilNextStopS > 0) return;
    this.untilNextStopS = 12 + this.rng() * 8;
    const off = Math.floor(this.rng() * 3);
    const on = Math.floor(this.rng() * 4);
    for (let k = 0; k < off; k++) this.queue.push('alight');
    for (let k = 0; k < on; k++) this.queue.push('board');
  }

  private spawn(next: 'board' | 'alight'): void {
    if (next === 'board') {
      const taken = new Set(this.riders.map((r) => r.seat));
      const seat = this.layout.seatOrder.find((k) => !taken.has(k));
      if (seat === undefined) return; // full: they wait for the next one
      const r = this.newRider(seat, 'boarding');
      const [x, y, z] = this.pavement;
      // Up the pavement from either side.
      r.motion = this.layout.board(seat, [x + (this.rng() < 0.5 ? -2.5 : 2.5), y, z]);
      this.riders.push(r);
    } else {
      const riding = this.riders.filter((r) => r.mode === 'riding');
      if (riding.length === 0) return;
      const r = riding[Math.floor(this.rng() * riding.length)]!;
      r.mode = 'alighting';
      r.motion = this.layout.alight(r.seat);
      r.t = 0;
    }
    this.sinceSpawnS = 0;
  }
}
