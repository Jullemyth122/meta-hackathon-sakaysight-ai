/**
 * An articulated person for crowds, ported from the original prototype
 * bundle (g3man / m3emit in index.html) and extended with an elbow and a
 * turning head.
 *
 * Each body part is its own geometry, drawn by one InstancedMesh shared by
 * every person in the scene. Posing a person = writing one matrix per part,
 * composed down the joint chain:
 *
 *   root ─┬─ torso, pelvis
 *         ├─ neck ── head, hair                 (yaw: looking around)
 *         ├─ hip L/R ── thigh ── knee ── shin, foot
 *         └─ shoulder L/R ── sleeve ── elbow ── forearm + hand
 *
 * Local frame: metres, feet at y = 0, facing +X, +Y up, so the person's
 * right side is +Z and their left is -Z.
 * Standing height ≈ 1.6 m.
 */

import {
  CapsuleGeometry,
  Color,
  Euler,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import { mergeParts } from '../jeepney/geometryKit';

/** Parts drawn once per person. */
export const SINGLE_PARTS = ['torso', 'pelvis', 'head', 'hair', 'belly'] as const;
/** Parts drawn twice per person (instance 2n = right / +Z side, 2n + 1 = left). */
export const PAIRED_PARTS = ['thigh', 'shin', 'foot', 'sleeve', 'forearm'] as const;
export type BodyPart = (typeof SINGLE_PARTS)[number] | (typeof PAIRED_PARTS)[number];

/** Which colour of the person's outfit each part takes. */
export const PART_COLOR: Record<BodyPart, keyof Outfit> = {
  torso: 'shirt',
  sleeve: 'shirt',
  pelvis: 'pants',
  thigh: 'pants',
  shin: 'pants',
  foot: 'shoes',
  head: 'skin',
  forearm: 'skin',
  hair: 'hair',
  belly: 'shirt',
};

// Joint positions in the root frame (from the prototype's rig).
const HIP_Y = 0.74;
const HIP_Z = 0.085;
const KNEE_DROP = 0.34;
const SHOULDER_Y = 1.2;
const SHOULDER_Z = 0.205;
const ELBOW_DROP = 0.25;
const NECK_Y = 1.27;
/** Head centre above the neck joint. */
const HEAD_Y = 0.13;
/** A pregnant rider's belly: its size, and how far forward of the spine and how high. */
const BELLY_R = 0.13;
const BELLY_X = 0.09;
const BELLY_Y = 0.93;
/**
 * Head centre above the root at size 1. Legs do not move the torso, so it is
 * the same standing or seated: multiply by the root's vertical scale.
 */
export const HEAD_CENTRE_Y = NECK_Y + HEAD_Y;

function capsule(r: number, len: number, sx: number, sz: number, y: number): BufferGeometry {
  const g = new CapsuleGeometry(r, len, 3, 10);
  g.scale(sx, 1, sz);
  g.translate(0, y, 0);
  return g;
}

function ellipsoid(r: number, sx: number, sy: number, sz: number, x: number, y: number) {
  const g = new SphereGeometry(r, 14, 10);
  g.scale(sx, sy, sz);
  g.translate(x, y, 0);
  return g;
}

/** A fitted crown with a continuous hairline, closed underneath inside the skull. */
function hairCap(r: number): BufferGeometry {
  const g = new SphereGeometry(1, 40, 24);
  const positions = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < positions.count; i++) {
    const phi = uv.getX(i) * Math.PI * 2;
    const t = 1 - uv.getY(i);
    // People face +X: keep the forehead open, taper past the temples,
    // and carry the hair farther down the back of the head.
    const hairline = 1.48 + 0.5 * Math.cos(phi);
    const theta = Math.min(t * 2, 1) * hairline;
    // The lower half closes inward from the rim, hidden within the head.
    // Unlike overlapping ellipsoids, the visible edge is an explicit curve.
    const radius = r * 1.06 * (t <= 0.5 ? 1 : 2 * (1 - t));
    positions.setXYZ(
      i,
      0.01 - radius * Math.sin(theta) * Math.cos(phi),
      HEAD_Y + radius * 1.17 * Math.cos(theta),
      radius * 0.9 * Math.sin(theta) * Math.sin(phi),
    );
  }
  g.computeVertexNormals();
  return g;
}

let geometries: Record<BodyPart, BufferGeometry> | null = null;

/** Part geometries, each relative to its own joint. Built once. */
export function rigGeometries(): Record<BodyPart, BufferGeometry> {
  if (geometries) return geometries;
  // Head: ~1/7 of standing height. The prototype's head was larger (more
  // toy-like); this keeps its style with adult proportions.
  const HEAD_R = 0.118;
  const HEAD_SCALE = [1, 1.17, 0.9] as const;
  geometries = {
    torso: capsule(0.155, 0.24, 0.85, 1.12, 1.0),
    pelvis: ellipsoid(0.15, 0.85, 0.72, 1.05, 0, 0.77),
    head: mergeParts([
      ellipsoid(0.048, 1, 1.5, 1, 0, 0.02), // neck
      ellipsoid(HEAD_R, ...HEAD_SCALE, 0.01, HEAD_Y),
    ])!,
    hair: hairCap(HEAD_R),
    // A pregnant rider's: rounded out in front of the waist, under the shirt.
    belly: ellipsoid(BELLY_R, 0.95, 1, 1.15, BELLY_X, BELLY_Y),
    thigh: capsule(0.08, 0.2, 1, 1, -0.17),
    shin: capsule(0.07, 0.18, 1, 1, -0.16),
    foot: ellipsoid(0.13, 1, 0.42, 0.62, 0.05, -0.34),
    sleeve: capsule(0.066, 0.12, 1, 1, -0.11),
    forearm: mergeParts([
      capsule(0.056, 0.13, 1, 1, -0.09),
      ellipsoid(0.055, 0.85, 1.15, 0.7, 0, -0.235), // hand
    ])!,
  };
  return geometries;
}

export interface PersonPose {
  /** 0 = standing still, 1 = full walking stride. */
  walk: number;
  /** Stride phase, radians (advance ~5.7 rad per metre walked). */
  phase: number;
  /** 0 = standing, 1 = seated (thighs forward, shins down). */
  sit: number;
  /** Head turn, radians (+ = towards the person's left). */
  headYaw: number;
  /** Shoulder swing forward, radians, while not walking. */
  shoulder: number;
  /** Elbow bend, radians (0 = straight arm). */
  elbow: number;
  /** Arms brought towards the body's midline, radians (hands together). */
  inward: number;
  /** Steering wheel turn, radians (+ = steering right); turns the torso a little into it. */
  steer?: number;
  /** Pedal footwork phase, radians (for the seated driver). */
  pedal?: number;
  /** Upper body leaning forward from the hips, radians. */
  lean?: number;
  /** 0..1: the climbing leg's knee raised onto a step. */
  lift?: number;
  /** Which leg climbs: 0 = the +Z-side leg (the right), 1 = the left. */
  liftLeg?: 0 | 1;
  /** 0..1: both hands reaching forward to grab poles. */
  reach?: number;
  /**
   * World-space points the [right (+Z side), left] hands must hold (e.g. the
   * steering wheel rim). When set, the arms are solved to reach them exactly;
   * a null hand goes on with the rest of the pose.
   */
  grip?: readonly [Vector3 | null, Vector3 | null] | null;
  /** 0..1: how far the hands have got to `grip` (1 when absent). */
  gripShare?: number;
}

export const STANDING: PersonPose = {
  walk: 0,
  phase: 0,
  sit: 0,
  headYaw: 0,
  shoulder: 0.05,
  elbow: 0.15,
  inward: 0,
  steer: 0,
  pedal: 0,
  lean: 0,
  lift: 0,
  liftLeg: 0,
  reach: 0,
  grip: null,
  gripShare: 1,
};

/** Shoulder to elbow, and elbow to the centre of the hand (forearm geometry). */
const UPPER_ARM = ELBOW_DROP;
const FOREARM = 0.235;

export interface Outfit {
  shirt: Color;
  pants: Color;
  skin: Color;
  hair: Color;
  shoes: Color;
}

export interface Appearance extends Outfit {
  /** Overall size, ~0.93–1.04 (children are not modelled). */
  size: number;
  /** What this person does with their hands while seated. */
  habit: 'lap' | 'phone' | 'bag';
  /** Phase offset for idle motion, so a crowd does not move in sync. */
  idle: number;
}

const palette = (hexes: string[]) => hexes.map((h) => new Color(h));

/**
 * Passengers are drawn in a grey–white range, like the prototype's figures:
 * a clean, readable crowd where the jeepney, the route and the counter's
 * boxes stay the focus. Each person still differs a little in every part, so
 * a full bench reads as separate people.
 */
const SHIRTS = palette(['#f4f5f6', '#e9ebed', '#dfe2e5', '#d4d7db', '#c9cdd1', '#eef0f1']);
const PANTS = palette(['#a9aeb3', '#9da2a8', '#b4b8bd', '#8f949a', '#c0c4c8']);
const SKIN = palette(['#e6e8ea', '#dcdfe2', '#eceef0']);
const HAIR = palette(['#8b9096', '#7e838a', '#979ca2']);
const SHOES = palette(['#7a7f86', '#868b92', '#6f747a']);

/**
 * The driver is the one person in colour, so they are easy to tell apart
 * from the passengers the camera counts.
 */
const DRIVER: Outfit = {
  shirt: new Color('#2f6fb3'),
  pants: new Color('#2b2f36'),
  skin: new Color('#c68a63'),
  hair: new Color('#15110e'),
  shoes: new Color('#2a2d33'),
};

/** Small integer hash (xorshift-multiply), stable across sessions. */
function hash(n: number, salt: number): number {
  let h = Math.imul(n ^ salt, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca77);
  return (h ^ (h >>> 13)) >>> 0;
}

const pick = <T>(list: readonly T[], seed: number, salt: number) =>
  list[hash(seed, salt) % list.length]!;

const appearances = new Map<number, Appearance>();

/** The look of person `seed`: same seed, same person, every frame and reload. */
export function appearance(seed: number): Appearance {
  let a = appearances.get(seed);
  if (!a) {
    const h = hash(seed, 0x51) % 100;
    a = {
      shirt: pick(SHIRTS, seed, 1),
      pants: pick(PANTS, seed, 2),
      skin: pick(SKIN, seed, 3),
      hair: pick(HAIR, seed, 4),
      shoes: pick(SHOES, seed, 5),
      size: 0.93 + (hash(seed, 6) % 1000) / 9000,
      habit: h < 55 ? 'lap' : h < 88 ? 'phone' : 'bag',
      idle: (hash(seed, 7) % 6283) / 1000,
    };
    appearances.set(seed, a);
  }
  return a;
}

/** The driver's look: the passenger build and habits for `seed`, in colour. */
export function driverAppearance(seed: number): Appearance {
  return { ...appearance(seed), ...DRIVER, size: 1, habit: 'lap' };
}

/** A seated pose for this person at time t (seconds): hands, head, breathing room. */
export function seatedPose(look: Appearance, t: number, out: PersonPose): PersonPose {
  out.walk = 0;
  out.phase = 0;
  out.sit = 1;
  out.steer = 0;
  out.pedal = 0;
  out.headYaw = look.habit === 'phone' ? -0.15 : 0.35 * Math.sin(t * 0.21 + look.idle);
  switch (look.habit) {
    case 'phone': // hands up in front of the chest
      out.shoulder = 0.3;
      out.elbow = 1.85;
      out.inward = 0.32;
      break;
    case 'bag': // arms around a bag on the lap
      out.shoulder = 0.55;
      out.elbow = 1.25;
      out.inward = 0.42;
      break;
    default: // forearms resting on the thighs
      out.shoulder = 0.28;
      out.elbow = 1.2;
      out.inward = 0.1;
  }
  return out;
}

/** Where a rider is and how far through sitting down (riderMotion.ts output). */
export interface BodyMotion {
  x: number;
  y: number;
  z: number;
  yaw: number;
  sit: number;
  walk: number;
  phase: number;
  stoop: number;
  lean?: number;
  lift?: number;
  liftLeg?: 0 | 1;
  reach?: number;
  hold?: number;
}

/**
 * Joint pose for a rider in motion: legs from the walk/sit/climb state, arms
 * blending from standing to this person's seated habit (lap, phone, bag) as
 * they sit down, so hands settle naturally instead of snapping.
 */
export function poseFromMotion(
  m: BodyMotion,
  look: Appearance,
  t: number,
  out: PersonPose,
): PersonPose {
  seatedPose(look, t, out);
  const k = m.sit;
  out.shoulder = STANDING.shoulder + (out.shoulder - STANDING.shoulder) * k;
  out.elbow = STANDING.elbow + (out.elbow - STANDING.elbow) * k;
  out.inward = STANDING.inward + (out.inward - STANDING.inward) * k;
  out.headYaw *= k;
  out.walk = m.walk;
  out.phase = m.phase;
  out.sit = k;
  out.lean = m.lean ?? 0;
  out.lift = m.lift ?? 0;
  out.liftLeg = m.liftLeg ?? 0;
  out.reach = m.reach ?? 0;
  out.grip = null;
  out.gripShare = 1;
  return out;
}

const heldAt: [Vector3, Vector3] = [new Vector3(), new Vector3()];
const held: [Vector3 | null, Vector3 | null] = [null, null];

/**
 * Hands on the rails (`holds`, vehicle frame, one or both) for someone
 * standing, `share` of the way there. `vehicle` is the frame they ride in.
 * Good until the next call: emit the person straight after.
 */
export function holdRails(
  out: PersonPose,
  share: number,
  holds: readonly [readonly number[] | null, readonly number[] | null] | undefined,
  vehicle: Matrix4,
): void {
  if (!holds || share <= 0) return;
  for (const j of [0, 1] as const) {
    const at = holds[j];
    held[j] = at ? heldAt[j].set(at[0]!, at[1]!, at[2]!).applyMatrix4(vehicle) : null;
  }
  out.grip = held;
  out.gripShare = share;
}

const up = new Vector3(0, 1, 0);
const q = new Quaternion();
const pos = new Vector3();
const scl = new Vector3();

/**
 * Root transform of a rider: position, facing, size, stoop under the roof,
 * and packed 20% narrower once seated shoulder to shoulder.
 */
export function rootFor(m: BodyMotion, size: number, out: Matrix4): Matrix4 {
  const width = 1 - 0.2 * m.sit;
  return out.compose(
    pos.set(m.x, m.y, m.z),
    q.setFromAxisAngle(up, m.yaw),
    scl.set(size, size * m.stoop, size * width),
  );
}

/** Writes the matrices of one person's parts. Reuses scratch objects only. */
export class RigWriter {
  private readonly m = new Matrix4();
  private readonly joint = new Matrix4();
  private readonly limb = new Matrix4();
  private readonly euler = new Euler();
  private readonly inverse = new Matrix4();
  private readonly target = new Vector3();

  /**
   * Two-bone IK for one arm: shoulder and elbow angles that put the hand on
   * `d`, a point relative to the shoulder in the torso's (unscaled) frame.
   *
   * The arm hangs along -Y; the elbow bends about the upper arm's local Z, so
   * the hand lies at (a, b, 0) in the shoulder frame with a = L2·sin(elbow),
   * b = -(L1 + L2·cos(elbow)). The shoulder applies Rz(swing)·Rx(splay) (Euler
   * 'ZYX'), so: d.z = b·sin(splay), and in X–Y the swing rotates (a, b·cos
   * splay) onto (d.x, d.y).
   */
  private solveArm(d: Vector3): { swing: number; splay: number; elbow: number } {
    const reach = Math.min(d.length(), UPPER_ARM + FOREARM - 1e-4);
    const cosInner =
      (UPPER_ARM * UPPER_ARM + FOREARM * FOREARM - reach * reach) / (2 * UPPER_ARM * FOREARM);
    const elbow = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosInner)));
    const a = FOREARM * Math.sin(elbow);
    const b = -(UPPER_ARM + FOREARM * Math.cos(elbow));
    const splay = Math.asin(Math.max(-1, Math.min(1, d.z / b)));
    const swing = Math.atan2(d.y, d.x) - Math.atan2(b * Math.cos(splay), a);
    return { swing, splay, elbow };
  }

  /**
   * Fill `out` (one Matrix4 per part; paired parts get [left, right]) for a
   * person whose root transform is `root`.
   */
  write(
    root: Matrix4,
    pose: PersonPose,
    out: Record<(typeof SINGLE_PARTS)[number], Matrix4> &
      Record<(typeof PAIRED_PARTS)[number], [Matrix4, Matrix4]>,
    /** Draw them pregnant; everyone else's belly part is folded away to nothing. */
    pregnant = false,
  ): void {
    const { m, joint, limb, euler } = this;
    const { walk: w, sit: k } = pose;
    const swing = Math.sin(pose.phase);
    const st = Math.max(-1, Math.min(1, pose.steer ?? 0));
    const pd = pose.pedal ?? 0;
    const lean = pose.lean ?? 0;
    const lift = pose.lift ?? 0;
    const reach = pose.reach ?? 0;

    // Upper body: leans forward from the hips (climbing, ducking under the
    // roof) and turns a touch into a steering movement. Pivot at hip height.
    out.torso.copy(root);
    if (lean !== 0 || st !== 0) {
      m.makeTranslation(0, HIP_Y, 0);
      out.torso.multiply(m);
      euler.set(-st * 0.04, -st * 0.05, -lean, 'ZYX');
      m.makeRotationFromEuler(euler);
      out.torso.multiply(m);
      m.makeTranslation(0, -HIP_Y, 0);
      out.torso.multiply(m);
    }
    out.pelvis.copy(root);
    m.makeRotationY(pose.headYaw).setPosition(0, NECK_Y, 0);
    out.head.multiplyMatrices(out.torso, m);
    out.hair.copy(out.head);
    if (pregnant) out.belly.copy(out.torso);
    else out.belly.makeScale(0, 0, 0);

    for (const j of [0, 1] as const) {
      const sd = j === 0 ? 1 : -1;
      // Legs: walking swing, eased toward the seated angles by `sit`.
      let thigh = 0.5 * swing * sd * w;
      let shin = -0.75 * Math.max(0, -swing * sd) * w - 0.05 * w;
      thigh += (Math.PI / 2 - thigh) * k;
      shin += (-Math.PI / 2 - shin) * k;
      if (pd !== 0) {
        const pedalRock = Math.sin(pd + (j === 0 ? Math.PI : 0));
        thigh -= (0.06 + 0.04 * pedalRock) * k;
        shin += (0.2 + 0.14 * pedalRock) * k;
      }
      if (j === (pose.liftLeg ?? 0) && lift > 0) {
        // Climbing a step: knee up, foot tucked under it.
        thigh += 1.2 * lift;
        shin -= 1.6 * lift;
      }
      m.makeRotationZ(thigh).setPosition(0, HIP_Y, sd * HIP_Z);
      joint.multiplyMatrices(root, m);
      out.thigh[j].copy(joint);
      m.makeRotationZ(shin).setPosition(0, -KNEE_DROP, 0);
      limb.multiplyMatrices(joint, m);
      out.shin[j].copy(limb);
      out.foot[j].copy(limb);

      // Counter-swing when walking, otherwise the pose's arm angles…
      let shoulder = -0.45 * swing * sd * w + pose.shoulder * (1 - w);
      let elbow = pose.elbow;
      // Rotation about X by -sd·θ swings an arm outward; +sd·θ brings it in.
      let splay = sd * (pose.inward - 0.1 * (1 - k * 0.6));
      // …blended toward reaching forward and out for the grab poles.
      shoulder += (1.2 - shoulder) * reach;
      elbow += (0.3 - elbow) * reach;
      splay += (-sd * 0.2 - splay) * reach;
      const grip = pose.grip?.[j];
      if (grip) {
        // Hold a point exactly (the steering wheel rim, a rail): solve the arm
        // in the torso's own frame, which also undoes the body's scale.
        this.inverse.copy(out.torso).invert();
        this.target.copy(grip).applyMatrix4(this.inverse);
        this.target.y -= SHOULDER_Y;
        this.target.z -= sd * SHOULDER_Z;
        const ik = this.solveArm(this.target);
        const share = pose.gripShare ?? 1;
        shoulder += (ik.swing - shoulder) * share;
        splay += (ik.splay - splay) * share;
        elbow += (ik.elbow - elbow) * share;
      }
      euler.set(splay, 0, shoulder, 'ZYX');
      m.makeRotationFromEuler(euler).setPosition(0, SHOULDER_Y, sd * SHOULDER_Z);
      joint.multiplyMatrices(out.torso, m);
      out.sleeve[j].copy(joint);
      m.makeRotationZ(elbow).setPosition(0, -ELBOW_DROP, 0);
      out.forearm[j].multiplyMatrices(joint, m);
    }
  }
}
