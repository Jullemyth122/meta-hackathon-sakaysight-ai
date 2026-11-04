/**
 * From tracked heads to a passenger count, with two independent signals:
 *
 *   door transitions  a track that goes from "outside, seen through the rear
 *                     opening" to "in the cabin" is a boarding, and back is
 *                     an alighting. People walking the aisle are standing,
 *                     so they are visible above the seated rows.
 *   heads in view     a steady count of heads seen in the cabin. Seated
 *                     people at the back hide behind those in front, so this
 *                     undercounts a full jeepney; it is a lower bound that
 *                     corrects missed boardings.
 *
 * current = start + boarded - alighted, raised whenever the heads in view say
 * there must be more. A door camera (a modern jeepney's, UV Express's or
 * bus's) sees only the doorway, so it has the crossings alone: headsInCabin
 * null. Several doors can share one counter (see frame).
 */

export interface DoorCounts {
  /** Riders the camera believes are inside. */
  current: number;
  boarded: number;
  alighted: number;
  /** Times the head count raised the estimate (a boarding was missed). */
  corrections: number;
}

export interface SteadyConfig {
  /** Frames in the rolling window (~1 s at 24 FPS). */
  windowFrames: number;
  /** Percentile of the window taken as the count (0..1). */
  percentile: number;
  /** How long a new value must hold before it is accepted, ms. */
  holdMs: number;
}

export const DEFAULT_STEADY: SteadyConfig = { windowFrames: 24, percentile: 0.8, holdMs: 600 };

/**
 * A per-frame count made steady: the 80th percentile of the last second
 * (brief misses do not pull it down), changed only once the new value has
 * held for 0.6 s (a flicker never shows).
 */
export class SteadyCount {
  value: number;
  private readonly cfg: SteadyConfig;
  private readonly window: number[] = [];
  private candidate: number | null = null;
  private candidateSince = 0;

  constructor(initial = 0, cfg: SteadyConfig = DEFAULT_STEADY) {
    this.value = initial;
    this.cfg = cfg;
  }

  push(nowMs: number, n: number): void {
    this.window.push(n);
    if (this.window.length > this.cfg.windowFrames) this.window.shift();
    const sorted = [...this.window].sort((a, b) => a - b);
    const level = sorted[Math.floor(this.cfg.percentile * (sorted.length - 1))]!;
    if (level === this.value) {
      this.candidate = null;
    } else if (level !== this.candidate) {
      this.candidate = level;
      this.candidateSince = nowMs;
    } else if (nowMs - this.candidateSince >= this.cfg.holdMs) {
      this.value = level;
      this.candidate = null;
    }
  }
}

/** Frames a track must stay on the new side before its crossing counts. */
const CONFIRM_FRAMES = 3;

interface TrackSide {
  inside: boolean;
  /** Consecutive frames seen on the other side. */
  flip: number;
}

/** Counts tracks crossing between "outside the door" and "in the cabin". */
export class DoorTransitions {
  private readonly sides = new Map<number, TrackSide>();

  /**
   * Returns the crossing this observation completes, if any. 'unsure' keeps
   * the track's current side and does not count towards a flip.
   */
  observe(trackId: number, side: 'in' | 'out' | 'unsure'): 'board' | 'alight' | null {
    const s = this.sides.get(trackId);
    if (side === 'unsure') return null;
    const inside = side === 'in';
    if (!s) {
      // First sighting: no crossing yet, we do not know where it came from.
      this.sides.set(trackId, { inside, flip: 0 });
      return null;
    }
    if (inside === s.inside) {
      s.flip = 0;
      return null;
    }
    if (++s.flip < CONFIRM_FRAMES) return null;
    s.inside = inside;
    s.flip = 0;
    return inside ? 'board' : 'alight';
  }

  forget(trackId: number): void {
    this.sides.delete(trackId);
  }
}

/** Combines the two signals into DoorCounts (see the file comment). */
export class PassengerCounter {
  readonly counts: DoorCounts;
  readonly heads: SteadyCount;
  private readonly door = new DoorTransitions();
  private base: number;

  constructor(startingCount = 0, cfg: SteadyConfig = DEFAULT_STEADY) {
    this.base = startingCount;
    this.heads = new SteadyCount(startingCount, cfg);
    this.counts = { current: startingCount, boarded: 0, alighted: 0, corrections: 0 };
  }

  /**
   * One processed frame: each freshly detected track with its side of the
   * door, and how many heads are in the cabin (including briefly missed
   * ones), null when the camera cannot tell. Ids must be unique across every
   * camera sharing this counter.
   */
  frame(
    nowMs: number,
    tracks: ReadonlyArray<{ id: number; side: 'in' | 'out' | 'unsure' }>,
    headsInCabin: number | null,
  ): void {
    for (const t of tracks) {
      const event = this.door.observe(t.id, t.side);
      if (event === 'board') this.counts.boarded++;
      else if (event === 'alight') this.counts.alighted++;
    }
    const fromDoor = this.base + this.counts.boarded - this.counts.alighted;
    if (headsInCabin !== null) this.heads.push(nowMs, headsInCabin);
    if (headsInCabin !== null && this.heads.value > fromDoor) {
      this.base += this.heads.value - fromDoor;
      this.counts.corrections++;
    }
    this.counts.current = Math.max(0, this.base + this.counts.boarded - this.counts.alighted);
  }

  forget(trackId: number): void {
    this.door.forget(trackId);
  }
}
