/**
 * Parts shared by the box-bodied vehicles (modern jeepney, UV Express van,
 * city bus): side walls cut round their doors and wheels, steps up from a
 * door to the floor, open doors, seats, wheels, and the door camera's mount.
 *
 * Frame: metres, ground at y = 0, +x the front, +z the kerb side (see
 * core/vehicles/specs.ts). Every part goes into a material slot and each
 * slot is merged into one geometry (geometryKit.mergeParts).
 */

import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  RingGeometry,
  type BufferGeometry,
} from 'three';
import type { Seat } from '@/core/people/riderMotion';
import type { DoorSpec } from '@/core/vehicles/specs';
import { arch, box, cylinder, mergeParts, roundedBox as rbox } from '../jeepney/geometryKit';

export type Slot =
  | 'paint'
  | 'stripe'
  | 'stripe2'
  | 'trim'
  | 'dark'
  | 'floor'
  | 'seat'
  | 'chrome'
  | 'glass'
  | 'lamp'
  | 'tail'
  | 'sign'
  | 'nosing'
  | 'tire'
  | 'hub'
  | 'interior';

export type VehicleParts = Partial<Record<Slot, BufferGeometry>>;

export class Parts {
  readonly p = new Map<Slot, BufferGeometry[]>();
  add(slot: Slot, ...g: BufferGeometry[]): void {
    const list = this.p.get(slot) ?? [];
    list.push(...g);
    this.p.set(slot, list);
  }
  merge(): VehicleParts {
    const out: VehicleParts = {};
    for (const [slot, list] of this.p) {
      const g = mergeParts(list);
      if (g) out[slot] = g;
    }
    return out;
  }
}

/** Body walls are this thick (metres). */
export const WALL = 0.05;
/** The body round a wheel arch is cut in this many bands (a rounded opening). */
const ARCH_BANDS = 10;
/** Between a tyre and the edge of its arch (metres). */
export const ARCH_GAP_M = 0.06;
/** A tyre is this much of its radius wide (195/70 R15: 0.195 m on 0.327 m). */
const TYRE_WIDTH = 0.55;

/** The wheel arch's radius, for a wheel of radius r. */
export const archRadius = (r: number) => r + ARCH_GAP_M;

/** Centres of the tyres across from the middle (one, or two side by side). */
function tyreZ(r: number, halfW: number, dual: boolean): number[] {
  const w = r * TYRE_WIDTH;
  return dual ? [halfW - 0.1 - w / 2, halfW - 0.12 - 1.5 * w] : [halfW - 0.1 - w / 2];
}

/** How far in from the side a wheel's well reaches: past its innermost tyre. */
export function wellDepth(r: number, halfW: number, dual: boolean): number {
  const zs = tyreZ(r, halfW, dual);
  return halfW - (zs[zs.length - 1]! - (r * TYRE_WIDTH) / 2) + 0.05;
}
/** One step up from a door: at most this rise, this deep. */
const STEP_RISE = 0.2;
const STEP_DEPTH = 0.28;

export interface WallSpec {
  /** +1 the kerb side (the doors), -1 the driver's side. */
  side: 1 | -1;
  x0: number;
  x1: number;
  halfW: number;
  /** Bottom of the body, window sill, window top, roof line. */
  skirt: number;
  belt: number;
  top: number;
  roof: number;
  doors: readonly DoorSpec[];
  wheels: readonly number[];
  wheelR: number;
  /** Wheel wells this deep (wellDepth); default for single tyres. */
  wellM?: number;
  /** Above the windowsill the wall ends here (a van's cab and windscreen beyond). */
  upperX1?: number;
  /** Window pillars about this far apart. */
  pitch: number;
  /** Glazing only between these (solid panels beyond, e.g. over an engine). */
  windowX0?: number;
  windowX1?: number;
  /** Window pillars: dark (glazed in rubber, a bus) or the body colour. */
  pillar?: Slot;
}

/** [a, b] less the given ranges, as the pieces left. */
function minus(a: number, b: number, cut: ReadonlyArray<readonly [number, number]>) {
  let pieces: Array<[number, number]> = [[a, b]];
  for (const [c0, c1] of cut) {
    pieces = pieces.flatMap(([p0, p1]): Array<[number, number]> => {
      if (c1 <= p0 || c0 >= p1) return [[p0, p1]];
      const out: Array<[number, number]> = [];
      if (c0 > p0) out.push([p0, c0]);
      if (c1 < p1) out.push([c1, p1]);
      return out;
    });
  }
  return pieces.filter(([p0, p1]) => p1 - p0 > 0.005);
}

/**
 * A side wall: below the windows (cut round the wheels), the glazed band
 * with its pillars, and above; open where the doors are, with a header over
 * each door and its jambs.
 */
export function sideWall(P: Parts, w: WallSpec): void {
  const zo = w.side * w.halfW;
  const zi = w.side * (w.halfW - WALL);
  const R = archRadius(w.wheelR);
  const archTop = w.wheelR + R;
  // A door down to the bottom of the body cuts the wall from top to bottom;
  // one whose sill is above the wheel arch (a van's cab door) only above it.
  const all = w.side === 1 ? w.doors : [];
  const doors = all.filter((d) => d.y0 < archTop - 1e-6);
  const raised = all.filter((d) => d.y0 >= archTop - 1e-6);
  const raisedCuts = raised.map((d) => [d.x0, d.x1] as const);
  const wheelCuts = w.wheels.map((x) => [x - R, x + R] as const);
  const doorCuts = doors.map((d) => [d.x0, d.x1] as const);
  const winX0 = w.windowX0 ?? -Infinity;
  const winX1 = w.windowX1 ?? Infinity;
  const upperX1 = w.upperX1 ?? w.x1;
  for (const [a, x1] of minus(w.x0, w.x1, doorCuts)) {
    let b = x1;
    // Below the windows: over the wheel arches; between them, one panel down
    // to the skirt (no seams across it).
    for (const [c0, c1] of minus(a, b, raisedCuts))
      P.add('paint', box(c0, c1, archTop, w.belt, zi, zo));
    for (const [c0, c1] of minus(a, b, wheelCuts))
      P.add('paint', box(c0, c1, w.skirt, archTop, zi, zo));
    // Beside each wheel, above the axle, the corners of the opening filled in
    // bands to round it to the arch. The circle's width at the middle of each
    // band: the steps either side of it stay under the arch's lip.
    for (const x of w.wheels)
      for (let k = 0; k < ARCH_BANDS; k++) {
        const y0 = w.wheelR + ((archTop - w.wheelR) * k) / ARCH_BANDS;
        const y1 = w.wheelR + ((archTop - w.wheelR) * (k + 1)) / ARCH_BANDS;
        const half = Math.sqrt(Math.max(0, R * R - ((y0 + y1) / 2 - w.wheelR) ** 2));
        for (const [c0, c1] of [
          [x - R, x - half],
          [x + half, x + R],
        ] as const) {
          const lo = Math.max(a, c0);
          const hi = Math.min(b, c1);
          if (hi - lo > 0.002) P.add('paint', box(lo, hi, y0, y1, zi, zo));
        }
      }
    // The window band: glass, solid outside the glazed stretch, pillars.
    if (a >= upperX1) continue;
    b = Math.min(b, upperX1);
    const g0 = Math.max(a, winX0);
    const g1 = Math.min(b, winX1);
    if (g1 - g0 > 0.2) {
      P.add('glass', box(g0, g1, w.belt, w.top, zo - w.side * 0.02, zo - w.side * 0.032));
      const n = Math.max(1, Math.round((g1 - g0) / w.pitch));
      for (let k = 0; k <= n; k++) {
        const x = g0 + ((g1 - g0) * k) / n;
        P.add(
          w.pillar ?? 'paint',
          box(x - 0.045, x + 0.045, w.belt, w.top, zi - w.side * 0.003, zo + w.side * 0.004),
        );
      }
      // Sill and head of the glazing.
      P.add('dark', box(g0, g1, w.belt - 0.02, w.belt + 0.02, zo, zo + w.side * 0.01));
      P.add('dark', box(g0, g1, w.top - 0.02, w.top + 0.02, zo, zo + w.side * 0.01));
    }
    for (const [s0, s1] of [
      [a, Math.min(b, g0)],
      [Math.max(a, g1), b],
    ] as const)
      if (s1 - s0 > 0.005) P.add('paint', box(s0, s1, w.belt, w.top, zi, zo));
    // Above the windows, to the roof.
    P.add('paint', box(a, b, w.top, w.roof, zi, zo));
  }
  // Under a raised door: the sill, from the top of the arch.
  for (const d of raised) {
    if (d.y0 - archTop > 0.002) P.add('paint', box(d.x0, d.x1, archTop, d.y0, zi, zo));
    if (d.x0 < upperX1) P.add('paint', box(d.x0, Math.min(d.x1, upperX1), d.y1, w.roof, zi, zo));
  }
  for (const d of doors) {
    P.add('paint', box(d.x0, d.x1, d.y1, w.roof, zi, zo)); // header
    P.add('dark', box(d.x0, d.x1, w.skirt, d.y0, zi, zo)); // under the bottom step
    // Jambs: posts either side of the opening (from just above the bottom
    // step, which may be level with the bottom of the body).
    for (const x of [d.x0, d.x1])
      P.add(
        'trim',
        box(x - 0.03, x + 0.03, d.y0 + 0.004, d.y1, zi - w.side * 0.02, zo + w.side * 0.008),
      );
  }
  // Each wheel arch: a body-coloured lip round the opening, standing a
  // little proud (it covers the stepped edge of the panels), and the well
  // behind it: a dark liner over the tyre and a wall at the back.
  const lip: BufferGeometry[] = [];
  const liner: BufferGeometry[] = [];
  const back = w.side * (w.halfW - (w.wellM ?? wellDepth(w.wheelR, w.halfW, false)));
  for (const x of w.wheels) {
    arch(
      lip,
      x,
      w.wheelR,
      R + 0.005,
      0.07,
      zo - w.side * 0.004,
      zo + w.side * 0.016,
      0,
      Math.PI,
      48,
    );
    arch(liner, x, w.wheelR, R + 0.04, 0.02, zi, back, 0, Math.PI, 48);
    P.add(
      'dark',
      box(x - R - 0.05, x + R + 0.05, w.skirt - 0.05, archTop + 0.05, back, back - w.side * 0.02),
    );
  }
  P.add('paint', ...lip);
  P.add('dark', ...liner);
}

/**
 * Under the floor: a dark plate beneath it and the chassis rails down the
 * middle (the side panels hide the rest; the wheel wells show the dark).
 */
export function underbody(
  P: Parts,
  x0: number,
  x1: number,
  halfW: number,
  floor: number,
  skirt: number,
): void {
  P.add(
    'dark',
    box(x0, x1, floor - 0.09, floor - 0.06, -halfW + WALL + 0.002, halfW - WALL - 0.002),
  );
  P.add('dark', box(x0 + 0.2, x1 - 0.2, skirt - 0.05, floor - 0.09, -halfW * 0.38, halfW * 0.38));
}

/**
 * Steps from a door's bottom step up to the floor, inward; and the floor
 * itself everywhere else (kept clear of the stair wells).
 */
export function floorWithSteps(
  P: Parts,
  x0: number,
  x1: number,
  halfW: number,
  floor: number,
  doors: readonly DoorSpec[],
  wheel?: Wheels,
): void {
  const wells: Array<readonly [number, number]> = [];
  const inner = halfW - WALL;
  for (const d of doors) {
    if (d.opens === 'hinged') continue; // a step outside it (runningBoard), no stair well
    const n = Math.max(1, Math.ceil((floor - d.y0) / STEP_RISE - 0.01));
    const rise = (floor - d.y0) / n;
    for (let k = 0; k < n; k++) {
      const top = d.y0 + k * rise;
      P.add(
        'floor',
        box(
          d.x0 + 0.03,
          d.x1 - 0.03,
          top - 0.04,
          top,
          inner - k * STEP_DEPTH,
          inner - (k + 1) * STEP_DEPTH,
        ),
      );
      P.add(
        'dark',
        box(
          d.x0 + 0.03,
          d.x1 - 0.03,
          d.y0 - 0.2,
          top - 0.04,
          inner - k * STEP_DEPTH,
          inner - (k + 1) * STEP_DEPTH,
        ),
      );
      // Yellow nosing on each step, as on every PUV: over its edge, a little proud.
      P.add(
        'nosing',
        box(
          d.x0 + 0.035,
          d.x1 - 0.035,
          top - 0.03,
          top + 0.004,
          inner - k * STEP_DEPTH + 0.003,
          inner - k * STEP_DEPTH - 0.05,
        ),
      );
    }
    const well = inner - n * STEP_DEPTH;
    P.add('floor', box(d.x0, d.x1, floor - 0.05, floor, -inner, well));
    P.add(
      'nosing',
      box(d.x0 + 0.035, d.x1 - 0.035, floor - 0.03, floor + 0.004, well + 0.003, well - 0.05),
    );
    wells.push([d.x0, d.x1]);
    // A grab pole each side of the stairs, clear of the folded door leaves.
    for (const x of [d.x0 + 0.15, d.x1 - 0.15])
      P.add(
        'chrome',
        cylinder(0.018, 0.018, d.y1 - d.y0 - 0.1, 8, 'y', x, (d.y0 + d.y1) / 2, inner - 0.12),
      );
  }
  // Over the wheels the floor stops at the wheel housings (wheelHousings).
  const spans = wheel && wheelPokesUp(wheel, floor) ? housingSpans(wheel) : [];
  const narrow = wheel ? halfW - wheel.wellM - 0.03 : inner;
  for (const [a, b] of minus(x0, x1, wells)) {
    for (const [c0, c1] of minus(a, b, spans))
      P.add('floor', box(c0, c1, floor - 0.05, floor, -inner + 0.002, inner - 0.002));
    for (const [h0, h1] of spans) {
      const c0 = Math.max(a, h0);
      const c1 = Math.min(b, h1);
      if (c1 - c0 > 0.005) P.add('floor', box(c0, c1, floor - 0.05, floor, -narrow, narrow));
    }
  }
}

/**
 * Where a foot goes on the way in through door `d`: the middle of each step
 * up (floorWithSteps), and a pace onto the floor past the top one. A hinged
 * cab door: its running board outside, the sill, then the cab floor.
 */
export function footholds(
  d: DoorSpec,
  halfW: number,
  floor: number,
): Array<readonly [number, number]> {
  const inner = halfW - WALL;
  if (d.opens === 'hinged')
    return [
      [RUNNING_BOARD_Y, halfW + 0.09],
      [d.y0, halfW - 0.03],
      [floor, halfW - 0.3],
    ];
  const n = Math.max(1, Math.ceil((floor - d.y0) / STEP_RISE - 0.01));
  const rise = (floor - d.y0) / n;
  const steps: Array<readonly [number, number]> = [];
  for (let k = 0; k < n; k++) steps.push([d.y0 + k * rise, inner - (k + 0.5) * STEP_DEPTH]);
  steps.push([floor, inner - n * STEP_DEPTH - 0.15]);
  return steps;
}

/** Top of the step outside a hinged cab door. */
const RUNNING_BOARD_Y = 0.42;

/** The step outside a hinged cab door, behind the front wheel, and its bracket. */
export function runningBoard(P: Parts, d: DoorSpec, halfW: number): void {
  P.add(
    'dark',
    box(
      d.x0 + 0.02,
      d.x0 + 0.24,
      RUNNING_BOARD_Y - 0.04,
      RUNNING_BOARD_Y,
      halfW + 0.01,
      halfW + 0.17,
    ),
  );
  P.add(
    'dark',
    box(
      d.x0 + 0.1,
      d.x0 + 0.16,
      RUNNING_BOARD_Y - 0.14,
      RUNNING_BOARD_Y - 0.04,
      halfW - 0.02,
      halfW + 0.05,
    ),
  );
}

/** The wheels under a body: where along it, their radius, how deep their wells. */
export interface Wheels {
  xs: readonly number[];
  r: number;
  wellM: number;
}

/** The wheel wells reach above the bottom of the floor. */
function wheelPokesUp(wheel: Wheels, floor: number): boolean {
  return wheel.r + archRadius(wheel.r) + 0.06 > floor - 0.05;
}

function housingSpans(wheel: Wheels): Array<readonly [number, number]> {
  const R = archRadius(wheel.r) + 0.07;
  return wheel.xs.map((x) => [x - R, x + R] as const);
}

/**
 * Inside, over each wheel well that rises above the floor: a housing (the
 * hump a wheel makes in a van's or a bus's floor), from the wall in past the
 * tyres.
 */
export function wheelHousings(P: Parts, halfW: number, floor: number, wheel: Wheels): void {
  if (!wheelPokesUp(wheel, floor)) return;
  const top = wheel.r + archRadius(wheel.r) + 0.08;
  for (const [a, b] of housingSpans(wheel))
    for (const side of [-1, 1])
      P.add(
        'trim',
        rbox(
          a,
          b,
          floor - 0.04,
          Math.max(top, floor + 0.04),
          side * (halfW - WALL - 0.002),
          side * (halfW - wheel.wellM - 0.03),
          0.04,
        ),
      );
}

/** How a vehicle's doors are drawn: shut while it drives, open at a stop. */
export type DoorState = 'open' | 'closed';

/**
 * A door, open or shut. Folding: four glazed leaves, across the opening
 * when shut, folded against the jambs when open. Sliding: a panel with its
 * window and the livery band, run back along the outside when open.
 * Hinged (a van's cab door): swung out on its front edge when open.
 */
export function door(
  P: Parts,
  d: DoorSpec,
  halfW: number,
  state: DoorState,
  livery: ReadonlyArray<readonly [Slot, number, number]> = [],
  belt = 0,
  top = 0,
): void {
  const h0 = d.y0 + 0.05;
  const h1 = d.y1 - 0.03;
  const zo = halfW;
  if (d.opens === 'folding') {
    if (state === 'closed') {
      P.add('glass', box(d.x0 + 0.03, d.x1 - 0.03, h0 + 0.12, h1 - 0.12, zo - 0.045, zo - 0.025));
      for (const [y0, y1] of [
        [h0, h0 + 0.12],
        [h1 - 0.12, h1],
      ] as const)
        P.add('trim', box(d.x0 + 0.03, d.x1 - 0.03, y0, y1, zo - 0.05, zo - 0.02));
      const leaf = (d.x1 - d.x0 - 0.06) / 4;
      for (let k = 1; k < 4; k++) {
        const x = d.x0 + 0.03 + k * leaf;
        P.add(
          k === 2 ? 'dark' : 'trim',
          box(x - 0.015, x + 0.015, h0 + 0.12, h1 - 0.12, zo - 0.052, zo - 0.018),
        );
      }
      return;
    }
    // Two glazed leaves each side, folded flat against the jambs, clear of the steps.
    const leaf = (d.x1 - d.x0) / 4;
    for (const [x, dir] of [
      [d.x0, 1],
      [d.x1, -1],
    ] as const) {
      for (let k = 0; k < 2; k++) {
        const at = x + dir * (0.05 + k * 0.035);
        P.add(
          'glass',
          box(at - 0.012, at + 0.012, h0 + 0.12, h1 - 0.12, zo - 0.055, zo - (0.04 + leaf)),
        );
        for (const [y0, y1] of [
          [h0, h0 + 0.12],
          [h1 - 0.12, h1],
        ] as const)
          P.add('trim', box(at - 0.015, at + 0.015, y0, y1, zo - 0.05, zo - (0.05 + leaf)));
        P.add('trim', box(at - 0.015, at + 0.015, h0, h1, zo - (0.03 + leaf), zo - (0.05 + leaf)));
      }
    }
    return;
  }
  // A panel door (sliding or hinged): built shut in the opening, then moved
  // (slid back outside the body, or swung out on its front edge) when open.
  const panel = new Parts();
  const z0 = zo - 0.04;
  const z1 = zo - 0.003;
  const a = d.x0 + 0.01;
  const b = d.x1 - 0.01;
  panel.add('paint', box(a, b, d.y0 + 0.012, belt, z0, z1));
  if (d.opens === 'hinged') {
    // Its window steps down at the front, under the raked windscreen pillar.
    const mid = (belt + h1) / 2;
    const back = a + (b - a) * 0.25;
    const front = b - 0.22;
    panel.add('paint', box(a, a + 0.04, belt, h1, z0, z1));
    panel.add('paint', box(a + 0.04, back, h1 - 0.04, h1, z0, z1));
    panel.add('glass', box(a + 0.04, back, belt, h1 - 0.04, zo - 0.03, zo - 0.02));
    panel.add('paint', box(back, front, mid - 0.03, mid, z0, z1));
    panel.add('paint', box(front - 0.04, front, belt, mid - 0.03, z0, z1));
    panel.add('glass', box(back, front - 0.04, belt, mid - 0.03, zo - 0.03, zo - 0.02));
    panel.add('dark', box(a + 0.04, front - 0.04, belt - 0.015, belt + 0.015, z1, z1 + 0.006));
  } else {
    const winTop = Math.min(top, h1) - 0.03;
    panel.add('paint', box(a, a + 0.05, belt, h1, z0, z1));
    panel.add('paint', box(b - 0.05, b, belt, h1, z0, z1));
    panel.add('paint', box(a + 0.05, b - 0.05, winTop, h1, z0, z1));
    panel.add('glass', box(a + 0.05, b - 0.05, belt, winTop, zo - 0.03, zo - 0.02));
    panel.add('dark', box(a + 0.05, b - 0.05, belt - 0.015, belt + 0.015, z1, z1 + 0.006));
  }
  for (const [slot, y0, y1] of livery) panel.add(slot, box(a, b, y0, y1, z1, z1 + 0.006));
  // The handle at the back edge (the front edge on a cab door: it is hinged at the front).
  const hx = d.opens === 'hinged' ? a + 0.08 : a + 0.06;
  panel.add('chrome', box(hx, hx + 0.12, belt - 0.12, belt - 0.08, z1, z1 + 0.02));
  if (state === 'open' && d.opens === 'sliding') {
    const w = d.x1 - d.x0;
    for (const [slot, list] of panel.p) for (const g of list) P.add(slot, g.translate(-w, 0, 0.08));
    // The rail it runs on, along the body behind the opening.
    P.add('dark', box(d.x0 - w - 0.1, d.x0 - 0.02, h1 - 0.1, h1 - 0.07, zo + 0.002, zo + 0.03));
    return;
  }
  if (state === 'open' && d.opens === 'hinged') {
    // Swung out about 70° on the hinge at its front edge.
    for (const [slot, list] of panel.p)
      for (const g of list)
        P.add(
          slot,
          g
            .translate(-d.x1, 0, -zo)
            .rotateY(1.2)
            .translate(d.x1, 0, zo + 0.01),
        );
    return;
  }
  for (const [slot, list] of panel.p) P.add(slot, ...list);
}

/** Hips sit this far forward of a seat back, and this high above the root when seated (personRig). */
const HIPS_FROM_BACK_M = 0.1;
const SEATED_HIP_M = 0.74;
const CUSHION_SINK_M = 0.07;
/** Root height of someone seated on a cushion whose top is at `seatTop`. */
export const seatedRoot = (seatTop: number) => seatTop + CUSHION_SINK_M - SEATED_HIP_M;

/**
 * A forward-facing seat for riders side by side from z0 to z1, its front
 * edge at x. Returns each place: hips just in front of the seat back, and
 * the spot `stand` in front of the cushion where they stand before sitting.
 */
export function forwardSeat(
  P: Parts,
  x: number,
  z0: number,
  z1: number,
  floor: number,
  rail = true,
  stand = 0.12,
): Seat[] {
  const places: Seat[] = [];
  const seatTop = floor + 0.45;
  const n = Math.max(1, Math.round(Math.abs(z1 - z0) / 0.44));
  const step = (z1 - z0) / n;
  P.add('trim', box(x - 0.36, x - 0.08, floor, seatTop - 0.09, z0 + step * 0.1, z1 - step * 0.1));
  for (let k = 0; k < n; k++) {
    const a = z0 + k * step + 0.02 * Math.sign(step);
    const b = z0 + (k + 1) * step - 0.02 * Math.sign(step);
    P.add('seat', rbox(x - 0.46, x, seatTop - 0.1, seatTop, a, b, 0.04));
    const back = new BoxGeometry(0.1, 0.62, Math.abs(b - a));
    back.rotateZ(0.14);
    back.translate(x - 0.48, seatTop + 0.3, (a + b) / 2);
    P.add('seat', back);
    // The back's front face is about x - 0.43 at hip height.
    places.push({
      x: x - 0.43 + HIPS_FROM_BACK_M,
      z: (a + b) / 2,
      yaw: 0,
      y: seatedRoot(seatTop),
      standX: x + stand,
    });
  }
  if (rail)
    P.add(
      'chrome',
      cylinder(
        0.014,
        0.014,
        Math.abs(z1 - z0) - 0.06,
        8,
        'z',
        x - 0.6,
        seatTop + 0.66,
        (z0 + z1) / 2,
      ),
    );
  return places;
}

/** Side-facing seats along a wall, x0..x1: `perSeat` metres each, backs to the wall. */
export function sideSeats(
  P: Parts,
  x0: number,
  x1: number,
  side: 1 | -1,
  halfW: number,
  floor: number,
  perSeat = 0.44,
): Seat[] {
  const places: Seat[] = [];
  const n = Math.floor((x1 - x0) / perSeat);
  const seatTop = floor + 0.44;
  const wall = side * (halfW - WALL);
  const front = side * (halfW - WALL - 0.44);
  P.add('trim', box(x0, x0 + n * perSeat, floor, seatTop - 0.09, wall, front + side * 0.06));
  for (let k = 0; k < n; k++) {
    const a = x0 + k * perSeat + 0.02;
    const b = x0 + (k + 1) * perSeat - 0.02;
    P.add('seat', rbox(a, b, seatTop - 0.1, seatTop, wall - side * 0.02, front, 0.04));
    P.add('seat', rbox(a, b, seatTop + 0.04, seatTop + 0.5, wall, wall - side * 0.09, 0.03));
    // Facing across the aisle, backs to the wall (as on a jeepney's benches).
    places.push({
      x: (a + b) / 2,
      z: side * (halfW - WALL - 0.09 - HIPS_FROM_BACK_M),
      yaw: side > 0 ? Math.PI / 2 : -Math.PI / 2,
      y: seatedRoot(seatTop),
    });
  }
  return places;
}

/**
 * Wheels at each end of the axle: a tyre (two side by side where `dual`),
 * hollow, its sidewalls round a steel rim set back into it, with a centre
 * boss, `studs` wheel nuts and as many vent holes.
 */
export function wheels(
  P: Parts,
  x: number,
  r: number,
  halfW: number,
  dual: boolean,
  studs = 6,
  /** Which ends: both, or one alone (a front wheel, which steers on its own). */
  sides: readonly number[] = [-1, 1],
): void {
  const w = r * TYRE_WIDTH;
  const rim = r * 0.62;
  const recess = Math.min(0.045, w * 0.25);
  const facing = (g: BufferGeometry, side: number) => (side < 0 ? g.rotateY(Math.PI) : g);
  for (const side of sides) {
    for (const z of tyreZ(r, halfW, dual)) {
      const zc = side * z;
      P.add(
        'tire',
        new CylinderGeometry(r, r, w, 40, 1, true).rotateX(Math.PI / 2).translate(x, r, zc),
      );
      for (const face of [-1, 1])
        P.add(
          'tire',
          facing(new RingGeometry(rim, r, 40), face).translate(x, r, zc + (face * w) / 2),
        );
      // The rim, set back into the tyre: its lip, the disc, the boss.
      const outer = zc + (side * w) / 2;
      const disc = outer - side * recess;
      P.add(
        'hub',
        new CylinderGeometry(rim, rim, recess, 40, 1, true)
          .rotateX(Math.PI / 2)
          .translate(x, r, outer - (side * recess) / 2),
      );
      P.add('hub', facing(new CircleGeometry(rim, 40), side).translate(x, r, disc));
      P.add('hub', cylinder(r * 0.21, r * 0.23, 0.05, 20, 'z', x, r, disc + side * 0.024));
      P.add(
        'dark',
        facing(new CircleGeometry(r * 0.12, 16), side).translate(x, r, disc + side * 0.053),
      );
      for (let k = 0; k < studs; k++) {
        const a = (k / studs) * Math.PI * 2;
        P.add(
          'chrome',
          cylinder(
            r * 0.028,
            r * 0.028,
            0.03,
            8,
            'z',
            x + Math.cos(a) * r * 0.31,
            r + Math.sin(a) * r * 0.31,
            disc + side * 0.014,
          ),
        );
        const v = a + Math.PI / studs;
        P.add(
          'dark',
          facing(new CircleGeometry(r * 0.065, 12), side).translate(
            x + Math.cos(v) * r * 0.47,
            r + Math.sin(v) * r * 0.47,
            disc + side * 0.004,
          ),
        );
      }
    }
  }
}

/**
 * The door camera's housing (ESP32-S3-CAM in a small case) on the door
 * header, inside, and its bracket. The camera itself: doorCamera.ts.
 */
export function cameraMount(P: Parts, x: number, y: number, z: number): void {
  P.add('dark', rbox(x - 0.06, x + 0.06, y - 0.03, y + 0.06, z - 0.05, z + 0.05, 0.012));
  P.add('chrome', cylinder(0.024, 0.026, 0.02, 14, 'y', x, y - 0.04, z));
  P.add('tail', cylinder(0.014, 0.014, 0.012, 12, 'y', x, y - 0.052, z));
}
