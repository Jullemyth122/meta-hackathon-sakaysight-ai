/**
 * The virtual ESP32-S3-CAM (Notes.md, sim item 1), 4:3 to match a QVGA
 * 320×240 frame, mounted on the cabin ceiling at the front (above the
 * driver's shoulder) and looking back over both benches to the rear entrance.
 *
 * A wide-angle lens (OV2640 modules ship with 120°/160° options) is needed to
 * see the front seats beside the camera and the door 4 m away in one frame.
 * The driver sits below and in front of the lens, at the bottom edge of the
 * frame, and is masked out of the count (a fixed region on the real device).
 *
 * Everything here is in the jeepney's ground frame. In the live twin the same
 * camera rides on a moving jeepney: see placeOnVehicle().
 */

import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { FRAME_H, FRAME_W, type CabinView, type VisiblePerson } from '@/core/doorway/pipeline';
import { BODY_LIFT, REAR_X } from '../jeepney/jeepneyGeometry';

export const CABIN_CAM = {
  position: new Vector3(1.2, 2.12, 0),
  lookAt: new Vector3(-3.3, 0.9, 0),
  /** Vertical field of view, degrees (≈116° horizontal at 4:3). */
  vfov: 100,
} as const;

/** Half the width of a head, metres (what the head detector boxes). */
const HEAD_HALF_WIDTH = 0.1;

/** The rear opening: floor to header, between the posts. */
const DOOR = { x: REAR_X, y0: BODY_LIFT + 0.06, y1: BODY_LIFT + 1.42, halfWidth: 0.45 };

/** Camera placed in the jeepney's own frame (jeepney at the origin, facing +X). */
export function createCabinCamera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(CABIN_CAM.vfov, FRAME_W / FRAME_H, 0.05, 30);
  cam.position.copy(CABIN_CAM.position);
  cam.lookAt(CABIN_CAM.lookAt);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

const local = createCabinCamera().matrix.clone();
const placed = new Matrix4();

/** Move `cam` to its mount on a jeepney whose ground transform is `vehicle`. */
export function placeOnVehicle(cam: PerspectiveCamera, vehicle: Matrix4): void {
  placed.multiplyMatrices(vehicle, local);
  placed.decompose(cam.position, cam.quaternion, cam.scale);
  cam.scale.set(1, 1, 1);
  cam.updateMatrixWorld();
}

const ndc = new Vector3();
export const toPixels = (v: Vector3) => ({
  x: ((v.x + 1) / 2) * FRAME_W,
  y: ((1 - v.y) / 2) * FRAME_H,
});

/**
 * Where the rear opening and a person standing in it appear in the frame.
 * Uses the camera in the jeepney frame; the view is rigid with the jeepney,
 * so this holds for every jeepney in the twin as well.
 */
export function cabinViewFor(cam: PerspectiveCamera): CabinView {
  const corner = (y: number, z: number) => toPixels(ndc.set(DOOR.x, y, z).project(cam));
  const a = corner(DOOR.y1, -DOOR.halfWidth);
  const b = corner(DOOR.y0, DOOR.halfWidth);
  const l = toPixels(ndc.set(DOOR.x, 1.6, -HEAD_HALF_WIDTH).project(cam));
  const r = toPixels(ndc.set(DOOR.x, 1.6, HEAD_HALF_WIDTH).project(cam));
  return {
    door: {
      x0: Math.min(a.x, b.x),
      x1: Math.max(a.x, b.x),
      y0: Math.min(a.y, b.y),
      y1: Math.max(a.y, b.y),
    },
    doorHeadWidthPx: Math.abs(r.x - l.x),
  };
}

const p = new Vector3();

/**
 * Project a person's head into the frame (sim item 4:
 * `vector.project(espCamera)`). World coordinates. Returns null off-frame.
 */
export function projectPerson(
  cam: PerspectiveCamera,
  agentId: number,
  x: number,
  headY: number,
  z: number,
): VisiblePerson | null {
  p.set(x, headY, z);
  const depth = p.distanceTo(cam.position);
  ndc.copy(p).project(cam);
  if (ndc.z < -1 || ndc.z > 1) return null; // behind the lens or too far
  const c = toPixels(ndc);
  if (c.x < 0 || c.x > FRAME_W || c.y < 0 || c.y > FRAME_H) return null;

  // Head size at that distance, in pixels (focal length from the vertical FOV).
  const focalPx = FRAME_H / 2 / Math.tan((cam.fov * Math.PI) / 360);
  const halfWidthPx = (HEAD_HALF_WIDTH / depth) * focalPx;
  return { agentId, cx: c.x, cy: c.y, w: halfWidthPx * 2, h: halfWidthPx * 2.4, depth };
}
