/**
 * The driver-phone side of the passenger counter, end to end:
 *
 *   ESP32-S3-CAM on the cabin ceiling at the front, looking back over every
 *   seat to the rear entrance (QVGA 320×240 @ ~24 FPS)
 *     → head detector (YOLOv8n with public head weights, e.g. trained on
 *       CrowdHuman / SCUT-HEAD, via TensorFlow.js, 25–40 ms)
 *     → centroid tracker (stable IDs; a briefly missed person is kept)
 *     → in-cabin test (people seen through the rear opening are outside)
 *     → passenger counter (door crossings, corrected by heads in view;
 *       see occupancy.ts)
 *
 * In the simulation the "frame" is the list of people the virtual camera can
 * see, already projected to pixels by the scene. The detector is modelled
 * with the failure modes that matter for counting: misses, centroid jitter,
 * people hidden behind nearer people, and inference latency that can cause
 * dropped frames.
 *
 * Why heads and not COCO-SSD's "person": from the front of a packed jeepney,
 * seated bodies overlap each other along each bench, so whole-person boxes
 * merge and most people are missed. Heads stay separate: the camera is above
 * them, so the farther back a head is, the higher it appears in the frame,
 * clear of the people in front.
 *
 * Swap DetectorModel for a real TF.js model and the rest stays the same.
 */

import { gaussian, type Rng } from '../math/random';
import { CentroidTracker, type Box, type Track } from './centroidTracker';
import { PassengerCounter, type DoorCounts } from './occupancy';

export const FRAME_W = 320;
export const FRAME_H = 240;

/** A person's head as the camera sees it, projected into frame pixels by the scene. */
export interface VisiblePerson {
  agentId: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Distance from the camera, metres. Nearer people hide farther ones. */
  depth?: number;
}

export interface DetectorModel {
  fps: number;
  latencyMs: readonly [number, number];
  /** Probability a fully visible person is not detected in a frame. */
  missRate: number;
  /**
   * Centroid noise as a fraction of box width (1 sigma). Detector error
   * scales with the object: a fixed pixel noise would shake a 5 px head at
   * the back of the cabin by half its size.
   */
  jitter: number;
  /** Covered fraction of a box above which detection starts to fail. */
  occlusionOnset: number;
  /** Looking straight down: nobody's body is in front of anyone's head, so no occlusion. */
  overhead?: boolean;
}

export const ESP32_HEAD_DETECTOR: DetectorModel = {
  fps: 24,
  latencyMs: [25, 40],
  missRate: 0.05,
  jitter: 0.06,
  occlusionOnset: 0.45,
};

/** The same detector over a doorway, looking straight down. */
export const DOOR_HEAD_DETECTOR: DetectorModel = { ...ESP32_HEAD_DETECTOR, overhead: true };

/**
 * What the camera knows about the cabin, from where it is mounted: the rear
 * opening as a rectangle in the frame, and how wide a head in the opening
 * looks. A head inside that rectangle and no bigger than that is outside the
 * jeepney, seen through the door; everyone else is a passenger.
 */
export interface CabinView {
  door: { x0: number; y0: number; x1: number; y1: number };
  doorHeadWidthPx: number;
}

/**
 * Head width relative to one standing in the doorway: below OUTSIDE it is
 * beyond the door, above INSIDE clearly nearer. In between (a head is only
 * ~5 px wide back there) the answer is "unsure" and the person keeps their
 * last side, so pixel noise cannot flip anyone in and out.
 */
const OUTSIDE_WIDTH_RATIO = 1.05;
const INSIDE_WIDTH_RATIO = 1.35;

/**
 * What a door camera knows, from where it is mounted: the line under its lens
 * that a rider crosses going through the door. The line lies in a vertical
 * plane through the lens, so it falls on the same pixels at any height: a
 * short rider, a tall one, someone halfway up the steps.
 */
export interface DoorLineView {
  /** The door, for the picture. */
  name: string;
  /** Two points on the line, in frame pixels. */
  a: { x: number; y: number };
  b: { x: number; y: number };
  /** Which side of a→b the cabin is on (the sign of the cross product). */
  insideSign: 1 | -1;
  /** This close to the line either way (pixels), a head is at the door: unsure. */
  bandPx: number;
}

export type CameraView = CabinView | DoorLineView;

export type Side = 'in' | 'out' | 'unsure';

/** How far a point is from the door line, in pixels: positive on the cabin's side. */
export function doorLineOffset(x: number, y: number, v: DoorLineView): number {
  const dx = v.b.x - v.a.x;
  const dy = v.b.y - v.a.y;
  return (v.insideSign * (dx * (y - v.a.y) - dy * (x - v.a.x))) / Math.hypot(dx, dy);
}

/** Which side of its door a tracked head is on. */
export function sideOf(box: Box, view: CameraView): Side {
  if ('door' in view) return cabinSide(box, view);
  const d = doorLineOffset(box.cx, box.cy, view);
  return d > view.bandPx ? 'in' : d < -view.bandPx ? 'out' : 'unsure';
}

export function cabinSide(box: Box, cabin: CabinView): Side {
  const { door } = cabin;
  const inDoor = box.cx >= door.x0 && box.cx <= door.x1 && box.cy >= door.y0 && box.cy <= door.y1;
  if (!inDoor) return 'in';
  const ratio = box.w / cabin.doorHeadWidthPx;
  return ratio > INSIDE_WIDTH_RATIO ? 'in' : ratio < OUTSIDE_WIDTH_RATIO ? 'out' : 'unsure';
}

export interface PipelineTelemetry {
  /** Frames actually processed in the last second. */
  fps: number;
  /** Mean inference latency over the last second, ms. */
  latencyMs: number;
  /** Frames captured while the detector was still busy, total. */
  dropped: number;
  boxes: readonly Box[];
  tracks: readonly Track[];
  /** Heads in the cabin in the latest frame, and the steady value of that. */
  seenNow: number;
  seenSteady: number;
  counts: Readonly<DoorCounts>;
  view: Readonly<CameraView>;
}

/** Doors that can share a counter: a vehicle has one or two. */
const MAX_DOORS = 8;

interface PendingFrame {
  readyAt: number;
  boxes: Box[];
}

export class CabinPipeline {
  readonly tracker: CentroidTracker;
  readonly counter: PassengerCounter;
  readonly model: DetectorModel;
  readonly view: CameraView;
  private readonly rng: Rng;

  private nextCaptureAt = 0;
  private pending: PendingFrame | null = null;
  private busyUntil = 0;
  private dropped = 0;
  private seenNow = 0;
  private lastBoxes: Box[] = [];
  /** Completion times and latencies, for the rolling one-second stats. */
  private recent: Array<{ t: number; latency: number }> = [];

  /** `start`: the riders on board, or a counter shared with the vehicle's other doors, each with its own `slot`. */
  constructor(
    rng: Rng,
    start: number | PassengerCounter,
    view: CameraView,
    model = ESP32_HEAD_DETECTOR,
    private readonly slot = 0,
  ) {
    this.rng = rng;
    this.view = view;
    this.model = model;
    this.counter = typeof start === 'number' ? new PassengerCounter(start) : start;
    this.tracker = new CentroidTracker(
      // Down the cabin, heads move a few pixels a frame, and a tight jump limit
      // stops neighbouring heads at the back (a few pixels apart) from
      // swapping identities. Under a door camera, heads pass close to the
      // lens: few of them, and quick across the frame.
      'door' in view
        ? { maxJumpPx: 10, maxMissedFrames: 6, maxSizeRatio: 1.4 }
        : { maxJumpPx: 48, maxMissedFrames: 6, maxSizeRatio: 2 },
    );
  }

  /** A track's id for the counter: tracks of each door sharing it stay apart. */
  private counted(track: number): number {
    return track * MAX_DOORS + this.slot;
  }

  /**
   * Call every render frame. `capture` is only invoked when the camera
   * actually takes a frame, so the scene does projection work at ~24 Hz.
   */
  tick(nowMs: number, capture: () => VisiblePerson[]): void {
    if (this.pending && nowMs >= this.pending.readyAt) {
      this.process(this.pending);
      this.pending = null;
    }

    if (nowMs < this.nextCaptureAt) return;
    // Time the frame on the camera's own clock, not the render loop's: the
    // ESP32 does not know our frame rate. (Timing it at the render tick
    // rounds some capture gaps down to two render frames, 33 ms, shorter than
    // inference, and wrongly drops ~1/3 of frames.) After a stall such as a
    // hidden tab, resume from now instead of replaying the missed frames.
    const period = 1000 / this.model.fps;
    const exposedAt = Math.max(this.nextCaptureAt, nowMs - period);
    this.nextCaptureAt = exposedAt + period;

    if (exposedAt < this.busyUntil) {
      this.dropped++;
      return;
    }
    const [lo, hi] = this.model.latencyMs;
    const latency = lo + this.rng() * (hi - lo);
    this.busyUntil = exposedAt + latency;
    this.pending = { readyAt: exposedAt + latency, boxes: this.detect(capture()) };
    this.recent.push({ t: exposedAt + latency, latency });
  }

  telemetry(nowMs: number): PipelineTelemetry {
    // Forget frames older than a second, but keep ones still being inferred
    // (completion time in the future): they count once they finish.
    this.recent = this.recent.filter((r) => r.t > nowMs - 1000);
    const done = this.recent.filter((r) => r.t <= nowMs);
    const latency = done.reduce((sum, r) => sum + r.latency, 0) / (done.length || 1);
    return {
      fps: done.length,
      latencyMs: latency,
      dropped: this.dropped,
      boxes: this.lastBoxes,
      tracks: this.tracker.visible(),
      seenNow: this.seenNow,
      seenSteady: this.counter.heads.value,
      counts: this.counter.counts,
      view: this.view,
    };
  }

  /** Simulated detector output for one captured frame. */
  private detect(people: VisiblePerson[]): Box[] {
    const m = this.model;
    // Nearest first, so we know who is in front of whom.
    const byDepth = [...people].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
    const nearer: VisiblePerson[] = [];
    const boxes: Box[] = [];
    for (const p of byDepth) {
      const hidden = m.overhead ? 0 : coveredFraction(p, nearer);
      nearer.push(p);
      // Past the onset, the chance of a miss climbs to ~95% when fully hidden.
      const occlusion = Math.max(0, (hidden - m.occlusionOnset) / (1 - m.occlusionOnset));
      if (this.rng() < m.missRate + occlusion * 0.9) continue;
      boxes.push({
        cx: p.cx + gaussian(this.rng) * m.jitter * p.w,
        cy: p.cy + gaussian(this.rng) * m.jitter * p.w,
        w: p.w,
        h: p.h,
        score: 0.6 + this.rng() * 0.38,
      });
    }
    return boxes;
  }

  private process(frame: PendingFrame): void {
    this.lastBoxes = frame.boxes;
    for (const id of this.tracker.update(frame.boxes)) this.counter.forget(this.counted(id));
    // Fresh detections only. Counting briefly missed tracks too would count a
    // head twice when the tracker re-acquires it under a new ID; brief misses
    // are already absorbed by the steady count's percentile window.
    const seen = this.tracker
      .visible()
      .map((t) => ({ id: this.counted(t.id), side: sideOf(t, this.view) }));
    this.seenNow = seen.filter((t) => t.side === 'in').length;
    this.counter.frame(frame.readyAt, seen, 'door' in this.view ? this.seenNow : null);
  }
}

/** How far a body extends below its head in the frame, in head heights. */
const BODY_BELOW_HEAD = 2.5;

/**
 * Fraction of head p covered by the people in front of it (capped at 1).
 * A nearer person blocks with their head and with the body below it.
 */
function coveredFraction(p: VisiblePerson, front: readonly VisiblePerson[]): number {
  const area = p.w * p.h;
  if (area <= 0) return 0;
  let covered = 0;
  for (const q of front) {
    const qTop = q.cy - q.h / 2;
    const qBottom = q.cy + q.h / 2 + q.h * BODY_BELOW_HEAD;
    const ox = Math.min(p.cx + p.w / 2, q.cx + q.w / 2) - Math.max(p.cx - p.w / 2, q.cx - q.w / 2);
    const oy = Math.min(p.cy + p.h / 2, qBottom) - Math.max(p.cy - p.h / 2, qTop);
    if (ox > 0 && oy > 0) covered += ox * oy;
  }
  return Math.min(1, covered / area);
}
