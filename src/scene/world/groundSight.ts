/**
 * The ground a camera really sees, for choosing what to draw on it: its
 * footprint from where the camera is and how it points. Not a radius around
 * the map controls' target: zooming at a low angle (under 20° from the
 * horizon) leaves that target behind, and a tilted view sees far past it.
 */

import { Vector3, type Camera } from 'three';

/** Out to this far from the camera (metres): beyond it, the view is haze at the horizon. */
const HORIZON_M = 15_000;
/**
 * Beyond the frame's edges, in frame widths from its centre (1 is the edge),
 * so what is about to come into view is there before it does.
 */
const EDGE_MARGIN = 1.3;

export class GroundSight {
  /** Directly under the camera. */
  x = 0;
  z = 0;
  /** The ground at the middle of the view. */
  midX = 0;
  midZ = 0;
  /** Around everything seen. */
  minX = 0;
  maxX = 0;
  minZ = 0;
  maxZ = 0;
  /** Whether the last point sees() said yes to is in the frame itself, not only near it. */
  framed = false;

  private readonly eye = new Vector3();
  private readonly look = new Vector3();
  private readonly ray = new Vector3();
  private readonly p = new Vector3();
  private camera: Camera | null = null;

  /** Take the camera's view as it is now. */
  update(camera: Camera): void {
    this.camera = camera;
    camera.updateMatrixWorld();
    camera.getWorldPosition(this.eye);
    camera.getWorldDirection(this.look);
    this.x = this.minX = this.maxX = this.eye.x;
    this.z = this.minZ = this.maxZ = this.eye.z;
    const down = this.look.y < -0.02 ? -this.eye.y / this.look.y : HORIZON_M;
    const reach = Math.min(down, HORIZON_M);
    this.midX = this.eye.x + this.look.x * reach;
    this.midZ = this.eye.z + this.look.z * reach;
    for (const [u, v] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      this.ray
        .set(u * EDGE_MARGIN, v * EDGE_MARGIN, 0.5)
        .unproject(camera)
        .sub(this.eye);
      // Down onto the ground; a corner at or above the horizon reaches its limit.
      const toGround = this.ray.y < 0 ? -this.eye.y / this.ray.y : Infinity;
      const flat = Math.hypot(this.ray.x, this.ray.z);
      const k = flat > 0 ? Math.min(toGround, HORIZON_M / flat) : toGround;
      const x = this.eye.x + this.ray.x * (Number.isFinite(k) ? k : 0);
      const z = this.eye.z + this.ray.z * (Number.isFinite(k) ? k : 0);
      this.minX = Math.min(this.minX, x);
      this.maxX = Math.max(this.maxX, x);
      this.minZ = Math.min(this.minZ, z);
      this.maxZ = Math.max(this.maxZ, z);
    }
  }

  /** Metres from the point under the camera. */
  away(x: number, z: number): number {
    return Math.hypot(x - this.x, z - this.z);
  }

  /** Whether the camera sees ground point (x, z) (or nearly: see EDGE_MARGIN). */
  sees(x: number, z: number): boolean {
    if (this.away(x, z) > HORIZON_M) return false;
    this.p.set(x, 0, z);
    // Behind the camera, the projection below would mirror it into view.
    const ahead =
      (x - this.eye.x) * this.look.x +
      (0 - this.eye.y) * this.look.y +
      (z - this.eye.z) * this.look.z;
    if (ahead <= 0) return false;
    this.p.project(this.camera!);
    const edge = Math.max(Math.abs(this.p.x), Math.abs(this.p.y));
    this.framed = edge <= 1;
    return edge <= EDGE_MARGIN;
  }
}
