/**
 * Draws N jeepneys with one InstancedMesh per part slot, so the draw-call
 * count does not grow with the fleet (≈14 calls for 1 or 100 jeepneys).
 *
 * Poses are pulled from `poseAt` every frame and written straight into the
 * instance matrices. No React state changes per frame, no allocations.
 *
 * The crew (driver and riders) are articulated people (personRig.ts), posed
 * with the same per-vehicle matrix, so they ride along exactly. Riders come
 * from a CrewState: they walk in, sit down, stand up and leave.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  Box3,
  Matrix4,
  Object3D,
  Ray,
  Vector3,
  type BufferGeometry,
  type InstancedMesh,
  type Intersection,
  type Raycaster,
} from 'three';
import { useApp } from '@/app/store';
import type { Livery } from '@/core/fleet/fleetSim';
import { PeopleInstances, type PeopleHandle } from '../people/PeopleInstances';
import {
  appearance,
  driverAppearance,
  holdRails,
  poseFromMotion,
  rootFor,
  STANDING,
  type PersonPose,
} from '../people/personRig';
import { crewSeed, PLACES, riderSeed, SEATS } from './crew';
import { isPregnant, type CrewState } from './crewState';
import { bakeColours, bakedColour } from './geometryKit';
import {
  BODY_LIFT,
  DRIVER_SEAT,
  jeepneyBody,
  jeepneyWheels,
  JEEPNEY_WHEELS,
  WHEEL_RADIUS,
  rimPoint,
  SEATED_ROOT_Y,
  STEERING_FRAME,
  steeringWheelGeometry,
  type PartSlot,
} from './jeepneyGeometry';
import { bakedMaterial, LIVERY_SLOTS, liveryColor, slotMaterial, wheelMaterial } from './materials';
import { useScaledPose } from '../world/viewScale';

export interface GroundPose {
  x: number;
  z: number;
  /** Three.js yaw, radians. */
  heading: number;
}

interface Props {
  count: number;
  /**
   * Slots to keep: as long as it stays the same, a new count only changes how
   * many are drawn, and nothing has to be built again (default: `count`).
   */
  capacity?: number;
  liveries: readonly Livery[];
  /** Fill `out` with vehicle i's pose. Called every frame for each vehicle. */
  poseAt: (i: number, out: GroundPose) => void;
  castShadow?: boolean;
  /** Grow with camera distance so the fleet stays visible zoomed out (map view). */
  scaleWithView?: boolean;
  /** Riders of every vehicle (index-aligned with poseAt). Omit for no riders. */
  crew?: CrewState;
  /** Draw a driver at the wheel of every jeepney. */
  drivers?: boolean;
  /** Called when the user clicks a jeepney in the 3D viewport. */
  onSelect?: (index: number, part: 'front' | 'body') => void;
  /** Vehicles not to draw (or pick) this frame: parked for the night. */
  hidden?: (i: number) => boolean;
  /** Drawn with nobody at the wheel (parked). */
  driverless?: (i: number) => boolean;
  /** The layer to draw on, when not every camera should see them. */
  layer?: number;
}

let cachedShell: BufferGeometry | null = null;
let cachedWheels: BufferGeometry | null = null;

/** Everything of the same colour on every jeepney, in one geometry. */
function jeepneyShell(): BufferGeometry {
  cachedShell ??= bakeColours(
    (Object.entries(jeepneyBody()) as [PartSlot, BufferGeometry][])
      .filter(([slot]) => !LIVERY_SLOTS.has(slot) && slot !== 'glass')
      .map(([slot, g]) => [g, bakedColour(slotMaterial(slot))] as const),
  );
  return cachedShell;
}

function bakedWheels(): BufferGeometry {
  const { tire, hub } = jeepneyWheels();
  cachedWheels ??= bakeColours([
    [tire, bakedColour(wheelMaterial('tire'))],
    [hub, bakedColour(wheelMaterial('hub'))],
  ]);
  return cachedWheels;
}

/** The parts drawn apart from the shell: their colour varies, or they are see-through. */
const OWN_MESH: readonly PartSlot[] = [...LIVERY_SLOTS, 'glass'];

/** Collapses an instance to nothing: how a hidden jeepney is "drawn". */
const NOWHERE = new Matrix4().makeScale(0, 0, 0);

/** Bounding box of a single jeepney in its local ground frame (metres), for picking. */
const HIT_BOX = new Box3(new Vector3(-3.55, 0, -1.2), new Vector3(3.35, 2.5, 1.2));

/**
 * The driver in the jeepney's ground frame: seated, facing the road, hips at
 * the seat (DRIVER_SEAT), so their back rests on the seat back.
 */
const DRIVER_MOTION = {
  x: DRIVER_SEAT.x,
  y: SEATED_ROOT_Y - 0.06,
  z: DRIVER_SEAT.z,
  yaw: 0,
  sit: 1,
  walk: 0,
  phase: 0,
  stoop: 0.96,
};

/** Steering ratio (wheel turns per road-wheel turn) and wheelbase of a jeepney. */
const STEERING_RATIO = 14;
const WHEELBASE_M = 4.3;
/** Lock to lock is about ±1.5 turns; we stop well short of full lock. */
const MAX_WHEEL_TURN = 2.4;
/** The front wheels turn at most this far either way (radians): a jeepney's full lock, about 35 degrees. */
const MAX_ROAD_WHEEL = (35 * Math.PI) / 180;
/** Turns a left-hand wheel to face out, its hub to the left. */
const LEFT_WHEEL = new Matrix4().makeRotationY(Math.PI);

/**
 * How far the front wheels turn (radians, + = right) for a vehicle turning at
 * `yawRate` (rad/s) at `speed` (m/s): the bicycle model, atan(L·ω / v),
 * no further than full lock.
 */
function roadWheelFor(yawRate: number, speed: number): number {
  const angle = Math.atan((WHEELBASE_M * yawRate) / Math.max(speed, 1.5));
  return Math.max(-MAX_ROAD_WHEEL, Math.min(MAX_ROAD_WHEEL, angle));
}
/** Hands at "ten to two"; they ride round with the wheel up to this far. */
const GRIP_ANGLE = (62 * Math.PI) / 180;
const HANDS_FOLLOW = 1.0;

/**
 * Steering wheel angle for a vehicle turning at `yawRate` (rad/s, + = right)
 * at `speed` (m/s): the bicycle model, road-wheel angle = atan(L·ω / v),
 * times the steering ratio.
 */
function wheelTurnFor(yawRate: number, speed: number): number {
  const roadWheel = Math.atan((WHEELBASE_M * yawRate) / Math.max(speed, 1.5));
  return Math.max(-MAX_WHEEL_TURN, Math.min(MAX_WHEEL_TURN, STEERING_RATIO * roadWheel));
}

/**
 * Hands on the wheel at ten-to-two, turning with it; eyes on the road,
 * glancing into the turn.
 */
export function drivingPose(
  t: number,
  idle: number,
  wheelTurn: number,
  grip: readonly [Vector3, Vector3],
  out: PersonPose,
): PersonPose {
  Object.assign(out, STANDING);
  out.sit = 1;
  out.steer = wheelTurn;
  out.grip = grip;
  out.pedal = t * 2.8 + idle * 2.3;
  out.headYaw = 0.12 * Math.sin(t * 0.5 + idle) - 0.25 * Math.max(-1, Math.min(1, wheelTurn / 2));
  return out;
}

export function JeepneyInstances({
  count,
  capacity = count,
  liveries,
  poseAt,
  castShadow = true,
  scaleWithView = false,
  crew,
  drivers = true,
  onSelect,
  hidden,
  driverless,
  layer,
}: Props) {
  const viewer = useThree((s) => s.camera);
  const body = jeepneyBody();
  const slots = useMemo(() => OWN_MESH.filter((slot) => body[slot]), [body]);

  const bodyMeshes = useRef<Array<InstancedMesh | null>>([]);
  const wheelMeshes = useRef<Array<InstancedMesh | null>>([]);
  const steeringWheels = useRef<InstancedMesh>(null);
  const pickerRef = useRef<Object3D>(null);
  /** Each vehicle's matrix for picking; null while it is hidden. */
  const vehicleMatrices = useRef<Array<Matrix4 | null>>([]);
  const people = useRef<PeopleHandle>(null);
  const crewCapacity = capacity * (PLACES.length + 1);
  const local = useMemo(() => new Matrix4(), []);

  useEffect(
    () => () => {
      document.body.style.cursor = '';
    },
    [],
  );

  const raycast = useMemo(() => {
    const inv = new Matrix4();
    const localRay = new Ray();
    const hitPoint = new Vector3();
    const worldPoint = new Vector3();
    return (raycaster: Raycaster, intersects: Intersection[]) => {
      if (!onSelect || !pickerRef.current || useApp.getState().follow?.view === 'inside') return;
      const mats = vehicleMatrices.current;
      for (let i = 0; i < count; i++) {
        const m = mats[i];
        if (!m) continue;
        inv.copy(m).invert();
        localRay.copy(raycaster.ray).applyMatrix4(inv);
        if (localRay.intersectBox(HIT_BOX, hitPoint)) {
          worldPoint.copy(hitPoint).applyMatrix4(m);
          intersects.push({
            distance: raycaster.ray.origin.distanceTo(worldPoint),
            point: worldPoint.clone(),
            object: pickerRef.current,
            instanceId: i,
          });
        }
      }
    };
  }, [count, onSelect]);

  const scratch = useMemo(
    () => ({
      pose: { x: 0, z: 0, heading: 0 },
      obj: new Object3D(),
      lift: new Matrix4().makeTranslation(0, BODY_LIFT, 0),
      bodyM: new Matrix4(),
      root: new Matrix4(),
      person: { ...STANDING } as PersonPose,
      prevHeading: new Float32Array(count),
      prevX: new Float32Array(count),
      prevZ: new Float32Array(count),
      turnRates: new Float32Array(count),
      speeds: new Float32Array(count),
      wheelTurns: new Float32Array(count),
      /** How far each one's front wheels are steered (radians, + = right). */
      steers: new Float32Array(count),
      steerM: new Matrix4(),
      /** How far each one's wheels have turned (radians). */
      spins: new Float32Array(count),
      wheelM: new Matrix4(),
      roll: new Matrix4(),
      hasPrev: new Uint8Array(count),
      // This frame's ground pose of each vehicle (from poseAt), and the clock.
      poseX: new Float32Array(count),
      poseZ: new Float32Array(count),
      poseHeading: new Float32Array(count),
      t: 0,
      spin: new Matrix4(),
      steeringM: new Matrix4(),
      grip: [new Vector3(), new Vector3()] as [Vector3, Vector3],
    }),
    [count],
  );

  // Livery colours only change when the fleet changes, not per frame.
  useLayoutEffect(() => {
    slots.forEach((slot, si) => {
      const mesh = bodyMeshes.current[si];
      if (!mesh || !LIVERY_SLOTS.has(slot)) return;
      for (let i = 0; i < count; i++) mesh.setColorAt(i, liveryColor(liveries[i] ?? 'red', slot));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }, [slots, count, liveries]);

  // Once per frame: where each jeepney is, and how fast it turns and moves
  // (smoothed over a few frames), which drives its steering wheel.
  useLayoutEffect(() => {
    for (const m of bodyMeshes.current) if (m) m.count = count;
    for (const m of wheelMeshes.current) if (m) m.count = count * JEEPNEY_WHEELS.length;
    if (steeringWheels.current) steeringWheels.current.count = count;
  }, [count, capacity]);

  useFrame((state, dt) => {
    const { pose, prevHeading, prevX, prevZ, turnRates, speeds, wheelTurns, hasPrev, spins } =
      scratch;
    const { poseX, poseZ, poseHeading } = scratch;
    const ease = Math.min(1, dt * 6);
    scratch.t = state.clock.elapsedTime;
    for (let i = 0; i < count; i++) {
      poseAt(i, pose);
      poseX[i] = pose.x;
      poseZ[i] = pose.z;
      poseHeading[i] = pose.heading;
      if (hasPrev[i] && dt > 0.001) {
        const dh = Math.atan2(
          Math.sin(pose.heading - prevHeading[i]!),
          Math.cos(pose.heading - prevHeading[i]!),
        );
        // Headings turn the wrong way for steering: + heading = turning left.
        const yawRate = Math.abs(dh) < 0.5 ? -dh / dt : 0;
        const speed = Math.hypot(pose.x - prevX[i]!, pose.z - prevZ[i]!) / dt;
        turnRates[i]! += (yawRate - turnRates[i]!) * ease;
        speeds[i]! += (Math.min(speed, 30) - speeds[i]!) * ease;
        // The wheels roll as far as it moved (a jump, a new place: not rolled).
        const moved = speed * dt;
        if (moved < 15) spins[i]! += moved / WHEEL_RADIUS;
        wheelTurns[i]! += (wheelTurnFor(turnRates[i]!, speeds[i]!) - wheelTurns[i]!) * ease;
        scratch.steers[i]! += (roadWheelFor(turnRates[i]!, speeds[i]!) - scratch.steers[i]!) * ease;
      }
      hasPrev[i] = 1;
      prevHeading[i] = pose.heading;
      prevX[i] = pose.x;
      prevZ[i] = pose.z;
    }
  });

  // Place bodies, wheels, steering wheels and crew at symbol scale k. Runs at
  // the main view's scale every frame, and at true size for the cabin camera.
  useScaledPose((viewK) => {
    const { obj, lift, bodyM, root, person, wheelTurns, spin, steeringM, grip } = scratch;
    const { poseX, poseZ, poseHeading, t } = scratch;
    const crowd = people.current;
    const steering = steeringWheels.current;
    const selected = useApp.getState();
    const followedVehicle = selected.follow?.kind === 'sim' ? selected.follow.index : null;
    const trackedVehicle =
      selected.trackedRiderId === null
        ? null
        : crew?.passengers.get(selected.trackedRiderId)?.vehicleId;
    obj.scale.setScalar(scaleWithView ? viewK : 1);
    let anyShown = false;
    crowd?.begin();
    for (let i = 0; i < count; i++) {
      if (hidden?.(i)) {
        for (const m of bodyMeshes.current) m?.setMatrixAt(i, NOWHERE);
        for (const m of wheelMeshes.current)
          for (let w = 0; w < JEEPNEY_WHEELS.length; w++)
            m?.setMatrixAt(i * JEEPNEY_WHEELS.length + w, NOWHERE);
        steering?.setMatrixAt(i, NOWHERE);
        vehicleMatrices.current[i] = null;
        continue;
      }
      anyShown = true;
      const wheelTurn = wheelTurns[i]!;
      obj.position.set(poseX[i]!, 0, poseZ[i]!);
      obj.rotation.set(0, poseHeading[i]!, 0);
      obj.updateMatrix();
      if (onSelect) {
        vehicleMatrices.current[i] ??= new Matrix4();
        vehicleMatrices.current[i]!.copy(obj.matrix);
      }
      bodyM.multiplyMatrices(obj.matrix, lift);
      for (const m of bodyMeshes.current) m?.setMatrixAt(i, bodyM);
      // Each wheel at its place, the front two steered into the turn (about
      // their own upright: right is a negative angle), all rolled forward
      // (about the axle, nose-down: a negative angle), the left ones turned to face out.
      scratch.roll.makeRotationZ(-scratch.spins[i]!);
      scratch.steerM.makeRotationY(-scratch.steers[i]!);
      JEEPNEY_WHEELS.forEach((w, n) => {
        scratch.wheelM.makeTranslation(w.x, WHEEL_RADIUS, w.z);
        if (w.steers) scratch.wheelM.multiply(scratch.steerM);
        scratch.wheelM.multiply(scratch.roll);
        if (w.side < 0) scratch.wheelM.multiply(LEFT_WHEEL);
        scratch.wheelM.premultiply(obj.matrix);
        for (const m of wheelMeshes.current)
          m?.setMatrixAt(i * JEEPNEY_WHEELS.length + n, scratch.wheelM);
      });
      // The steering wheel turns about its own axis (the wheel frame's z);
      // steering right is clockwise as the driver sees it: a negative angle.
      if (steering) {
        spin.makeRotationZ(-wheelTurn);
        steeringM.multiplyMatrices(bodyM, STEERING_FRAME).multiply(spin);
        steering.setMatrixAt(i, steeringM);
      }
      if (!crowd) continue;
      if (
        scaleWithView &&
        followedVehicle !== i &&
        trackedVehicle !== i &&
        Math.hypot(obj.position.x - viewer.position.x, obj.position.z - viewer.position.z) > 250
      )
        continue;
      if (drivers && !driverless?.(i)) {
        const seed = crewSeed(i, SEATS);
        const look = driverAppearance(seed);
        root.multiplyMatrices(obj.matrix, rootFor(DRIVER_MOTION, look.size, local));
        // Hands ride round with the wheel; past HANDS_FOLLOW they would
        // shuffle along the rim, so they stay at the limit.
        const handTurn = Math.max(-HANDS_FOLLOW, Math.min(HANDS_FOLLOW, wheelTurn));
        // grip[0] is the rig's +Z-side hand (the driver's right), grip[1] the left.
        rimPoint(GRIP_ANGLE, handTurn, grip[0]).applyMatrix4(obj.matrix);
        rimPoint(-GRIP_ANGLE, handTurn, grip[1]).applyMatrix4(obj.matrix);
        crowd.emit(root, drivingPose(t, look.idle, wheelTurn, grip, person), seed, look);
      }
      crew?.forEachRider(i, (riderId, motion, place) => {
        const seed = riderSeed(riderId);
        const look = appearance(seed);
        root.multiplyMatrices(obj.matrix, rootFor(motion, look.size, local));
        poseFromMotion(motion, look, t, person);
        holdRails(person, motion.hold, place?.holds, obj.matrix);
        crowd.emit(root, person, seed, undefined, 1, isPregnant(crew, riderId));
      });
    }
    crowd?.end();
    for (const m of [...bodyMeshes.current, ...wheelMeshes.current, steering]) {
      if (!m) continue;
      // None to draw (a route of other kinds): not a draw call in every pass.
      m.visible = anyShown;
      // Only those drawn, not every slot kept.
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, m.count * 16);
      m.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      {onSelect && (
        <object3D
          ref={pickerRef}
          raycast={raycast}
          onClick={(e) => {
            if (e.delta <= 6 && e.instanceId !== undefined) {
              e.stopPropagation();
              const m = vehicleMatrices.current[e.instanceId];
              let part: 'front' | 'body' = 'body';
              if (m) {
                const localPt = e.point.clone().applyMatrix4(m.clone().invert());
                if (localPt.x > 0.65) part = 'front';
              }
              onSelect(e.instanceId, part);
            }
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            document.body.style.cursor = 'pointer';
          }}
          onPointerOut={() => {
            document.body.style.cursor = '';
          }}
        />
      )}
      {slots.map((slot, si) => (
        <instancedMesh
          key={`${slot}-${capacity}`}
          ref={(m) => {
            bodyMeshes.current[si] = m;
            if (m && layer !== undefined) m.layers.set(layer);
          }}
          args={[body[slot], slotMaterial(slot), capacity]}
          castShadow={castShadow && slot !== 'glass'}
          receiveShadow
          frustumCulled={false}
        />
      ))}
      <instancedMesh
        key={`shell-${capacity}`}
        ref={(m) => {
          bodyMeshes.current[slots.length] = m;
          if (m && layer !== undefined) m.layers.set(layer);
        }}
        args={[jeepneyShell(), bakedMaterial(), capacity]}
        castShadow={castShadow}
        receiveShadow
        frustumCulled={false}
      />
      <instancedMesh
        key={`wheels-${capacity}`}
        ref={(m) => {
          wheelMeshes.current[0] = m;
          if (m && layer !== undefined) m.layers.set(layer);
        }}
        args={[bakedWheels(), bakedMaterial(), capacity * JEEPNEY_WHEELS.length]}
        castShadow={castShadow}
        frustumCulled={false}
      />
      <instancedMesh
        key={`steering-${capacity}`}
        ref={(m) => {
          steeringWheels.current = m;
          if (m && layer !== undefined) m.layers.set(layer);
        }}
        args={[steeringWheelGeometry(), slotMaterial('dark'), capacity]}
        castShadow={castShadow}
        frustumCulled={false}
      />
      {(drivers || crew) && (
        <PeopleInstances
          ref={people}
          capacity={crewCapacity}
          castShadow={castShadow}
          layer={layer}
        />
      )}
    </group>
  );
}
