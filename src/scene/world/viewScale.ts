/**
 * Map-style symbol scaling: a 7 m jeepney is under a pixel when you look at a
 * 6 km route, so vehicles and stop pins grow as the camera pulls back.
 * Close up (street view, ride-along) everything is true to scale.
 *
 * The enlargement is for the main view only. A camera that stands for a real
 * sensor (the cabin camera) must see true sizes, or it would sit inside a
 * swollen jeepney looking at giant neighbours. So whatever is drawn
 * view-scaled registers a "pose at scale k" function (useScaledPose), and
 * the picture-in-picture pass re-poses the scene at scale 1 for its camera
 * and back at the view scale for the main camera (poseAtScale).
 */

import { useFrame, type RootState } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { Vector3 } from 'three';

/**
 * Camera distance (m) below which symbols are drawn at true size. Street
 * level and closer is always true scale, so jeepneys sit correctly in their
 * lanes next to real-width roads.
 */
const TRUE_SCALE_WITHIN_M = 600;
/** At the whole-route overview a jeepney is then ~140 m: a readable 20–30 px symbol. */
const MAX_SCALE = 20;

export function viewScale(state: RootState): number {
  const target = (state.controls as { target?: Vector3 } | null)?.target;
  if (!target) return 1;
  const d = state.camera.position.distanceTo(target);
  return Math.min(MAX_SCALE, Math.max(1, d / TRUE_SCALE_WITHIN_M));
}

/** Writes instance matrices for symbols drawn at scale `k` (1 = true size). */
export type ScaledPose = (k: number) => void;

const posers = new Set<ScaledPose>();

/**
 * Register a writer of view-scaled matrices. It runs every frame at the main
 * view's scale, and again whenever a render pass needs another scale. Do any
 * per-frame simulation work in a useFrame called *before* this hook, so the
 * writer only places things and can safely run more than once a frame.
 */
export function useScaledPose(pose: ScaledPose): void {
  const latest = useRef(pose);
  latest.current = pose;
  useEffect(() => {
    const run: ScaledPose = (k) => latest.current(k);
    posers.add(run);
    return () => {
      posers.delete(run);
    };
  }, []);
  useFrame((state) => latest.current(viewScale(state)));
}

/** Re-pose every view-scaled symbol at scale `k` before a render pass. */
export function poseAtScale(k: number): void {
  for (const pose of posers) pose(k);
}
