/**
 * Text labels pinned to 3D points (place names, stop names).
 *
 * Plain DOM spans over the canvas, positioned once per frame. drei's <Text>
 * patches shaders and does not work with WebGPU, and one <Html> component per
 * label would mean one React subtree each; this is one loop over an array.
 *
 * Each kind has a maximum camera distance, so zooming out leaves only the big
 * names (districts, terminals) and zooming in reveals the small ones. Map
 * names (MAP_NAMES) never cover one another or anything else: where two would
 * overlap on screen, the less important gives way.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { Vector3, type Camera } from 'three';
import { viewScale } from './viewScale';

export interface SceneLabel {
  text: string;
  /** Styling and visibility class, e.g. 'suburb', 'quarter', 'stop', 'terminal'. */
  kind: string;
  x: number;
  y: number;
  z: number;
  /** Lift with the symbol it names (stop pins grow when zoomed out). */
  scaleWithView?: boolean;
  /** Shown instead of hiding beyond the kind's distance (⛽ for a gas station). */
  farText?: string;
  /** Background colour (a gas station's brand). */
  tone?: string;
}

/** Hide a label beyond this camera distance (metres). */
const MAX_DISTANCE: Record<string, number> = {
  'demand-stop': 3_000,
  'incoming-rider': 1_200,
  'passenger-area': 100,
  /** A planned trip (TripPlanLayer.tsx): its ends and stops from anywhere, its ways closer. */
  'trip-from': 60_000,
  'trip-waiting': 60_000,
  'trip-to': 60_000,
  'trip-board': 60_000,
  'trip-alight': 60_000,
  'trip-way': 15_000,
  /** Beyond this a gas station is just its ⛽ (farText), visible at any distance. */
  fuel: 2_500,
  'fuel-across': 2_500,
  terminal: 15_000,
  city: 12_000,
  town: 9_000,
  suburb: 6_000,
  stop: 2_500,
  village: 2_500,
  quarter: 1_800,
  /** Stations and main roads from a way off; landmarks and side streets close up. */
  station: 3_000,
  road: 1_500,
  landmark: 700,
  street: 450,
};

/**
 * No label beyond what the camera can see of the ground. Tilted up, the map
 * runs out before the horizon does, and a label on ground that far off hangs
 * in the empty sky, however close to the horizon it belongs. This far off, or
 * this many heights of the camera, so that from high up everything still shows.
 */
const SIGHT_M = 900;
const SIGHT_HEIGHTS = 7;
/** Labels go out over the last of that, not all at once. */
const FADE_SHARE = 0.2;
/** A trip's own labels stop sooner: from low down they would pile up at the horizon. */
const TRIP_SIGHT_M = 500;
const TRIP_SIGHT_HEIGHTS = 12;

/**
 * Whether `p` is behind the camera. Never read off a projected depth: that is
 * above 1 behind the camera in some depth ranges and below 0 in others (WebGPU's),
 * and a label behind it, turned upside down, lands in the sky at the top of the view.
 */
export function behindCamera(camera: Camera, p: Vector3): boolean {
  const m = camera.matrixWorld.elements;
  // The camera looks down its own −z.
  return (p.x - m[12]!) * -m[8]! + (p.y - m[13]!) * -m[9]! + (p.z - m[14]!) * -m[10]! <= 0;
}

/** How far a label can be seen from a camera this high. */
export const labelSight = (height: number) => Math.max(SIGHT_M, height * SIGHT_HEIGHTS);

/** Beyond this even a short form (⛽) hides: from over Metro Manila they are only clutter. */
const FAR_TEXT_MAX_M = 12_000;

/**
 * The map's own names, most important first: they give way to each other, and
 * to every other label (a stop, a station's price, a rider), never the reverse.
 */
const MAP_NAMES: Record<string, number> = {
  city: 7,
  town: 6,
  road: 5,
  station: 5,
  suburb: 4,
  landmark: 3,
  quarter: 2,
  village: 2,
  street: 1,
};
/** A label's box on screen, roughly: this wide a character, this tall, this much padding (px). */
const CHAR_PX = 6.4;
const LABEL_PX = 17;
const PAD_PX = 10;

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
/** The box of a label of `chars` characters pinned (bottom centre) at (px, py). */
const boxAt = (px: number, py: number, chars: number): Box => {
  const half = (chars * CHAR_PX + PAD_PX) / 2;
  return { x0: px - half, x1: px + half, y0: py - LABEL_PX, y1: py };
};

export function Labels({
  labels,
  hidden = false,
}: {
  labels: readonly SceneLabel[];
  /** Hide all labels (e.g. inside a jeepney, where they would float through walls). */
  hidden?: boolean;
}) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  const container = useMemo(() => {
    const div = document.createElement('div');
    div.className = 'scene-labels';
    return div;
  }, []);

  useEffect(() => {
    gl.domElement.parentElement?.appendChild(container);
    return () => container.remove();
  }, [gl, container]);

  const nodes = useMemo(
    () =>
      labels.map((l) => {
        const el = document.createElement('span');
        el.className = `scene-label scene-label--${l.kind}`;
        el.textContent = l.text;
        el.hidden = true;
        if (l.tone) el.style.background = l.tone;
        return el;
      }),
    [labels],
  );

  useEffect(() => container.replaceChildren(...nodes), [container, nodes]);
  useEffect(() => {
    container.hidden = hidden;
  }, [container, hidden]);

  const v = useMemo(() => new Vector3(), []);

  useFrame((state) => {
    camera.updateMatrixWorld();
    const k = viewScale(state);
    // On screen this frame: every other label's box, and the map names that may show.
    const taken: Box[] = [];
    const names: Array<{ el: HTMLElement; box: Box; rank: number; distance: number }> = [];
    const tripSight = Math.max(TRIP_SIGHT_M, camera.position.y * TRIP_SIGHT_HEIGHTS);
    const sight = labelSight(camera.position.y);
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i]!;
      const el = nodes[i]!;
      v.set(l.x, l.scaleWithView ? l.y * k : l.y, l.z);
      const distance = v.distanceTo(camera.position);
      const far = distance > (MAX_DISTANCE[l.kind] ?? 3_000);
      const trip = l.kind.startsWith('trip-');
      const limit = trip ? Math.min(tripSight, sight) : sight;
      const gone =
        distance > limit ||
        (far && (!l.farText || distance > FAR_TEXT_MAX_M)) ||
        (trip && distance > tripSight);
      // Far away, a label with a short form shrinks to it instead of vanishing.
      if (l.farText) {
        const text = far ? l.farText : l.text;
        if (el.textContent !== text) el.textContent = text;
      }
      const behind = behindCamera(camera, v);
      v.project(camera);
      // |x|,|y| > 1: off screen.
      const hidden = gone || behind || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
      if (el.hidden !== hidden) el.hidden = hidden;
      if (hidden) continue;
      const px = (v.x * 0.5 + 0.5) * size.width;
      const py = (-v.y * 0.5 + 0.5) * size.height;
      const fade = (limit - distance) / (limit * FADE_SHARE);
      const opacity = fade >= 1 ? '' : fade.toFixed(2);
      if (el.style.opacity !== opacity) el.style.opacity = opacity;
      el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -100%)`;
      const box = boxAt(px, py, (el.textContent ?? '').length);
      const rank = MAP_NAMES[l.kind];
      if (rank === undefined) taken.push(box);
      else names.push({ el, box, rank, distance });
    }
    // Map names: the most important (then the nearest) first; one that would
    // cover a label already there gives way.
    names.sort((a, b) => b.rank - a.rank || a.distance - b.distance);
    for (const n of names) {
      const covered = taken.some((b) => overlaps(b, n.box));
      if (n.el.hidden !== covered) n.el.hidden = covered;
      if (!covered) taken.push(n.box);
    }
  });

  return null;
}
