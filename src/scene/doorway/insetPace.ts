/**
 * How often the camera insets are drawn again. Each is a whole extra render of
 * the scene, so no one rate suits every machine and scene: at a fixed low rate
 * a fast machine shows a slideshow beside a smooth view, and at a high one a
 * packed route loses its frame rate. So the rate follows the room there is:
 * down at once when the view starts to suffer, back up only once it has been
 * well clear of that for a while, or it would hunt up and down.
 */

/** From smoothest to cheapest. `esp` is a share of the real camera's frame rate. */
export const INSET_PACES = [
  { mirror: 30, esp: 1 },
  { mirror: 20, esp: 0.75 },
  { mirror: 12, esp: 0.5 },
] as const;

/** Below this many frames a second the insets slow down… */
const SLOW_DOWN_UNDER_FPS = 45;
/** …and over this, held for HOLD_S, they speed up again. */
const SPEED_UP_OVER_FPS = 54;
const HOLD_S = 2;
/** After slowing down, how long before looking again: the change takes a moment to show. */
const SETTLE_S = 0.75;
/** Share of each frame in the running average of frame time. */
const SMOOTHING = 0.1;
/** A frame longer than this (a tab coming back, a hitch) says nothing about the scene. */
const LONGEST_FRAME_S = 0.2;

export class InsetPace {
  private level = 1;
  private frameS = 1 / 60;
  private clearS = 0;
  private settleS = 0;

  /** The rates to draw at now. */
  get rates(): (typeof INSET_PACES)[number] {
    return INSET_PACES[this.level]!;
  }

  /** Note a frame that took `dt` seconds. */
  update(dt: number): void {
    if (dt <= 0 || dt > LONGEST_FRAME_S) return;
    this.frameS += (dt - this.frameS) * SMOOTHING;
    this.settleS = Math.max(0, this.settleS - dt);
    const fps = 1 / this.frameS;
    if (fps < SLOW_DOWN_UNDER_FPS) {
      this.clearS = 0;
      if (this.settleS > 0 || this.level === INSET_PACES.length - 1) return;
      this.level++;
      this.settleS = SETTLE_S;
      return;
    }
    this.clearS = fps > SPEED_UP_OVER_FPS ? this.clearS + dt : 0;
    if (this.clearS >= HOLD_S && this.level > 0) {
      this.level--;
      this.clearS = 0;
    }
  }
}
