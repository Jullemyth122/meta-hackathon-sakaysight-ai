/**
 * Camera moves for the twin, layered on top of MapControls:
 *
 *   overview   frame the whole route (also the opening shot of a new route)
 *   street     a close 3/4 view of the route near the start
 *   stop       a closer view of one stop (the commuter app's stop)
 *   area       frame some points the same way (a planned trip, end to end)
 *   chase      ride behind one jeepney, turning with it; dragging the view
 *              switches to a free orbit that still travels with the jeepney
 *   inside     standing in the aisle behind the driver, looking down the cabin
 *   pov        the front seat beside the driver, with mouse look-around and a
 *              rear-view mirror (doorway/PipRenderer.tsx)
 *
 * Shots are GSAP tweens of the orbit target and camera position. Grabbing the
 * controls cancels a running tween, so the user never fights an animation.
 */

import { useFrame, useThree } from '@react-three/fiber';
import gsap from 'gsap';
import { useEffect, useMemo, useRef } from 'react';
import { MathUtils, type PerspectiveCamera, Vector3 } from 'three';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp, type FollowTarget } from '@/app/store';
import type { LocalPoint } from '@/core/geo/projection';
import type { Route } from '@/core/geo/routes';
import type { TwinRuntime } from '@/app/twinRuntime';
import type { GroundPose } from './jeepney/JeepneyInstances';
import { fleetPose } from './world/lanes';
import { FOLLOW_VIEWS, INSIDE_VFOV, type FollowViews } from './cabinViews';
import { FRAME_ORDER } from './frameOrder';
import { newRiderPose } from '@/core/people/riderMotion';

interface Controls {
  target: Vector3;
  update(): void;
  addEventListener(type: 'start', fn: () => void): void;
  removeEventListener(type: 'start', fn: () => void): void;
}

interface Shot {
  target: Vector3;
  position: Vector3;
}

/** Where the street shot looks: this far along the route from the start. */
const STREET_AT_M = 450;
const STREET_DISTANCE_M = 340;
const OPENING_BACK = 1.6;
const OPENING_PITCH = MathUtils.degToRad(44);
const OPENING_YAW = 0.25;
const OPENING_S = 2.4;
/**
 * Chase camera: 3/4 view behind and slightly above the cabin so both the
 * street outside and the passengers inside (through the rear doorway and side
 * windows) are clearly visible, and orbiting/zooming pivots around the cabin.
 */
/** Maximum distance (m) the user may pan the orbit pivot away from the followed jeepney. */
const MAX_TARGET_OFFSET_M = 8;
/**
 * Front cab / Driver POV: seated in the front cab beside the driver, looking
 * across the steering wheel, dashboard, gauge cluster and out the windshield.
 */
const POV_VFOV = 62;
/** Near plane as a fraction of the orbit distance (keeps depth precision). */
const NEAR_FRACTION = 0.01;

/** Camera at `distance` from `target`, `pitch` above the ground, looking along `yaw`. */
function orbit(target: Vector3, distance: number, pitch: number, yaw: number): Shot {
  const flat = Math.cos(pitch) * distance;
  return {
    target: target.clone(),
    position: new Vector3(
      target.x - Math.cos(yaw) * flat,
      Math.sin(pitch) * distance,
      target.z + Math.sin(yaw) * flat,
    ),
  };
}

/** Fraction of the screen the route may fill (NDC units); the rest is margin. */
const OVERVIEW_FILL = 0.82;

/**
 * Looking north (north stays up, like a map), 58° down, at the closest
 * distance where the points' bounding box fits on screen. A tilted view is
 * not symmetric (the near edge looms larger), so instead of a formula we
 * binary-search the distance and test the four corners with a scratch camera.
 */
function frameShot(points: readonly LocalPoint[], camera: PerspectiveCamera): Shot {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const centre = new Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  const corners = [
    new Vector3(minX, 0, minZ),
    new Vector3(maxX, 0, minZ),
    new Vector3(minX, 0, maxZ),
    new Vector3(maxX, 0, maxZ),
  ];
  const pitch = MathUtils.degToRad(58);
  const probe = camera.clone();
  const p = new Vector3();
  const fits = (distance: number) => {
    const shot = orbit(centre, distance, pitch, Math.PI / 2);
    probe.position.copy(shot.position);
    probe.lookAt(centre);
    probe.updateMatrixWorld();
    return corners.every((c) => {
      p.copy(c).project(probe);
      return Math.abs(p.x) <= OVERVIEW_FILL && Math.abs(p.y) <= OVERVIEW_FILL;
    });
  };
  // Close enough for a small spot (a crossing, a person); far enough for a whole route.
  let lo = 30;
  let hi = 40_000;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return orbit(centre, hi, pitch, Math.PI / 2);
}

/** The whole route on screen. */
const overviewShot = (route: Route, camera: PerspectiveCamera) =>
  frameShot(route.polyline.points, camera);

/** Where a commuter waits: a close 3/4 view of one stop. */
const STOP_DISTANCE_M = 60;

function stopShot(route: Route, stop: number): Shot {
  const p = route.polyline.pointAt(route.stops[stop]?.s ?? 0);
  return orbit(new Vector3(p.x, 0, p.z), STOP_DISTANCE_M, MathUtils.degToRad(30), p.heading - 0.6);
}

function streetShot(route: Route): Shot {
  const p = route.polyline.pointAt(Math.min(STREET_AT_M, route.polyline.length / 2));
  // Look along the road, from behind and slightly to the side.
  return orbit(
    new Vector3(p.x, 0, p.z),
    STREET_DISTANCE_M,
    MathUtils.degToRad(34),
    p.heading - 0.6,
  );
}

/**
 * Where the first view waits behind the loading screen: above and back from
 * the street shot, so that every map tile it settles into is already loaded.
 */
function openingShot(route: Route): Shot {
  const { target } = streetShot(route);
  const p = route.polyline.pointAt(Math.min(STREET_AT_M, route.polyline.length / 2));
  return orbit(target, STREET_DISTANCE_M * OPENING_BACK, OPENING_PITCH, p.heading - OPENING_YAW);
}

/** Current ground pose of a follow target, or null if it no longer exists. */
function followPose(twin: TwinRuntime, target: FollowTarget, out: GroundPose): GroundPose | null {
  if (target.kind === 'live') {
    const v = twin.live.get(target.id);
    return v?.lastFix ? Object.assign(out, v.pose) : null;
  }
  return twin.fleet.vehicles[target.index] ? fleetPose(twin.fleet, target.index, out) : null;
}

/** The ride-along cameras for whatever `target` is (a live phone: as a jeepney). */
function viewsFor(twin: TwinRuntime, target: FollowTarget | null): FollowViews {
  const kind = target?.kind === 'sim' ? twin.fleet.vehicles[target.index]?.kind : undefined;
  return FOLLOW_VIEWS[kind ?? 'jeepney'];
}

function followKey(target: FollowTarget): string {
  return target.kind === 'live' ? `live:${target.id}` : `sim:${target.index}`;
}

function rotateAroundY(v: Vector3, cx: number, cz: number, dHeading: number): void {
  const ox = v.x - cx;
  const oz = v.z - cz;
  const c = Math.cos(dHeading);
  const s = Math.sin(dHeading);
  v.x = cx + ox * c + oz * s;
  v.z = cz - ox * s + oz * c;
}

export function CameraRig() {
  const { twin } = useRuntimes();
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const controls = useThree((s) => s.controls) as Controls | null;
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const shot = useApp((s) => s.shot);
  const follow = useApp((s) => s.follow);
  const tracked = useApp((s) => s.trackedRiderId);
  const tween = useRef<gsap.core.Tween | null>(null);
  const outsideFov = useRef(camera.fov);
  const viewMode = follow?.view ?? 'chase';

  // Restore the exterior lens before computing a new overview/street shot.
  useEffect(() => {
    if (viewMode === 'inside') {
      camera.fov = INSIDE_VFOV;
    } else if (viewMode === 'pov') {
      camera.fov = POV_VFOV;
    } else {
      camera.fov = outsideFov.current;
    }
    camera.updateProjectionMatrix();
    return () => {
      camera.fov = outsideFov.current;
      camera.updateProjectionMatrix();
    };
  }, [camera, viewMode]);

  /** Animate to a shot (or jump, when duration is 0). */
  const fly = useMemo(
    () =>
      (to: Shot, duration: number, delay = 0) => {
        if (!controls) return;
        tween.current?.kill();
        const fromTarget = controls.target.clone();
        const fromPos = camera.position.clone();
        const t = { k: duration > 0 ? 0 : 1 };
        const apply = () => {
          controls.target.lerpVectors(fromTarget, to.target, t.k);
          camera.position.lerpVectors(fromPos, to.position, t.k);
          controls.update();
        };
        if (duration === 0) return apply();
        tween.current = gsap.to(t, {
          k: 1,
          duration,
          delay,
          ease: 'power2.inOut',
          onUpdate: apply,
        });
      },
    [camera, controls],
  );

  // Dev only: expose the camera next to the runtimes (see App.tsx).
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __camera: { camera, controls, scene, gl } });
  }, [camera, controls, gl]);

  // The user taking the controls wins over any running animation.
  useEffect(() => {
    if (!controls) return;
    const cancel = () => tween.current?.kill();
    controls.addEventListener('start', cancel);
    return () => controls.removeEventListener('start', cancel);
  }, [controls]);

  // New route: show all of it, then dive in to street level. The first one
  // waits for the loading screen, and settles in as that lifts.
  const started = useApp((s) => s.started);
  const opened = useRef(false);
  useEffect(() => {
    if (!started) fly(openingShot(twin.route), 0);
    else if (!opened.current) fly(streetShot(twin.route), OPENING_S);
    else {
      fly(overviewShot(twin.route, camera), 0);
      fly(streetShot(twin.route), 2.4, 0.9);
    }
    opened.current = started;
    return () => {
      tween.current?.kill();
    };
  }, [twin.route, camera, fly, started]);

  // Explicit shot requests from the UI. seq 0 is the initial state, not a request.
  useEffect(() => {
    if (shot.seq === 0) return;
    fly(
      shot.kind === 'overview'
        ? overviewShot(twin.route, camera)
        : shot.kind === 'area' && shot.area?.length
          ? frameShot(shot.area, camera)
          : shot.kind === 'stop'
            ? stopShot(twin.route, shot.stop ?? 0)
            : streetShot(twin.route),
      1.6,
    );
  }, [shot, twin.route, camera, fly]);

  // Follow. `steering` = the rig owns the camera angle; the user dragging
  // hands the angle back to them (the camera still travels with the jeepney).
  const scratch = useMemo(
    () => ({
      pose: { x: 0, z: 0, heading: 0 },
      rider: newRiderPose(),
      d: new Vector3(),
      want: new Vector3(),
    }),
    [],
  );
  const steering = useRef(false);
  const recenter = useRef(false);
  const prevLock = useRef<{
    key: string;
    view: 'chase' | 'inside' | 'pov';
    x: number;
    z: number;
    heading: number;
  } | null>(null);

  useEffect(() => {
    if (!follow && tracked === null) {
      prevLock.current = null;
      steering.current = false;
      recenter.current = false;
      return;
    }
    tween.current?.kill();
    steering.current = true;
    recenter.current = true;
  }, [follow, tracked]);

  useEffect(() => {
    if (!controls) return;
    const release = () => {
      if (useApp.getState().follow?.view === 'inside') return;
      // Only hand angle control to the user once the camera has dived near the vehicle
      // so a stray click mid-flight from the map overview never strands the camera in the sky.
      if (camera.position.distanceTo(controls.target) < 40) {
        steering.current = false;
      }
    };
    controls.addEventListener('start', release);
    return () => controls.removeEventListener('start', release);
  }, [camera, controls]);

  useFrame((_, dt) => {
    if (!controls) return;
    const pose = follow ? followPose(twin, follow, scratch.pose) : null;
    const V = viewsFor(twin, follow);
    const rider = tracked === null ? null : twin.crew.worldPose(tracked, scratch.rider);

    if (rider) {
      prevLock.current = null;
      const k = 1 - Math.exp(-dt * 5);
      scratch.d
        .set(rider.x, rider.y + 1, rider.z)
        .sub(controls.target)
        .multiplyScalar(k);
      controls.target.add(scratch.d);
      camera.position.add(scratch.d);
      if (steering.current)
        camera.position.lerp(scratch.want.set(-8, 7, 10).add(controls.target), k);
      camera.lookAt(controls.target);
      camera.updateMatrixWorld();
    } else if (pose && follow?.view === 'inside') {
      // Rigidly attached: the cabin must not swim around the viewer.
      const c = Math.cos(pose.heading);
      const s = Math.sin(pose.heading);
      const anchorX = pose.x + V.centreX * c;
      const anchorZ = pose.z - V.centreX * s;
      prevLock.current = {
        key: followKey(follow),
        view: 'inside',
        x: anchorX,
        z: anchorZ,
        heading: pose.heading,
      };
      const local = (v: Vector3, out: Vector3) =>
        out.set(pose.x + v.x * c + v.z * s, v.y, pose.z - v.x * s + v.z * c);
      local(V.insideEye, camera.position);
      local(V.insideLook, controls.target);
      // Bypass orbit damping, distance limits and zoom while cabin-mounted.
      // Controls run earlier in the frame; this is the final camera transform.
      camera.lookAt(controls.target);
      camera.updateMatrixWorld();
    } else if (pose && follow?.view === 'pov') {
      // Front cab / Driver POV: seated in the front cab with 360° mouse look-around.
      const c = Math.cos(pose.heading);
      const s = Math.sin(pose.heading);
      const eyeX = pose.x + V.povEye.x * c + V.povEye.z * s;
      const eyeZ = pose.z - V.povEye.x * s + V.povEye.z * c;
      const key = followKey(follow);
      const prev = prevLock.current;

      if (!prev || prev.key !== key || prev.view !== 'pov') {
        camera.position.set(eyeX, V.povEye.y, eyeZ);
        controls.target.set(
          pose.x + V.povTarget.x * c + V.povTarget.z * s,
          V.povTarget.y,
          pose.z - V.povTarget.x * s + V.povTarget.z * c,
        );
        prevLock.current = { key, view: 'pov', x: eyeX, z: eyeZ, heading: pose.heading };
      } else {
        const dx = eyeX - prev.x;
        const dz = eyeZ - prev.z;
        const dHeading = Math.atan2(
          Math.sin(pose.heading - prev.heading),
          Math.cos(pose.heading - prev.heading),
        );
        controls.target.x += dx;
        controls.target.z += dz;
        camera.position.x += dx;
        camera.position.z += dz;
        if (Math.abs(dHeading) > 1e-6) {
          rotateAroundY(controls.target, eyeX, eyeZ, dHeading);
          rotateAroundY(camera.position, eyeX, eyeZ, dHeading);
        }
        // Keep the head pivot anchored in the front cab seat even if the user right-drags.
        const driftX = eyeX - camera.position.x;
        const driftY = V.povEye.y - camera.position.y;
        const driftZ = eyeZ - camera.position.z;
        camera.position.set(eyeX, V.povEye.y, eyeZ);
        controls.target.x += driftX;
        controls.target.y += driftY;
        controls.target.z += driftZ;
        prev.x = eyeX;
        prev.z = eyeZ;
        prev.heading = pose.heading;
      }
      camera.lookAt(controls.target);
      camera.updateMatrixWorld();
    } else if (pose && follow) {
      const c = Math.cos(pose.heading);
      const s = Math.sin(pose.heading);
      const anchorX = pose.x + V.centreX * c;
      const anchorZ = pose.z - V.centreX * s;
      const key = followKey(follow);
      const prev = prevLock.current;

      if (prev && prev.key === key && (prev.view === 'inside' || prev.view === 'pov')) {
        // Switching from Inside/POV view to Outside view on the same jeepney:
        // place the camera outside the cabin immediately so it never clips through the roof.
        controls.target.set(anchorX, V.targetY, anchorZ);
        camera.position.set(
          anchorX - c * V.chaseBack + s * V.chaseLeft,
          V.chaseUp,
          anchorZ + s * V.chaseBack + c * V.chaseLeft,
        );
        prevLock.current = { key, view: 'chase', x: anchorX, z: anchorZ, heading: pose.heading };
        steering.current = false;
        recenter.current = false;
        camera.lookAt(controls.target);
        camera.updateMatrixWorld();
      } else {
        if (prev && prev.key === key) {
          // Lock the camera and orbit pivot to the jeepney's exact frame-to-frame motion (zero lag).
          const dx = anchorX - prev.x;
          const dz = anchorZ - prev.z;
          const dHeading = Math.atan2(
            Math.sin(pose.heading - prev.heading),
            Math.cos(pose.heading - prev.heading),
          );
          controls.target.x += dx;
          controls.target.z += dz;
          camera.position.x += dx;
          camera.position.z += dz;
          if (Math.abs(dHeading) > 1e-6) {
            rotateAroundY(controls.target, anchorX, anchorZ, dHeading);
            rotateAroundY(camera.position, anchorX, anchorZ, dHeading);
          }
          prev.x = anchorX;
          prev.z = anchorZ;
          prev.heading = pose.heading;
          prev.view = 'chase';
        } else {
          prevLock.current = { key, view: 'chase', x: anchorX, z: anchorZ, heading: pose.heading };
          steering.current = true;
          recenter.current = true;
        }

        if (recenter.current) {
          // Smoothly glide the orbit pivot onto the jeepney cabin centre.
          scratch.d.set(anchorX, V.targetY, anchorZ).sub(controls.target);
          if (scratch.d.lengthSq() <= 0.0004) {
            controls.target.add(scratch.d);
            camera.position.add(scratch.d);
            recenter.current = false;
          } else {
            scratch.d.multiplyScalar(1 - Math.exp(-dt * 7));
            controls.target.add(scratch.d);
            camera.position.add(scratch.d);
          }
        } else {
          // Allow free panning around the jeepney while keeping the pivot within reach.
          const ox = controls.target.x - anchorX;
          const oz = controls.target.z - anchorZ;
          const dist = Math.hypot(ox, oz);
          if (dist > MAX_TARGET_OFFSET_M) {
            const scale = MAX_TARGET_OFFSET_M / dist;
            const cx = anchorX + ox * scale - controls.target.x;
            const cz = anchorZ + oz * scale - controls.target.z;
            controls.target.x += cx;
            controls.target.z += cz;
            camera.position.x += cx;
            camera.position.z += cz;
          }
          const clampedY = MathUtils.clamp(controls.target.y, 0.25, 3.2);
          if (clampedY !== controls.target.y) {
            const cy = clampedY - controls.target.y;
            controls.target.y = clampedY;
            camera.position.y += cy;
          }
        }

        if (steering.current) {
          // Ease the camera to its 3/4 chase spot behind and slightly left of the jeepney.
          scratch.want
            .set(
              -c * V.chaseBack + s * V.chaseLeft,
              V.chaseUp - V.targetY,
              s * V.chaseBack + c * V.chaseLeft,
            )
            .add(controls.target);
          camera.position.lerp(scratch.want, 1 - Math.exp(-dt * 5));
          if (!recenter.current && camera.position.distanceToSquared(scratch.want) <= 0.0025) {
            camera.position.copy(scratch.want);
            steering.current = false;
          }
        }

        camera.lookAt(controls.target);
        camera.updateMatrixWorld();
      }
    } else {
      prevLock.current = null;
    }

    // Close views need a near plane in centimetres, the overview in metres.
    const near = MathUtils.clamp(
      camera.position.distanceTo(controls.target) * NEAR_FRACTION,
      0.05,
      2,
    );
    if (Math.abs(near - camera.near) > camera.near * 0.2) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
  }, FRAME_ORDER.camera);

  return null;
}
