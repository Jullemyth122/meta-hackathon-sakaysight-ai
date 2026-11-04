/**
 * The vehicles of the network's flows beyond the few drawn in full: the same
 * jeepneys, vans and buses, outside only, for a few hundred triangles instead
 * of 7,000–19,000. Nobody looks in from 200 m, so there are no seats, rails or
 * doors that open; what stays is what tells one vehicle from another at that
 * distance: its outline, windows, livery, wheels, lamps and route sign.
 *
 *   near  windows and pillars, doors, lamps, signs, round wheels (~300–600 triangles)
 *   far   outline, window band, roof, stripe, wheels (~100 triangles): never a plain box
 *
 * Each look is one geometry with its colours baked in, so a kind costs one
 * draw call however many are out: an instance colour would tint the windows
 * and chrome along with the paint. Sizes are those of core/vehicles/specs.ts
 * and the full models (jeepneyGeometry.ts, vehicleGeometry.ts), same origin,
 * so one swapped for the other stays where it is.
 */

import { Color, type BufferGeometry } from 'three';
import type { Livery } from '@/core/fleet/fleetSim';
import { VEHICLES, type FleetKind, type VehicleKind } from '@/core/vehicles/specs';
import { bakeColours, box, cylinder } from '../jeepney/geometryKit';
import {
  BODY_LIFT,
  FRONT_CABIN_X,
  HALF_WIDTH,
  JEEPNEY_AXLES,
  REAR_X,
  WALL,
  WHEEL_RADIUS,
} from '../jeepney/jeepneyGeometry';
import { LIVERIES, PALETTE } from '../jeepney/materials';
import { Parts, type Slot, type VehicleParts } from './bodyKit';
import { LIVERY } from './vehicleMaterials';

export type TrafficDetail = 'near' | 'far';
export const TRAFFIC_DETAILS: readonly TrafficDetail[] = ['near', 'far'];

/** A geometry of its own: each jeepney livery, and each other kind. */
export type TrafficLook = Livery | VehicleKind;
export const TRAFFIC_LOOKS: readonly TrafficLook[] = [
  'red',
  'yellow',
  'green',
  'modern',
  'uv',
  'bus',
];

export const trafficLook = (kind: FleetKind, livery: Livery): TrafficLook =>
  kind === 'jeepney' ? livery : kind;

/** Open windows, seen from outside: the dim cabin behind them. */
const CABIN = '#4a5056';
/** How far a painted band or panel stands off the body: enough to never share its face. */
const PROUD = 0.012;
/**
 * Added above and below a stripe on the far model. A thin one is finer than a
 * pixel from there: it falls between the samples and shimmers as the view moves.
 */
const FAR_BAND_M = 0.1;
const SIDES = [-1, 1] as const;

function jeepney(near: boolean): VehicleParts {
  const P = new Parts();
  const lift = (y: number) => y + BODY_LIFT;
  const xr = REAR_X;
  const xf = FRONT_CABIN_X;
  const W = HALF_WIDTH;

  P.add('dark', box(-3.02, 3, lift(-0.16), lift(0.02), -0.78, 0.78)); // chassis
  P.add('paint', box(xr, xf, lift(0.02), lift(0.8), -W, W));
  P.add('glass', box(xr + 0.02, 1.7, lift(0.8), lift(1.42), -W + WALL, W - WALL));
  P.add('paint', box(xr, 1.8, lift(1.42), lift(1.63), -W, W)); // above the windows
  P.add('paint', box(xr - 0.12, 2.22, lift(1.64), lift(1.77), -1.08, 1.08)); // roof, over the cab
  P.add('stripe2', box(xr - 0.125, 2.225, lift(1.63), lift(near ? 1.68 : 1.72), -1.085, 1.085));
  P.add('stripe', box(1.75, 3.02, lift(0.04), lift(0.84), -0.8, 0.8)); // the long hood
  P.add('glass', box(1.72, 1.76, lift(0.82), lift(1.46), -0.9, 0.9)); // windscreen
  const band = near ? 0 : FAR_BAND_M;
  P.add(
    'stripe',
    box(xr - PROUD, xf + PROUD, lift(1.48 - band), lift(1.54 + band), -W - PROUD, W + PROUD),
  );

  for (const x of JEEPNEY_AXLES) {
    if (near) continue;
    P.add('tire', box(x - WHEEL_RADIUS, x + WHEEL_RADIUS, 0, lift(-0.02), -0.99, 0.99));
  }
  if (!near) return P.merge();

  for (const side of SIDES) {
    const outer = side * W;
    const off = (d: number) => outer + side * d;
    // The stripes along the body and the rail under the windows.
    P.add('stripe', box(xr - PROUD, 0.82, lift(0.12), lift(0.22), outer, off(PROUD)));
    P.add('stripe', box(1.46, xf + PROUD, lift(0.12), lift(0.22), outer, off(PROUD)));
    P.add('stripe2', box(xr - PROUD, 0.82, lift(0.7), lift(0.8), outer, off(PROUD)));
    // The cab's open step-in doorway.
    P.add('glass', box(0.84, 1.44, lift(0.2), lift(0.78), outer, off(PROUD)));
    P.add('chrome', box(0.82, 1.46, lift(0.78), lift(0.8), outer, off(PROUD * 2)));
    // Window pillars.
    for (let k = 0; k <= 6; k++) {
      const x = xr + 0.06 + (k * (0.76 - (xr + 0.06))) / 6;
      P.add('paint', box(x - 0.048, x + 0.048, lift(0.8), lift(1.42), side * (W - WALL), outer));
    }
    P.add('paint', box(1.66, 1.78, lift(0.8), lift(1.42), side * 0.88, outer)); // windscreen post
    P.add('dark', box(1.82, 1.88, lift(0.96), lift(1.24), side * 1.12, side * 1.28)); // mirror
    // Front wing over the wheel; tyres and hubs; headlamp in its chrome ring.
    P.add('trim', cylinder(0.46, 0.46, 0.2, 10, 'z', 2.12, 0.46, side * 0.915));
    for (const x of JEEPNEY_AXLES) {
      P.add(
        'tire',
        cylinder(WHEEL_RADIUS, WHEEL_RADIUS, 0.26, 10, 'z', x, WHEEL_RADIUS, side * 0.9),
      );
      P.add('hub', cylinder(0.21, 0.21, 0.02, 8, 'z', x, WHEEL_RADIUS, side * 1.04));
    }
    P.add('chrome', cylinder(0.15, 0.15, 0.06, 8, 'x', 3.02, lift(0.5), side * 0.58));
    P.add('lamp', cylinder(0.12, 0.12, 0.04, 8, 'x', 3.06, lift(0.5), side * 0.58));
    P.add('tail', box(xr - 0.035, xr, lift(0.42), lift(0.62), side * 0.81, side * 0.95));
    // Either side of the open entrance at the back.
    P.add('paint', box(xr - PROUD, xr, lift(0.8), lift(1.42), side * 0.86, outer));
    P.add('chrome', cylinder(0.025, 0.025, 1.3, 6, 'y', xr - 0.06, lift(0.78), side * 0.45));
  }
  P.add('glass', box(xr - PROUD, xr, lift(0.05), lift(1.42), -0.45, 0.45)); // the entrance
  P.add('chrome', box(1.73, 1.79, lift(0.78), lift(0.86), -0.92, 0.92)); // windscreen frame
  P.add('paint', box(1.8, 1.82, lift(1.48), lift(1.63), -W, W)); // above the windscreen
  P.add('chrome', box(1.9, 2.08, lift(1.86), lift(2.2), -0.88, 0.88)); // signboard frame
  P.add('sign', box(2.08, 2.1, lift(1.89), lift(2.17), -0.85, 0.85));
  P.add('dark', box(3.0, 3.065, lift(0.18), lift(0.74), -0.4, 0.4)); // grille
  P.add('chrome', box(3.02, 3.085, lift(0.74), lift(0.79), -0.43, 0.43));
  P.add('chrome', box(3.02, 3.085, lift(0.13), lift(0.18), -0.43, 0.43));
  P.add('trim', box(3.08, 3.3, lift(-0.22), lift(0.1), -1.16, 1.16)); // bumpers and the step
  P.add('trim', box(-3.28, -3.06, lift(-0.2), lift(0), -1.02, 1.02));
  P.add('trim', box(-3.52, -3.28, lift(-0.22), lift(-0.16), -0.58, 0.58));
  return P.merge();
}

/** Where the sides change, as vehicleGeometry.ts builds each kind. */
const SHAPES: Record<
  VehicleKind,
  {
    roof: number;
    skirt: number;
    belt: number;
    top: number;
    /** Window to window along the side. */
    pitch: number;
    /** The roof unit: along, and half its width (none on a van, its roof is the top). */
    unit: readonly [number, number, number] | null;
    /** Bottom and top of the windscreen, and of the rear window. */
    screen: readonly [number, number];
    rearWindow: readonly [number, number];
    stripes: ReadonlyArray<readonly ['stripe' | 'stripe2', number, number]>;
    sign: readonly [number, number, number];
  }
> = {
  bus: {
    roof: 3.2,
    skirt: 0.3,
    belt: 1.75,
    top: 2.85,
    pitch: 1.3,
    unit: [-2.2, 1.6, 0.85],
    screen: [1.02, 2.8],
    rearWindow: [1.9, 2.75],
    stripes: [
      ['stripe', 1.47, 1.63],
      ['stripe2', 1.2, 1.27],
    ],
    sign: [2.9, 3.12, 1.0],
  },
  modern: {
    roof: 2.68,
    skirt: 0.42,
    belt: 1.45,
    top: 2.3,
    pitch: 0.95,
    unit: [-1.6, 0.8, 0.8],
    screen: [1.17, 2.32],
    rearWindow: [1.55, 2.3],
    stripes: [
      ['stripe', 1.15, 1.33],
      ['stripe2', 1.09, 1.13],
    ],
    sign: [2.38, 2.6, 0.9],
  },
  uv: {
    roof: 2.285,
    skirt: 0.3,
    belt: 1.08,
    top: 1.9,
    pitch: 0.95,
    unit: null,
    screen: [1.08, 1.95],
    rearWindow: [1.25, 1.95],
    stripes: [
      ['stripe', 0.85, 0.98],
      ['stripe2', 0.99, 1.02],
    ],
    sign: [1.15, 1.33, 0.3],
  },
};

/** Where a van's windscreen meets its roof, and where its bonnet starts. */
const UV_CAB_X = 1.25;
const UV_BONNET_X = 1.95;

function puv(kind: VehicleKind, near: boolean): VehicleParts {
  const S = VEHICLES[kind];
  const shape = SHAPES[kind];
  const { roof, skirt, belt, top } = shape;
  const P = new Parts();
  const hw = S.widthM / 2;
  const xr = -S.lengthM / 2;
  const xf = S.lengthM / 2;
  const r = S.wheelRadiusM;
  const van = kind === 'uv';
  const lowerEnd = van ? UV_BONNET_X : xf;
  const upperEnd = van ? UV_CAB_X : xf;

  P.add('paint', box(xr, lowerEnd, skirt, belt, -hw, hw));
  P.add('glass', box(xr + 0.02, upperEnd, belt, top, -hw + 0.03, hw - 0.03));
  P.add('paint', box(xr, upperEnd, top, roof - 0.03, -hw, hw));
  P.add('paint', box(xr, upperEnd, roof - 0.03, roof, -hw - PROUD, hw + PROUD));
  if (shape.unit) {
    const [x0, x1, half] = shape.unit;
    P.add('trim', box(x0, x1, roof, S.heightM, -half, half));
  }
  if (van) {
    // Windscreen, raked from the roof down to the bonnet, and the bonnet.
    P.add('glass', box(UV_CAB_X, UV_BONNET_X, belt, top, -hw + 0.08, hw - 0.08));
    P.add('paint', box(UV_CAB_X, UV_BONNET_X, top, roof - 0.03, -hw + 0.08, hw - 0.08));
    P.add('paint', box(UV_BONNET_X, xf - 0.1, 0.3, 1.06, -hw, hw));
  }
  // Far off, the main stripe alone, made bold.
  for (const [slot, y0, y1] of near ? shape.stripes : shape.stripes.slice(0, 1)) {
    const band = near ? 0 : FAR_BAND_M;
    P.add(
      slot,
      box(xr - PROUD, lowerEnd + PROUD, y0 - band, y1 + band, -hw - PROUD / 2, hw + PROUD / 2),
    );
  }

  if (!near) {
    for (const x of S.axles) P.add('tire', box(x - r, x + r, 0, skirt, -hw + 0.04, hw - 0.04));
    return P.merge();
  }

  P.add('dark', box(xr + 0.1, xf - 0.1, 0.2, skirt - 0.01, -hw + 0.2, hw - 0.2)); // underneath
  const faceX = van ? xf - 0.1 : xf;
  for (const side of SIDES) {
    const outer = side * hw;
    const off = (d: number) => outer + side * d;
    // Pillars between the windows.
    for (let x = xr + 0.35; x < upperEnd; x += shape.pitch)
      P.add('dark', box(x - 0.05, x + 0.05, belt, top, side * (hw - 0.03), outer));
    // Wheels in their arches, and the mirror.
    for (const x of S.axles) {
      P.add('dark', cylinder(r + 0.07, r + 0.07, 0.03, 10, 'z', x, r + 0.07, outer));
      P.add('tire', cylinder(r, r, 0.26, 10, 'z', x, r, side * (hw - 0.1)));
      P.add('hub', cylinder(r * 0.55, r * 0.55, 0.02, 8, 'z', x, r, side * (hw + 0.04)));
    }
    P.add('dark', box(xf - 0.2, xf - 0.1, belt - 0.2, belt + 0.25, off(0.04), off(0.2)));
    // Headlamp, tail lamp.
    P.add('lamp', box(faceX, faceX + 0.025, 0.65, 0.88, side * 0.58, side * 0.98));
    P.add('tail', box(xr - 0.02, xr, 0.65, 1.3, side * (hw - 0.15), side * (hw - 0.02)));
  }
  // Every door on the kerb side, its glass with a dark frame.
  for (const d of S.doors) {
    P.add('dark', box(d.x0, d.x1, Math.max(d.y0, skirt + 0.01), d.y1, hw, hw + PROUD * 2));
    P.add(
      'glass',
      box(d.x0 + 0.06, d.x1 - 0.06, d.y0 + 0.3, d.y1 - 0.06, hw + PROUD * 2, hw + PROUD * 3),
    );
  }
  const [screen0, screen1] = shape.screen;
  if (!van) {
    P.add('dark', box(xf, xf + 0.01, screen0 - 0.04, screen1 + 0.04, -hw + 0.06, hw - 0.06));
    P.add('glass', box(xf + 0.01, xf + 0.02, screen0, screen1, -hw + 0.1, hw - 0.1));
  }
  const [sign0, sign1, signHalf] = shape.sign;
  const signX = van ? UV_BONNET_X : xf;
  P.add('sign', box(signX + 0.01, signX + 0.03, sign0, sign1, -signHalf, signHalf));
  P.add('trim', box(xf - 0.03, xf + 0.13, skirt - 0.04, skirt + 0.22, -hw - 0.02, hw + 0.02));
  P.add('trim', box(xr - 0.13, xr + 0.03, skirt - 0.04, skirt + 0.22, -hw - 0.02, hw + 0.02));
  P.add('dark', box(faceX, faceX + 0.012, 0.6, 0.9, -0.5, 0.5)); // grille
  const [rear0, rear1] = shape.rearWindow;
  P.add('glass', box(xr - PROUD, xr, rear0, rear1, -hw + 0.18, hw - 0.18));
  return P.merge();
}

const built = new Map<string, VehicleParts>();

/** A kind's model in parts by colour slot (shared: leave them as they are). */
export function trafficParts(kind: FleetKind, detail: TrafficDetail): VehicleParts {
  const key = `${kind}:${detail}`;
  let parts = built.get(key);
  if (!parts) {
    parts = kind === 'jeepney' ? jeepney(detail === 'near') : puv(kind, detail === 'near');
    built.set(key, parts);
  }
  return parts;
}

/** The colour of each slot, for one look. */
function colours(look: TrafficLook): Partial<Record<Slot, string>> {
  const shared = {
    lamp: PALETTE.lamp,
    tail: PALETTE.tail,
    tire: PALETTE.tire,
    hub: PALETTE.hub,
    chrome: PALETTE.chrome,
  };
  if (look === 'red' || look === 'yellow' || look === 'green') {
    const L = LIVERIES[look];
    return {
      ...shared,
      paint: PALETTE.body,
      stripe: L.accent,
      stripe2: L.accent2,
      sign: L.sign,
      trim: PALETTE.trim,
      dark: PALETTE.dark,
      glass: CABIN,
    };
  }
  const L = LIVERY[look];
  return {
    ...shared,
    paint: '#f4f4f2',
    stripe: L.stripe,
    stripe2: L.stripe2,
    sign: '#ff9f1c',
    trim: '#9aa0a6',
    dark: '#2a2d31',
    // Tinted glass with the lit cabin behind it: the full model's two together.
    glass: `#${new Color(L.tint).lerp(new Color(CABIN), 0.45).getHexString()}`,
  };
}

/**
 * A window band a pixel or so tall, between white panels: dark, it flips whole
 * pixels as the view moves. From there the eye blends them anyway, so the far
 * model is painted already blended.
 */
const FAR_GLASS_BLEND = 0.4;
const softened = (glass: string, body: string): string =>
  `#${new Color(glass).lerp(new Color(body), FAR_GLASS_BLEND).getHexString()}`;

const models = new Map<string, BufferGeometry>();

/** One look's model: position, normal and baked colour, one draw call. */
export function trafficModel(look: TrafficLook, detail: TrafficDetail): BufferGeometry {
  const key = `${look}:${detail}`;
  const cached = models.get(key);
  if (cached) return cached;
  const kind: FleetKind =
    look === 'red' || look === 'yellow' || look === 'green' ? 'jeepney' : look;
  const parts = Object.entries(trafficParts(kind, detail)) as [Slot, BufferGeometry][];
  const paint = colours(look);
  if (detail === 'far') paint.glass = softened(paint.glass!, paint.paint!);
  const model = bakeColours(parts.map(([slot, g]) => [g, new Color(paint[slot]!)]));
  models.set(key, model);
  return model;
}
