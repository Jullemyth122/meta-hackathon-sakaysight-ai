/**
 * Traditional Philippine jeepney, built from primitives and merged per
 * material slot. Ported from the original prototype bundle (index.html).
 *
 * Local frame: metres, +X toward the hood, +Y up, ±Z the sides.
 * The body origin sits on the axle line; BODY_LIFT raises it above the
 * wheels. The open rear entrance is at x = REAR_X between z = ±0.45.
 *
 * Built once, cached, shared by every jeepney in the scene.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Matrix4,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import { arch, box, cylinder, mergeParts, roundedBox as rbox } from './geometryKit';

export const REAR_X = -3.1;
export const FRONT_CABIN_X = 1.75;
export const HALF_WIDTH = 1;
export const WALL = 0.06;
/** Body floor height above the ground. */
export const BODY_LIFT = 0.62;
export const WHEEL_RADIUS = 0.38;
/** Top of the bench cushions, body-local (low, like the real thing: ~40 cm). */
export const SEAT_TOP = 0.4;
/**
 * Ground-frame height of a seated person's root (feet frame, personRig.ts):
 * hips (0.74 above the root) rest on the cushion, thighs sinking in 7 cm.
 */
export const SEATED_ROOT_Y = BODY_LIFT + SEAT_TOP + 0.07 - 0.74;
/**
 * Driver's seat, ground frame: behind the wheel on the left (right-hand
 * traffic). x is where the driver's hips sit: the seat back's front face
 * (0.86) plus the depth of the torso behind the hip joint, so the driver's
 * back rests against the seat instead of passing through it.
 */
export const DRIVER_SEAT = { x: 1.0, z: -0.46 } as const;

/**
 * Steering wheel (body-local). It is raked like a real one: the face points
 * up and back at the driver's chest, the top of the rim is farther away than
 * the bottom, and the column runs from the hub forward and down into the
 * dashboard. It is drawn separately from the body so it can turn.
 */
export const STEERING = {
  centre: new Vector3(1.3, 0.68, -0.46),
  /** Angle of the wheel's axis above horizontal. */
  rake: (40 * Math.PI) / 180,
  radius: 0.175,
} as const;

/**
 * Wheel frame → body-local: x = across the wheel toward +Z (the driver's
 * right: facing +X with +Y up, right is +Z), y = "up" along the face toward
 * the top of the rim, z = the axis, pointing at the driver. The driver sees
 * this frame from its +z side, so a positive rotation about z turns the wheel
 * counter-clockwise (steering left).
 */
export const STEERING_FRAME = (() => {
  const { rake, centre } = STEERING;
  const across = new Vector3(0, 0, 1);
  const up = new Vector3(Math.sin(rake), Math.cos(rake), 0);
  const axis = new Vector3(-Math.cos(rake), Math.sin(rake), 0);
  return new Matrix4().makeBasis(across, up, axis).setPosition(centre);
})();

const rim = new Vector3();

/**
 * A point on the rim, ground frame of the jeepney: `angle` from the top of
 * the rim toward the driver's right, on a wheel turned by `turn` (radians,
 * + = clockwise as the driver sees it, i.e. steering right). Clockwise moves
 * the top of the rim to the right, so the point's angle grows by `turn`.
 */
export function rimPoint(angle: number, turn: number, out: Vector3): Vector3 {
  const a = angle + turn;
  // A hand grips the rim from the driver's side, a couple of centimetres proud of it.
  rim.set(STEERING.radius * Math.sin(a), STEERING.radius * Math.cos(a), 0.03);
  out.copy(rim).applyMatrix4(STEERING_FRAME);
  out.y += BODY_LIFT;
  return out;
}

let cachedSteering: BufferGeometry | null = null;

/** The turning part of the steering wheel (rim, three spokes, hub) in the wheel frame. */
export function steeringWheelGeometry(): BufferGeometry {
  if (cachedSteering) return cachedSteering;
  const r = STEERING.radius;
  const parts: BufferGeometry[] = [new TorusGeometry(r, 0.022, 10, 32)];
  for (const a of [Math.PI / 2, -Math.PI / 2, Math.PI]) {
    // Spokes at 9, 3 and 6 o'clock, from the hub to the rim.
    const spoke = new BoxGeometry(0.03, r, 0.014);
    spoke.translate(0, r / 2, 0);
    spoke.rotateZ(a);
    parts.push(spoke);
  }
  const hub = new CylinderGeometry(0.045, 0.05, 0.05, 16);
  hub.rotateX(Math.PI / 2);
  parts.push(hub);
  cachedSteering = mergeParts(parts)!;
  return cachedSteering;
}

export type PartSlot =
  | 'body'
  | 'accent'
  | 'accent2'
  | 'trim'
  | 'dark'
  | 'interior'
  | 'seat'
  | 'chrome'
  | 'glass'
  | 'lamp'
  | 'tail'
  | 'sign';

export type JeepneyParts = Partial<Record<PartSlot, BufferGeometry>>;
export type WheelParts = { tire: BufferGeometry; hub: BufferGeometry };

let cachedBody: JeepneyParts | null = null;
let cachedWheels: WheelParts | null = null;

export function jeepneyBody(): JeepneyParts {
  if (cachedBody) return cachedBody;

  const P: Record<PartSlot, BufferGeometry[]> = {
    body: [],
    accent: [],
    accent2: [],
    trim: [],
    dark: [],
    interior: [],
    seat: [],
    chrome: [],
    glass: [],
    lamp: [],
    tail: [],
    sign: [],
  };
  const xr = REAR_X;
  const xf = FRONT_CABIN_X;
  const W = HALF_WIDTH;
  const t = WALL;

  P.dark.push(box(-3.02, 3, -0.16, 0.02, -0.78, 0.78)); // chassis underside
  P.interior.push(box(xr + 0.05, xf, 0, 0.06, -W + 0.05, W - 0.05)); // cabin floor

  for (const side of [-1, 1]) {
    const outer = side * W;
    const inner = side * (W - t);

    // Side wall: passenger section (xr..0.82) and deep U-shaped step-in front cab doorway (0.82..1.46).
    P.body.push(rbox(xr, 0.82, 0, 0.8, inner, outer, 0.02));
    P.body.push(box(0.8, 1.48, 0, 0.16, inner, outer)); // low step-in threshold for front cab
    P.body.push(rbox(1.46, xf, 0, 0.8, inner, outer, 0.02)); // front cowl below windshield
    // Angled front door jamb wedge from (1.38, 0.16) up to (1.48, 0.80).
    const jamb = new BoxGeometry(0.14, 0.66, t);
    jamb.rotateZ(-0.22);
    jamb.translate(1.43, 0.46, (inner + outer) / 2);
    P.body.push(jamb);

    // Chrome tubular trim outlining the U-shaped front cab doorway (like real jeepney cab doors).
    P.chrome.push(cylinder(0.018, 0.018, 1.26, 8, 'y', 0.82, 0.79, outer));
    P.chrome.push(cylinder(0.018, 0.018, 0.56, 8, 'x', 1.1, 0.16, outer));
    const frontTrim = new BoxGeometry(0.032, 0.68, 0.032);
    frontTrim.rotateZ(-0.22);
    frontTrim.translate(1.38, 0.48, outer);
    P.chrome.push(frontTrim);

    P.accent.push(
      box(xr - 0.006, 0.82, 0.12, 0.22, outer - side * 0.02, outer + side * 0.012),
      box(1.46, xf + 0.006, 0.12, 0.22, outer - side * 0.02, outer + side * 0.012),
    );
    P.accent2.push(box(xr - 0.012, 0.82, 0.72, 0.8, outer - side * 0.03, outer + side * 0.022));
    // Passenger window pillars stop at the B-pillar (x = 0.78), leaving the front cab doorway wide open.
    for (let k = 0; k <= 6; k++) {
      const x = xr + 0.06 + (k * (0.76 - (xr + 0.06))) / 6;
      P.body.push(box(x - 0.048, x + 0.048, 0.8, 1.42, inner, outer));
    }
    P.body.push(box(0.74, 0.82, 0.16, 1.42, inner, outer)); // B-pillar behind driver/front seat
    P.body.push(box(xr, xf, 1.42, 1.64, inner, outer));
    P.accent.push(
      box(xr - 0.006, xf + 0.006, 1.48, 1.54, outer - side * 0.02, outer + side * 0.012),
    );

    // Long benches facing each other: thick glossy vinyl cushion and backrest
    // with a rolled top, on a painted metal base with round vent holes.
    const cushionIn = side * (W - 0.47);
    P.seat.push(
      rbox(xr + 0.15, 0.7, SEAT_TOP - 0.12, SEAT_TOP, cushionIn, side * (W - 0.06), 0.05),
    );
    P.seat.push(
      rbox(xr + 0.15, 0.7, SEAT_TOP + 0.04, 0.86, side * (W - 0.17), side * (W - 0.06), 0.04),
    );
    P.seat.push(
      cylinder(0.055, 0.055, 0.7 - xr - 0.2, 10, 'x', (xr + 0.7) / 2, 0.86, side * (W - 0.115)),
    );
    P.trim.push(
      box(xr + 0.2, 0.65, 0.06, SEAT_TOP - 0.12, cushionIn + side * 0.02, cushionIn + side * 0.05),
    );
    for (let x = xr + 0.32; x < 0.6; x += 0.13) {
      P.dark.push(cylinder(0.026, 0.026, 0.02, 10, 'z', x, 0.17, cushionIn + side * 0.015));
    }
    // Chrome strip along the passenger window sill, cove where the wall meets the ceiling.
    P.chrome.push(box(xr + 0.1, 0.8, 0.86, 0.885, side * (W - 0.075), side * (W - 0.045)));
    const cove = new BoxGeometry(xf - xr - 0.1, 0.02, 0.3);
    cove.rotateX(side * (Math.PI / 4));
    cove.translate((xr + xf) / 2, 1.52, side * (W - 0.16));
    P.chrome.push(cove);

    // Rear: tail lamps, grab bar, panels either side of the open entrance.
    P.tail.push(box(xr - 0.035, xr + 0.01, 0.42, 0.62, side * 0.88 - 0.07, side * 0.88 + 0.07));
    P.chrome.push(cylinder(0.025, 0.025, 1.3, 8, 'y', xr - 0.06, 0.78, side * 0.45));
    P.body.push(box(xr, xr + t, 0, 0.8, side * 0.45, outer));
    P.body.push(box(xr, xr + t, 0.8, 1.42, side * 0.86, outer));

    // Mirrors on A-pillars, smooth front fenders, headlamps, sign posts.
    P.dark.push(box(1.82, 1.88, 0.96, 1.24, side * 1.12, side * 1.28));
    P.chrome.push(cylinder(0.012, 0.012, 0.24, 8, 'z', 1.84, 1.04, side * 1.05));
    P.body.push(box(1.66, 1.78, 0.8, 1.64, side * 0.88, outer));
    arch(P.trim, 2.12, -0.16, 0.46, 0.06, side * 0.79, side * 1.04, 0.1, Math.PI - 0.1, 14);
    P.chrome.push(cylinder(0.15, 0.15, 0.06, 20, 'x', 3.02, 0.5, side * 0.58));
    P.lamp.push(cylinder(0.12, 0.12, 0.06, 20, 'x', 3.05, 0.5, side * 0.58));
    P.chrome.push(cylinder(0.02, 0.02, 0.14, 6, 'y', 1.99, 1.82, side * 0.6));
  }

  // Headers, chrome-trimmed windshield, dual wipers, rearview mirror, roof, and framed signboard.
  P.body.push(box(xr, xr + t, 1.42, 1.64, -W, W));
  P.body.push(box(1.7, 1.8, 1.48, 1.64, -W, W));
  P.chrome.push(box(1.72, 1.79, 0.8, 0.84, -0.92, 0.92)); // bottom chrome windshield sill
  P.chrome.push(box(1.72, 1.79, 1.46, 1.5, -0.92, 0.92)); // top chrome windshield sill
  P.body.push(box(1.72, 1.78, 0.82, 1.48, -0.025, 0.025)); // center windshield divider
  P.glass.push(box(1.735, 1.765, 0.82, 1.48, -0.9, 0.9));
  // Dual black windshield wiper blades resting on the glass.
  for (const wz of [-0.46, 0.42]) {
    const wiper = new BoxGeometry(0.015, 0.44, 0.018);
    wiper.rotateX(0.12);
    wiper.translate(1.775, 1.05, wz);
    P.dark.push(wiper);
  }
  // Interior rearview mirror mounted to upper windshield header.
  P.chrome.push(cylinder(0.008, 0.008, 0.08, 6, 'y', 1.64, 1.44, -0.2));
  P.dark.push(rbox(1.61, 1.65, 1.36, 1.42, -0.32, -0.08, 0.01));

  // Clean flush matte-black dashboard + lower footwell firewall (no floating items).
  P.dark.push(rbox(1.44, 1.75, 0.56, 0.82, -0.92, 0.92, 0.025)); // flush black dashboard
  P.dark.push(box(1.56, 1.75, 0.06, 0.58, -0.92, 0.92)); // lower firewall / footwell
  for (const gz of [-0.52, -0.4, -0.28]) {
    P.chrome.push(cylinder(0.032, 0.032, 0.016, 14, 'x', 1.44, 0.7, gz));
    P.dark.push(cylinder(0.025, 0.025, 0.02, 14, 'x', 1.436, 0.7, gz));
  }

  P.body.push(rbox(xr - 0.12, 2.22, 1.64, 1.77, -1.08, 1.08, 0.045));
  P.accent2.push(box(xr - 0.125, 2.225, 1.63, 1.68, -1.085, 1.085));
  P.chrome.push(rbox(1.9, 2.08, 1.86, 2.2, -0.88, 0.88, 0.02)); // chrome signboard frame
  P.sign.push(rbox(1.91, 2.09, 1.88, 2.18, -0.85, 0.85, 0.015));

  // Long hood, center chrome trim spear, and chrome grille.
  P.accent.push(rbox(1.75, 3.02, 0.04, 0.84, -0.8, 0.8, 0.07));
  P.chrome.push(rbox(1.85, 2.98, 0.835, 0.86, -0.022, 0.022, 0.01)); // sleek center hood spear
  P.dark.push(box(3, 3.065, 0.18, 0.74, -0.4, 0.4));
  for (let k = 0; k < 7; k++) {
    const z = -0.3 + k * 0.1;
    P.body.push(box(3.03, 3.095, 0.22, 0.7, z - 0.024, z + 0.024));
  }
  P.chrome.push(box(3.02, 3.085, 0.74, 0.79, -0.43, 0.43));
  P.chrome.push(box(3.02, 3.085, 0.13, 0.18, -0.43, 0.43));

  // Bumpers and the rear boarding step.
  P.trim.push(rbox(3.08, 3.3, -0.22, 0.1, -1.16, 1.16, 0.04));
  P.trim.push(rbox(-3.28, -3.06, -0.2, 0, -1.02, 1.02, 0.03));
  P.trim.push(box(-3.52, -3.1, -0.22, -0.16, -0.58, 0.58));

  // Driver's area. The steering wheel itself turns, so it is drawn on its own
  // (steeringWheelGeometry); the column is fixed: along the wheel's axis from
  // the hub forward and down into the dashboard.
  const column = new BoxGeometry(0.044, 0.044, 0.36);
  column.translate(0, 0, -0.2);
  column.applyMatrix4(STEERING_FRAME);
  P.dark.push(column);

  // Floor gear shifter lever and knob connected to the cabin floor.
  const shifter = new BoxGeometry(0.018, 0.44, 0.018);
  shifter.rotateZ(-0.15);
  shifter.translate(1.16, 0.26, -0.11);
  P.chrome.push(shifter);
  P.dark.push(cylinder(0.026, 0.022, 0.04, 12, 'y', 1.13, 0.48, -0.11));

  // Front cab seats (dark base + cushioned seat and backrest + chrome support frame).
  P.trim.push(rbox(0.84, 1.18, 0.16, 0.26, -0.84, -0.12, 0.02));
  P.seat.push(rbox(0.82, 1.2, 0.25, 0.36, -0.84, -0.12, 0.03));
  P.seat.push(rbox(0.76, 0.86, 0.35, 0.94, -0.82, -0.14, 0.025));
  P.chrome.push(rbox(0.73, 0.76, 0.16, 0.96, -0.84, -0.12, 0.015));
  P.trim.push(rbox(0.84, 1.18, 0.16, 0.26, 0.12, 0.84, 0.02));
  P.seat.push(rbox(0.82, 1.2, 0.25, 0.36, 0.12, 0.84, 0.03));
  P.seat.push(rbox(0.76, 0.86, 0.35, 0.94, 0.14, 0.82, 0.025));

  // Ceiling: brushed stainless panels with transverse ribs, two grab rails.
  P.chrome.push(box(xr + 0.05, xf - 0.05, 1.6, 1.63, -(W - 0.26), W - 0.26));
  for (let x = xr + 0.3; x < xf - 0.1; x += 0.55) {
    P.trim.push(box(x - 0.018, x + 0.018, 1.58, 1.6, -(W - 0.26), W - 0.26));
  }
  for (const side of [-1, 1])
    P.chrome.push(cylinder(0.018, 0.018, 4.4, 6, 'x', -0.8, 1.5, side * 0.48));

  // Fare box in the aisle, just behind the front seats.
  P.chrome.push(rbox(0.5, 0.66, 0.06, 0.62, -0.09, 0.09, 0.02));
  P.dark.push(box(0.52, 0.64, 0.62, 0.66, -0.07, 0.07));

  // Ceiling-mounted ESP32-S3-CAM unit at the front of the cabin (x ≈ 1.2, y_ground ≈ 2.12, z = 0),
  // kept behind the camera's 5 cm near plane (x >= 1.17) so it never blocks the cabin feed.
  P.chrome.push(cylinder(0.012, 0.012, 0.11, 8, 'y', 1.22, 1.555, 0));
  P.dark.push(rbox(1.19, 1.25, 1.45, 1.55, -0.07, 0.07, 0.012));
  P.chrome.push(cylinder(0.028, 0.03, 0.02, 14, 'x', 1.185, 1.5, 0));
  P.tail.push(cylinder(0.018, 0.018, 0.024, 14, 'x', 1.182, 1.5, 0));

  const merged: JeepneyParts = {};
  for (const slot of Object.keys(P) as PartSlot[]) {
    const g = mergeParts(P[slot]);
    if (g) merged[slot] = g;
  }
  cachedBody = merged;
  return merged;
}

/** The front and rear axles, along the jeepney (ground frame; the axle WHEEL_RADIUS up). */
export const JEEPNEY_AXLES = [2.12, -2.2] as const;
/** Wheel nuts on each hub: what shows the wheels turning. */
const WHEEL_NUTS = 5;
/** Each wheel's middle, out from the jeepney's centre line (metres). */
const WHEEL_TRACK_Z = 0.86;

/**
 * Its four wheels: along it (an axle of JEEPNEY_AXLES), across it (+ on the
 * right), and whether it steers (the front two).
 */
export const JEEPNEY_WHEELS = JEEPNEY_AXLES.flatMap((x, a) =>
  [1, -1].map((side) => ({ x, z: side * WHEEL_TRACK_Z, side, steers: a === 0 })),
);

/**
 * One wheel, tyre and hub, centred on itself, its hub facing +z (the
 * right-hand side): drawn at each of JEEPNEY_WHEELS, WHEEL_RADIUS up, turned
 * half round for the left, steered (the front two) and rolled about its own
 * axle. Dark wheel nuts on the hub, so the turning shows.
 */
export function jeepneyWheels(): WheelParts {
  if (cachedWheels) return cachedWheels;
  const tires: BufferGeometry[] = [];
  const hubs: BufferGeometry[] = [];
  for (const side of [1]) {
    const z = 0;
    tires.push(cylinder(WHEEL_RADIUS, WHEEL_RADIUS, 0.26, 22, 'z', 0, 0, z));
    hubs.push(cylinder(0.21, 0.21, 0.02, 20, 'z', 0, 0, z + side * 0.135));
    hubs.push(cylinder(0.07, 0.07, 0.05, 10, 'z', 0, 0, z + side * 0.15));
    for (let k = 0; k < WHEEL_NUTS; k++) {
      const a = (k / WHEEL_NUTS) * Math.PI * 2;
      tires.push(
        cylinder(
          0.018,
          0.018,
          0.03,
          6,
          'z',
          Math.cos(a) * 0.13,
          Math.sin(a) * 0.13,
          z + side * 0.15,
        ),
      );
    }
  }
  cachedWheels = { tire: mergeParts(tires)!, hub: mergeParts(hubs)! };
  return cachedWheels;
}

/** Seat anchor for rider k on the side benches (for drawing seated people). */
export function benchSeat(k: number, capacity: number): { x: number; z: number; side: 1 | -1 } {
  const perSide = Math.max(1, Math.ceil(capacity / 2));
  const side: 1 | -1 = k % 2 ? -1 : 1;
  const j = Math.floor(k / 2);
  const x0 = REAR_X + 0.25;
  const x1 = 0.6;
  return { x: x0 + ((j + 0.5) * (x1 - x0)) / perSide, z: side * (HALF_WIDTH - 0.25), side };
}
