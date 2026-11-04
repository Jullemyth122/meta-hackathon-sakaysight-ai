/**
 * The modern jeepney (Class 2), the UV Express van and the city bus, built
 * from primitives to their sizes in core/vehicles/specs.ts: body, glazing,
 * doors (open at a stop, shut on the road) with steps up to the floor, seats
 * as laid out in each, the driver's place, lights, and a door camera over
 * every door.
 *
 * Built once per kind and cached; merged per material slot (bodyKit.Parts).
 * Besides the parts it gives where everyone sits: each passenger seat (for
 * the riders' motions, puvCrew.ts) and the driver's seat and grip on the wheel.
 */

import { BoxGeometry, TorusGeometry, Vector3 } from 'three';
import type { Seat } from '@/core/people/riderMotion';
import { VEHICLES, type DoorSpec, type VehicleKind } from '@/core/vehicles/specs';
import { box, cylinder, roundedBox as rbox } from '../jeepney/geometryKit';
import {
  cameraMount,
  door,
  floorWithSteps,
  forwardSeat,
  Parts,
  runningBoard,
  sideSeats,
  sideWall,
  underbody,
  WALL,
  wellDepth,
  wheelHousings,
  wheels,
  type DoorState,
  type Slot,
  type VehicleParts,
  type Wheels,
} from './bodyKit';
import { doorCameras } from './doorCamera';

export interface DriverPlace {
  /** The seated driver's root (personRig: hips over it), facing +x. */
  x: number;
  y: number;
  z: number;
  /** Hands on the wheel at ten to two: the driver's right (+z side), then left. */
  grips: readonly [Vector3, Vector3];
}

export interface BuiltVehicle {
  /** Everything but the doors. */
  parts: VehicleParts;
  /** The doors, open (at a stop) and shut. */
  doors: Record<DoorState, VehicleParts>;
  /** Every passenger seat. */
  seats: Seat[];
  /** Where riders stand, packed (Seat.stands): VehicleSpec.standing of them, in the aisle. */
  standing: Seat[];
  driver: DriverPlace;
  /**
   * The wheels, an axle at a time (both ends): `parts` centred on the axle,
   * drawn at (x, y) and turned about it as the vehicle rolls.
   */
  axles: Axle[];
}

export interface Axle {
  x: number;
  y: number;
  parts: VehicleParts;
  /** A front wheel, on its own: it steers about its upright, `z` across (+ right). */
  steers?: boolean;
  z?: number;
}

/**
 * The wheels at each end of the axle at `x`, centred on it (see Axle); or,
 * with `side`, the one wheel at that end (a front wheel, steered on its own).
 */
function axle(
  x: number,
  r: number,
  halfW: number,
  dual: boolean,
  studs?: number,
  side?: 1 | -1,
): Axle {
  const W = new Parts();
  wheels(W, 0, r, halfW, dual, studs, side ? [side] : undefined);
  const parts = W.merge();
  for (const g of Object.values(parts)) g!.translate(0, -r, 0);
  if (!side) return { x, y: r, parts };
  // Its upright: the middle of the tyre, across the vehicle.
  const tyre = parts.tire!;
  tyre.computeBoundingBox();
  const z = (tyre.boundingBox!.min.z + tyre.boundingBox!.max.z) / 2;
  return { x, y: r, parts, steers: true, z };
}

/** The front axle's two wheels, each steered on its own, and the rear axle's (both ends, `dual` or not). */
function steeredAxles(
  front: number,
  rear: number,
  r: number,
  halfW: number,
  dualRear: boolean,
  studs?: number,
): Axle[] {
  return [
    axle(front, r, halfW, false, studs, 1),
    axle(front, r, halfW, false, studs, -1),
    axle(rear, r, halfW, dualRear, studs),
  ];
}

const cache = new Map<VehicleKind, BuiltVehicle>();

export function vehicleGeometry(kind: VehicleKind): BuiltVehicle {
  let built = cache.get(kind);
  if (!built) {
    built = kind === 'bus' ? bus() : kind === 'modern' ? modernJeepney() : uvExpress();
    cache.set(kind, built);
  }
  return built;
}

/** A livery band along both sides, y0..y1, broken by the doors (kerb side). */
function band(
  P: Parts,
  slot: Slot,
  y0: number,
  y1: number,
  x0: number,
  x1: number,
  halfW: number,
  doors: readonly DoorSpec[],
) {
  for (const side of [-1, 1] as const) {
    const cuts = (side === 1 ? doors.map((d) => [d.x0, d.x1] as const) : []).sort(
      (a, b) => a[0] - b[0],
    );
    let a = x0;
    for (const [c0, c1] of [...cuts, [x1, x1] as const]) {
      if (c0 - a > 0.02)
        P.add(slot, box(a, Math.min(c0, x1), y0, y1, side * halfW, side * (halfW + 0.006)));
      a = Math.max(a, c1);
    }
  }
}

/** The wheel leans back towards the driver this much (radians from upright). */
const WHEEL_RAKE = 0.55;
/** Hands at ten to two. */
const GRIP_ANGLE = (62 * Math.PI) / 180;
const Z_AXIS = new Vector3(0, 0, 1);

/**
 * The driver's seat (front edge at `front`, z0..z1) and their wheel, raked
 * towards them in front of their chest: where the driver sits and holds it.
 */
function driverSeat(
  P: Parts,
  front: number,
  z0: number,
  z1: number,
  floor: number,
  wheelR: number,
): DriverPlace {
  const [place] = forwardSeat(P, front, z0, z1, floor, false);
  const centre = new Vector3(place!.x + 0.35, floor + 0.45 + 0.38, place!.z);
  const rim = new TorusGeometry(wheelR, 0.022, 8, 28);
  rim.rotateY(Math.PI / 2);
  rim.rotateZ(-WHEEL_RAKE);
  rim.translate(centre.x, centre.y, centre.z);
  P.add('dark', rim);
  // The column runs from the hub forward and down, along the wheel's axis.
  const column = new BoxGeometry(0.36, 0.045, 0.045);
  column.rotateZ(-WHEEL_RAKE);
  column.translate(centre.x + 0.153, centre.y - 0.094, centre.z);
  P.add('dark', column);
  // A point on the rim `a` from the top towards the driver's right (+z).
  const grip = (a: number) =>
    new Vector3(0, wheelR * Math.cos(a), wheelR * Math.sin(a))
      .applyAxisAngle(Z_AXIS, -WHEEL_RAKE)
      .add(centre);
  // Lower than a rider's root by as much as the jeepney's driver (JeepneyInstances).
  return {
    x: place!.x,
    y: place!.y! - 0.06,
    z: place!.z,
    grips: [grip(GRIP_ANGLE), grip(-GRIP_ANGLE)],
  };
}

/** Every door camera's housing, from doorCamera.ts (one place for where they are). */
function mounts(P: Parts, kind: VehicleKind): void {
  for (const cam of doorCameras(kind))
    cameraMount(P, cam.position.x, cam.position.y, cam.position.z);
}

/** The doors, open and shut. */
function doorsOf(
  list: readonly DoorSpec[],
  halfW: number,
  belt: number,
  top: number,
  livery: ReadonlyArray<readonly [Slot, number, number]> = [],
): Record<DoorState, VehicleParts> {
  const open = new Parts();
  const closed = new Parts();
  for (const d of list) {
    door(open, d, halfW, 'open', livery, belt, top);
    door(closed, d, halfW, 'closed', livery, belt, top);
  }
  return { open: open.merge(), closed: closed.merge() };
}

/** A 3+2 bus's aisle: its middle (metres across, towards the doors) and its width. */
export const BUS_AISLE_Z = 0.28;
const BUS_AISLE_M = 0.28;
/** Its two grab rails, either side of the middle of the aisle (metres). */
const BUS_RAIL_APART_M = 0.08;

/** The bus: 12 m, two doors on the kerb side, 3+2 seats facing forward, engine at the back. */
function bus(): BuiltVehicle {
  const S = VEHICLES.bus;
  const P = new Parts();
  const hw = S.widthM / 2;
  const xr = -S.lengthM / 2;
  const xf = S.lengthM / 2;
  const floor = S.floorM;
  const roof = 3.2;
  const skirt = 0.3;
  const belt = 1.75;
  const top = 2.85;
  const r = S.wheelRadiusM;
  const well: Wheels = { xs: S.axles, r, wellM: wellDepth(r, hw, true) };
  for (const side of [-1, 1] as const)
    sideWall(P, {
      side,
      x0: xr + 0.08,
      x1: xf - 0.08,
      halfW: hw,
      skirt,
      belt,
      top,
      roof,
      doors: S.doors,
      wheels: S.axles,
      wheelR: r,
      wellM: well.wellM,
      pitch: 1.3,
      windowX0: xr + 0.4,
      pillar: 'dark',
    });
  // Ten-stud wheels, dual at the back.
  const axles = steeredAxles(S.axles[0], S.axles[1], r, hw, true, 10);

  // Roof, the air-conditioning unit, the ceiling with its light strips.
  // A touch wider than the walls (a drip rail along each side), so they never share a face.
  P.add('paint', rbox(xr, xf, roof - 0.03, roof + 0.07, -hw - 0.012, hw + 0.012, 0.06));
  P.add('trim', rbox(-2.2, 1.6, roof + 0.07, S.heightM, -0.85, 0.85, 0.08));
  for (let x = -1.9; x < 1.4; x += 0.45)
    P.add('dark', box(x, x + 0.3, S.heightM - 0.005, S.heightM + 0.004, -0.6, 0.6));
  const ceiling = floor + S.headroomM;
  P.add(
    'interior',
    box(xr + 0.08, xf - 0.08, ceiling, ceiling + 0.03, -hw + WALL + 0.002, hw - WALL - 0.002),
  );
  for (const z of [-0.5, 0.5])
    P.add('lamp', box(xr + 0.6, 4.1, ceiling - 0.015, ceiling, z - 0.05, z + 0.05));

  // Floor and the stairs at both doors; under it; wheel housings inside.
  floorWithSteps(P, xr + 0.08, xf - 0.08, hw, floor, S.doors, well);
  underbody(P, xr + 0.1, xf - 0.1, hw - well.wellM, floor, skirt);
  wheelHousings(P, hw, floor, well);

  // Seats: rows of three on the far side of the aisle and two on the door
  // side; none at the middle door's stairs (a standing area there), a bench
  // of five across the back. 61 in all.
  const seats: Seat[] = [];
  const middle = S.doors[1]!;
  for (let k = 0; k < 12; k++) {
    const x = 3.7 - k * 0.75; // 0.75 m apart, legroom for the back bench too
    seats.push(...forwardSeat(P, x, -hw + WALL + 0.02, BUS_AISLE_Z - BUS_AISLE_M / 2, floor));
    const nearMiddleDoor = x - 0.62 < middle.x1 + 0.1 && x > middle.x0 - 0.1;
    if (!nearMiddleDoor)
      seats.push(...forwardSeat(P, x, BUS_AISLE_Z + BUS_AISLE_M / 2, hw - WALL - 0.02, floor));
  }
  P.add('trim', box(xr + 0.1, -5.4, floor, floor + 0.2, -hw + WALL, hw - WALL)); // over the engine
  seats.push(...forwardSeat(P, -5.45, -hw + WALL + 0.02, hw - WALL - 0.02, floor + 0.2, false));
  // Standing in the aisle: one file, a step apart, each holding the strap
  // that hangs from a rail above, the two rails taken in turn.
  const standing = Array.from({ length: S.standing }, (_, k): Seat => {
    const side = k % 2 ? -1 : 1;
    const x = -4.8 + k * 0.45;
    const rail = BUS_AISLE_Z + side * BUS_RAIL_APART_M;
    const hand = [x + 0.05, floor + 1.58, rail] as const;
    P.add('dark', box(x + 0.04, x + 0.06, floor + 1.6, floor + 1.8, rail - 0.01, rail + 0.01));
    P.add('chrome', box(x, x + 0.1, floor + 1.57, floor + 1.6, rail - 0.012, rail + 0.012));
    return {
      x,
      y: floor,
      z: BUS_AISLE_Z,
      yaw: 0,
      stands: true,
      holds: side > 0 ? [hand, null] : [null, hand],
    };
  });
  // Grab rails along the aisle; poles in the standing area, clear of the way to the door.
  for (const z of [BUS_AISLE_Z - BUS_RAIL_APART_M, BUS_AISLE_Z + BUS_RAIL_APART_M])
    P.add('chrome', cylinder(0.016, 0.016, 9.2, 8, 'x', -0.5, floor + 1.8, z));
  for (const x of [middle.x0 + 0.15, middle.x1 - 0.15])
    P.add('chrome', cylinder(0.018, 0.018, S.headroomM, 8, 'y', x, floor + S.headroomM / 2, 0.33));

  // The driver: seat, partition behind, dashboard, wheel; the fare box
  // beside the way in, clear of the aisle.
  const driver = driverSeat(P, 5.3, -hw + WALL + 0.15, -0.55, floor + 0.05, 0.23);
  P.add('trim', box(4.25, 4.3, floor, floor + 1.25, -hw + WALL, -0.25));
  P.add('dark', rbox(5.55, xf - 0.06, floor + 0.55, floor + 1.02, -hw + WALL, hw - WALL, 0.04));
  P.add('chrome', rbox(4.0, 4.18, floor, floor + 1.0, 0.5, 0.8, 0.02));
  P.add('dark', rbox(4.02, 4.16, floor + 1.0, floor + 1.18, 0.54, 0.76, 0.02)); // card reader
  P.add('lamp', box(4.01, 4.02, floor + 1.08, floor + 1.14, 0.6, 0.7));

  // Front: windscreen in two panes, destination sign, lamps, bumper, wipers, mirrors.
  P.add('paint', box(xf - 0.08, xf, skirt, 1.0, -hw, hw));
  P.add('glass', box(xf - 0.05, xf - 0.025, 1.02, 2.8, -hw + 0.1, hw - 0.1));
  for (const [y0, y1] of [
    [0.98, 1.04],
    [2.78, 2.86],
  ] as const)
    P.add('dark', box(xf - 0.06, xf + 0.005, y0, y1, -hw - 0.003, hw + 0.003));
  for (const z of [-hw + 0.05, 0, hw - 0.05])
    P.add(
      'dark',
      box(
        xf - 0.06,
        xf + 0.005,
        1.0,
        2.86,
        z - 0.05 - (z < 0 ? 0.003 : 0),
        z + 0.05 + (z > 0 ? 0.003 : 0),
      ),
    );
  P.add('dark', box(xf - 0.06, xf, 2.86, roof - 0.03, -hw, hw));
  P.add('sign', box(xf - 0.005, xf + 0.012, 2.9, 3.12, -1.0, 1.0));
  for (const side of [-1, 1]) {
    for (const z of [0.72, 0.95])
      P.add('lamp', rbox(xf, xf + 0.025, 0.6, 0.78, side * (z - 0.1), side * (z + 0.1), 0.02));
    P.add('nosing', box(xf, xf + 0.02, 0.82, 0.9, side * 0.62, side * 1.08));
    // "Rabbit ear" mirrors on arms reaching forward over the windscreen.
    P.add('chrome', cylinder(0.02, 0.02, 0.45, 8, 'x', xf + 0.2, 2.75, side * 1.2));
    P.add('chrome', cylinder(0.02, 0.02, 0.4, 8, 'y', xf + 0.42, 2.55, side * 1.2));
    P.add('dark', rbox(xf + 0.38, xf + 0.46, 1.9, 2.38, side * 1.12, side * 1.36, 0.03));
    const wiper = new BoxGeometry(0.02, 0.8, 0.03);
    wiper.rotateX(side * 0.5);
    wiper.translate(xf + 0.01, 1.45, side * 0.55);
    P.add('dark', wiper);
  }
  P.add('dark', box(xf, xf + 0.012, 0.6, 0.86, -0.5, 0.5)); // grille
  P.add('trim', rbox(xf - 0.03, xf + 0.13, 0.28, 0.56, -hw - 0.02, hw + 0.02, 0.05));

  // Back: rear window, engine louvres, tail lamps, bumper.
  P.add('paint', box(xr, xr + 0.08, skirt, 1.9, -hw, hw));
  P.add('paint', box(xr, xr + 0.08, 2.75, roof - 0.03, -hw, hw));
  for (const side of [-1, 1]) P.add('paint', box(xr, xr + 0.08, 1.9, 2.75, side * 1.0, side * hw));
  P.add('glass', box(xr + 0.03, xr + 0.05, 1.9, 2.75, -1.0, 1.0));
  for (let k = 0; k < 7; k++)
    P.add('dark', box(xr - 0.012, xr, 0.62 + k * 0.1, 0.67 + k * 0.1, -0.85, 0.85));
  for (const side of [-1, 1]) P.add('tail', box(xr - 0.02, xr, 0.6, 1.45, side * 1.0, side * 1.18));
  P.add('trim', rbox(xr - 0.13, xr + 0.03, 0.28, 0.56, -hw - 0.02, hw + 0.02, 0.05));

  band(P, 'stripe', belt - 0.28, belt - 0.12, xr, xf, hw, S.doors);
  band(P, 'stripe2', 1.2, 1.27, xr, xf, hw, S.doors);
  mounts(P, 'bus');
  return {
    parts: P.merge(),
    doors: doorsOf(S.doors, hw, belt, top),
    seats,
    standing,
    driver,
    axles,
  };
}

/** The modern jeepney: a 6.9 m minibus, driver over the front axle, door behind the front wheel. */
function modernJeepney(): BuiltVehicle {
  const S = VEHICLES.modern;
  const P = new Parts();
  const hw = S.widthM / 2;
  const xr = -S.lengthM / 2;
  const xf = S.lengthM / 2;
  const floor = S.floorM;
  const roof = 2.68;
  const skirt = 0.42;
  const belt = 1.45;
  const top = 2.3;
  const r = S.wheelRadiusM;
  const entry = S.doors[0]!;
  const well: Wheels = { xs: S.axles, r, wellM: wellDepth(r, hw, true) };
  for (const side of [-1, 1] as const)
    sideWall(P, {
      side,
      x0: xr + 0.06,
      x1: xf - 0.06,
      halfW: hw,
      skirt,
      belt,
      top,
      roof,
      doors: S.doors,
      wheels: S.axles,
      wheelR: r,
      wellM: well.wellM,
      pitch: 0.95,
      windowX0: xr + 0.3,
      windowX1: xf - 0.2,
      pillar: 'dark',
    });
  const axles = steeredAxles(S.axles[0], S.axles[1], r, hw, true);

  // Roof, air-con unit, ceiling with light strips.
  P.add('paint', rbox(xr, xf, roof - 0.03, roof + 0.06, -hw - 0.012, hw + 0.012, 0.05));
  P.add('trim', rbox(-1.6, 0.8, roof + 0.06, S.heightM, -0.8, 0.8, 0.07));
  const ceiling = floor + S.headroomM;
  P.add(
    'interior',
    box(xr + 0.06, xf - 0.06, ceiling, ceiling + 0.03, -hw + WALL + 0.002, hw - WALL - 0.002),
  );
  for (const z of [-0.4, 0.4])
    P.add('lamp', box(xr + 0.4, 1.9, ceiling - 0.015, ceiling, z - 0.04, z + 0.04));

  floorWithSteps(P, xr + 0.06, xf - 0.06, hw, floor, S.doors, well);
  underbody(P, xr + 0.1, xf - 0.1, hw - well.wellM, floor, skirt);
  wheelHousings(P, hw, floor, well);
  P.add('trim', rbox(2.0, 2.95, floor - 0.04, floor + 0.32, -0.25, 0.5, 0.06)); // engine cover, cab-over

  // Seats along both walls, facing in; the driver's seat; rails overhead to
  // hold for those standing (no poles in the aisle, where people walk).
  const seats = [
    ...sideSeats(P, xr + 0.15, 1.95, -1, hw, floor, 0.42),
    ...sideSeats(P, xr + 0.15, entry.x0 - 0.05, 1, hw, floor, 0.42),
  ];
  // Standing, packed: down the aisle behind the door, staggered, each facing
  // the bench on their side with a hand on the rail over it (every other
  // pair, both hands).
  const standing = Array.from({ length: S.standing }, (_, k): Seat => {
    const side = k % 2 ? -1 : 1;
    const x = -3 + k * 0.4;
    const rail = (dx: number) => [x + dx, floor + 1.56, side * 0.45] as const;
    return {
      x,
      y: floor,
      z: side * 0.26,
      yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2,
      stands: true,
      holds: [rail(-side * 0.14), k % 4 < 2 ? rail(side * 0.14) : null],
    };
  });
  const driver = driverSeat(P, 3.0, -hw + WALL + 0.1, -0.35, floor + 0.12, 0.2);
  P.add('dark', rbox(3.12, xf - 0.06, floor + 0.55, floor + 0.98, -hw + WALL, hw - WALL, 0.04));
  for (const z of [-0.45, 0.45])
    P.add('chrome', cylinder(0.016, 0.016, 5.0, 8, 'x', xr + 0.3 + 2.5, floor + 1.56, z));
  // Fare card reader on a pole by the door.
  P.add('chrome', cylinder(0.02, 0.02, 1.0, 8, 'y', entry.x0 - 0.1, floor + 0.5, hw - 0.55));
  P.add(
    'dark',
    rbox(entry.x0 - 0.18, entry.x0 - 0.02, floor + 0.95, floor + 1.15, hw - 0.62, hw - 0.48, 0.02),
  );
  P.add(
    'lamp',
    box(entry.x0 - 0.17, entry.x0 - 0.03, floor + 1.1, floor + 1.13, hw - 0.481, hw - 0.475),
  );

  // Front: windscreen, route sign above it, lamps, grille, bumper, mirrors.
  P.add('paint', box(xf - 0.06, xf, skirt, 1.15, -hw, hw));
  P.add('glass', box(xf - 0.04, xf - 0.02, 1.15, 2.32, -hw + 0.08, hw - 0.08));
  for (const [y0, y1] of [
    [1.12, 1.17],
    [2.3, 2.35],
  ] as const)
    P.add('dark', box(xf - 0.05, xf + 0.005, y0, y1, -hw - 0.003, hw + 0.003));
  for (const z of [-hw + 0.04, hw - 0.04])
    P.add(
      'dark',
      box(
        xf - 0.05,
        xf + 0.005,
        1.12,
        2.35,
        z - 0.04 - (z < 0 ? 0.003 : 0),
        z + 0.04 + (z > 0 ? 0.003 : 0),
      ),
    );
  P.add('dark', box(xf - 0.05, xf, 2.35, roof - 0.03, -hw, hw));
  P.add('sign', box(xf - 0.002, xf + 0.012, 2.38, 2.6, -0.9, 0.9));
  P.add('dark', box(xf, xf + 0.012, 0.6, 1.0, -0.48, 0.48));
  for (let k = 0; k < 5; k++)
    P.add('chrome', box(xf + 0.012, xf + 0.03, 0.64 + k * 0.08, 0.67 + k * 0.08, -0.46, 0.46));
  for (const side of [-1, 1]) {
    P.add('lamp', rbox(xf, xf + 0.025, 0.72, 0.9, side * 0.6, side * 0.98, 0.02));
    P.add('nosing', box(xf, xf + 0.02, 0.93, 1.0, side * 0.7, side * 0.98));
    P.add('chrome', cylinder(0.018, 0.018, 0.3, 8, 'x', xf + 0.12, 2.15, side * (hw + 0.05)));
    P.add(
      'dark',
      rbox(xf + 0.22, xf + 0.29, 1.65, 2.12, side * (hw - 0.02), side * (hw + 0.2), 0.03),
    );
    const wiper = new BoxGeometry(0.02, 0.62, 0.03);
    wiper.rotateX(side * 0.45);
    wiper.translate(xf + 0.006, 1.5, side * 0.45);
    P.add('dark', wiper);
  }
  P.add('trim', rbox(xf - 0.03, xf + 0.14, 0.38, 0.62, -hw - 0.02, hw + 0.02, 0.05));
  // The driver's door (closed) on the driver's side, and a route sign by the passenger door.
  // Its outline stands proud of the livery band (which is 6 mm out).
  for (const x of [2.55, 3.3]) P.add('dark', box(x - 0.012, x + 0.012, 0.6, top, -hw - 0.01, -hw));
  P.add('chrome', box(2.62, 2.74, 1.25, 1.29, -hw - 0.02, -hw));
  P.add('sign', box(entry.x1 + 0.08, entry.x1 + 1.1, top + 0.06, top + 0.26, hw, hw + 0.012));

  // Back: rear window over the emergency door, tail lamps, bumper.
  P.add('paint', box(xr, xr + 0.06, skirt, 1.55, -hw, hw));
  P.add('paint', box(xr, xr + 0.06, 2.3, roof - 0.03, -hw, hw));
  for (const side of [-1, 1]) P.add('paint', box(xr, xr + 0.06, 1.55, 2.3, side * 0.95, side * hw));
  P.add('glass', box(xr + 0.02, xr + 0.04, 1.55, 2.3, -0.95, 0.95));
  for (const z of [-0.45, 0.45])
    P.add('dark', box(xr - 0.008, xr, floor, 2.3, z - 0.015, z + 0.015));
  P.add('dark', box(xr - 0.008, xr, floor - 0.015, floor, -0.45, 0.45));
  P.add('tail', box(xr - 0.012, xr, 2.36, 2.48, -0.3, 0.3)); // EXIT plate over the emergency door
  for (const side of [-1, 1]) P.add('tail', box(xr - 0.02, xr, 0.6, 1.3, side * 0.85, side * 1.05));
  P.add('trim', rbox(xr - 0.12, xr + 0.03, 0.38, 0.62, -hw - 0.02, hw + 0.02, 0.05));

  band(P, 'stripe', belt - 0.3, belt - 0.12, xr, xf, hw, S.doors);
  band(P, 'stripe2', belt - 0.36, belt - 0.32, xr, xf, hw, S.doors);
  mounts(P, 'modern');
  return {
    parts: P.merge(),
    doors: doorsOf(S.doors, hw, belt, top),
    seats,
    standing,
    driver,
    axles,
  };
}

/** The UV Express: a high-roof 15-seater van, sliding door on the kerb side, short bonnet. */
function uvExpress(): BuiltVehicle {
  const S = VEHICLES.uv;
  const P = new Parts();
  const hw = S.widthM / 2;
  const xr = -S.lengthM / 2;
  const xf = S.lengthM / 2;
  const floor = S.floorM;
  const roof = 2.2;
  const skirt = 0.3;
  const belt = 1.08;
  const top = 1.9;
  const r = S.wheelRadiusM;
  const cabDoor = S.doors[1]!;
  const cab = 1.25; // where the windscreen meets the roof
  const front = 1.95; // where the bonnet starts
  const well: Wheels = { xs: S.axles, r, wellM: wellDepth(r, hw, false) };
  // The sides run to the bonnet below the windowsill (the cab doors), and to
  // the windscreen above it.
  for (const side of [-1, 1] as const)
    sideWall(P, {
      side,
      x0: xr + 0.05,
      x1: front,
      upperX1: cab,
      halfW: hw,
      skirt,
      belt,
      top,
      roof,
      doors: S.doors,
      wheels: S.axles,
      wheelR: r,
      wellM: well.wellM,
      pitch: 0.95,
      windowX0: xr + 0.25,
      windowX1: cab - 0.05,
    });
  runningBoard(P, cabDoor, hw);
  const axles = steeredAxles(S.axles[0], S.axles[1], r, hw, false);

  // The driver's cab door: its windows, door line and handle, mirror (the
  // kerb side's cab door is a door of its own); the bonnet and nose.
  for (const side of [-1, 1]) {
    const zo = side * hw;
    if (side < 0) {
      P.add('glass', box(cab + 0.05, 1.62, belt, 1.75, zo - side * 0.02, zo - side * 0.032));
      P.add('glass', box(1.62, 1.8, belt, 1.42, zo - side * 0.02, zo - side * 0.032));
      P.add('dark', box(cab - 0.012, cab + 0.012, skirt, 1.85, zo, zo + side * 0.01));
      P.add('chrome', box(cab + 0.1, cab + 0.22, 1.035, 1.065, zo, zo + side * 0.02));
    }
    P.add('dark', rbox(1.88, 1.98, 1.25, 1.45, zo, zo + side * 0.18, 0.03)); // door mirror
  }
  P.add('paint', rbox(front, xf - 0.1, 0.55, 1.06, -hw, hw, 0.08)); // bonnet
  // The nose below it, ahead of the front wheel's arch.
  P.add('paint', box(S.axles[0] + r + 0.07, xf - 0.1, skirt, 0.55, -hw, hw));
  P.add('dark', box(xf - 0.12, xf - 0.08, 0.62, 0.95, -0.5, 0.5)); // grille
  P.add('chrome', box(xf - 0.11, xf - 0.07, 0.95, 0.99, -0.52, 0.52));
  for (const side of [-1, 1])
    P.add('lamp', rbox(xf - 0.16, xf - 0.07, 0.8, 0.98, side * 0.55, side * 0.86, 0.03));
  P.add('trim', rbox(xf - 0.2, xf, 0.25, 0.62, -hw - 0.01, hw + 0.01, 0.06));
  // Windscreen from the bonnet up to the roof, raked back, and its pillars.
  const run = 1.95 - cab;
  const rise = 1.95 - belt;
  const len = Math.hypot(run, rise);
  const rake = Math.atan2(run, rise);
  const screen = new BoxGeometry(0.02, len, 2 * hw - 0.16);
  screen.rotateZ(rake);
  screen.translate((1.95 + cab) / 2, (belt + 1.95) / 2, 0);
  P.add('glass', screen);
  for (const side of [-1, 1]) {
    const post = new BoxGeometry(0.07, len, 0.08);
    post.rotateZ(rake);
    post.translate((1.95 + cab) / 2, (belt + 1.95) / 2, side * (hw - 0.035));
    P.add('paint', post);
  }
  P.add('dark', box(1.9, 2.0, belt - 0.04, belt + 0.03, -hw + 0.01, hw - 0.01)); // cowl
  // Roof: the high roof's front cap over the windscreen, the roof, a luggage rack.
  const ceiling = floor + S.headroomM;
  // A touch wider than the walls, so they never share a face; the cap a touch less than the roof.
  P.add('paint', rbox(xr, cab + 0.1, ceiling + 0.03, S.heightM, -hw - 0.012, hw + 0.012, 0.08));
  P.add(
    'paint',
    rbox(cab - 0.15, cab + 0.2, 1.88, S.heightM - 0.004, -hw - 0.006, hw + 0.006, 0.12),
  );
  for (const z of [-0.72, 0.72])
    P.add('chrome', cylinder(0.015, 0.015, 3.3, 8, 'x', -0.65, S.heightM + 0.07, z));
  for (let x = -2.2; x <= 0.9; x += 0.62) {
    P.add('chrome', cylinder(0.012, 0.012, 1.44, 8, 'z', x, S.heightM + 0.07, 0));
    for (const z of [-0.72, 0.72])
      P.add('dark', box(x - 0.03, x + 0.03, S.heightM, S.heightM + 0.07, z - 0.03, z + 0.03));
  }
  P.add(
    'interior',
    box(xr + 0.05, cab, ceiling, ceiling + 0.03, -hw + WALL + 0.002, hw - WALL - 0.002),
  );

  floorWithSteps(P, xr + 0.05, front, hw, floor, S.doors, well);
  underbody(P, xr + 0.1, front - 0.05, hw - well.wellM, floor, skirt);
  wheelHousings(P, hw, floor, well);

  // Seats: the driver and two beside them (their legroom to the dashboard);
  // four rows of three behind, the aisle along the door side. Tight: a van.
  const driver = driverSeat(P, 1.45, -hw + WALL + 0.02, -0.42, floor, 0.19);
  const seats = forwardSeat(P, 1.45, -0.18, hw - WALL - 0.02, floor, false);
  const rows = [0.8, 0.0, -0.8, -1.6];
  for (const x of rows)
    seats.push(...forwardSeat(P, x, -hw + WALL + 0.02, 0.46, floor, x !== rows[rows.length - 1]));
  P.add('dark', rbox(1.75, 1.98, 0.88, 1.12, -hw + WALL, hw - WALL, 0.03)); // dashboard
  P.add('sign', box(1.88, 1.895, 1.15, 1.33, 0.2, 0.75)); // route board behind the windscreen

  // Back: tailgate with its window, tall lamps, bumper.
  P.add('paint', box(xr, xr + 0.05, skirt, 1.25, -hw, hw));
  P.add('paint', box(xr, xr + 0.05, 1.95, roof, -hw, hw));
  for (const side of [-1, 1])
    P.add('paint', box(xr, xr + 0.05, 1.25, 1.95, side * 0.78, side * hw));
  P.add('glass', box(xr + 0.015, xr + 0.035, 1.25, 1.95, -0.78, 0.78));
  for (const side of [-1, 1])
    P.add('tail', box(xr - 0.015, xr, 0.88, 1.45, side * 0.8, side * 0.93));
  P.add('chrome', box(xr - 0.02, xr, 1.12, 1.16, -0.12, 0.12));
  P.add('trim', rbox(xr - 0.06, xr + 0.12, 0.25, 0.55, -hw - 0.01, hw + 0.01, 0.05));

  // Above the wheel arches, along to the bonnet; on the doors too.
  const livery = [
    ['stripe', 0.85, 0.98],
    ['stripe2', 0.99, 1.02],
  ] as const;
  for (const [slot, y0, y1] of livery) band(P, slot, y0, y1, xr, front, hw, S.doors);
  mounts(P, 'uv');
  return {
    parts: P.merge(),
    doors: doorsOf(S.doors, hw, belt, top, livery),
    seats,
    standing: [],
    driver,
    axles,
  };
}
