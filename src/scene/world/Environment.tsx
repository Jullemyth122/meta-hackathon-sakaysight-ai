/**
 * Ground, sky light and a sun whose shadow box follows the camera target.
 * A route can be kilometres long; one shadow map that covered all of it would
 * be blurry. Covering ~160 m around what you are looking at stays sharp.
 *
 * Fog starts far out and only hides the edge of the world at the horizon;
 * the map itself should read clearly from the overview.
 *
 * The light follows the simulation's clock: Manila's sun in November, low and
 * warm towards sunrise and sunset, a blue night after it (never so dark the
 * map cannot be read).
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Color, Vector3, type DirectionalLight, type Fog, type HemisphereLight } from 'three';
import { LAND_COLOR } from '@/core/map/style';
import { FLAT_ORDER } from '../map/flatLayers';

const SHADOW_HALF_EXTENT = 80;
const SHADOW_MAP_SIZE = 2048;
/** Fog at street level; it recedes with camera height (see useFrame). */
const FOG_NEAR_M = 2_500;
const FOG_FAR_M = 14_000;
const SUN_OFFSET: [number, number, number] = [60, 120, 45];
const SKY = '#dbe5ec';
/** From this high (metres) the 160 m the shadows cover is a speck: they are left as they are. */
const SHADOWS_UNSEEN_FROM_M = 600;
/** One shadow-map pixel on the ground (metres). */
const SHADOW_TEXEL_M = (2 * SHADOW_HALF_EXTENT) / SHADOW_MAP_SIZE;
/** The shadow map's own sideways and upward directions, looking down from the sun. */
const SUN_DOWN = new Vector3(...SUN_OFFSET).negate().normalize();
const SUN_RIGHT = new Vector3(0, 1, 0).cross(SUN_DOWN).normalize();
const SUN_UP = new Vector3().crossVectors(SUN_DOWN, SUN_RIGHT);
const texelStep = (m: number) => Math.round(m / SHADOW_TEXEL_M) * SHADOW_TEXEL_M;

/** Manila in November: the sun up at about 5:50 and down at about 5:30 PM (hours). */
const SUNRISE_H = 5.85;
const SUNSET_H = 17.5;
/** Light comes and goes over this long either side of them (hours). */
const TWILIGHT_H = 0.75;
/** The sun is low, its light warm, within this of sunrise or sunset (hours). */
const GOLDEN_H = 1.5;
/** At night the lights keep this much of their daytime strength: the map stays legible. */
const NIGHT_LIGHT = 0.4;
const DAY_SKY = new Color(SKY);
const DUSK_SKY = new Color('#e7c09c');
const NIGHT_SKY = new Color('#1d2535');
const NOON_SUN = new Color('#ffffff');
const LOW_SUN = new Color('#ffb36b');
const MOON = new Color('#a7b7d8');
const DAY_SKY_LIGHT = new Color('#ffffff');
const NIGHT_SKY_LIGHT = new Color('#8494b8');
const SUN_INTENSITY = 1.15;
const SKY_INTENSITY = 0.8;
/** The light is worked out again once the clock has moved this far (hours). */
const RELIGHT_EVERY_H = 1 / 120;

const ease = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/** How much day it is (0 night, 1 day) and how low and warm the sun is (0–1), at `hour`. */
export function daylight(hour: number): { day: number; low: number } {
  const day = Math.min(
    ease((hour - SUNRISE_H + TWILIGHT_H) / (2 * TWILIGHT_H)),
    ease((SUNSET_H + TWILIGHT_H - hour) / (2 * TWILIGHT_H)),
  );
  const fromEdge = Math.min(Math.abs(hour - SUNRISE_H), Math.abs(hour - SUNSET_H));
  return { day, low: 1 - ease(fromEdge / GOLDEN_H) };
}

export function Environment({
  groundSize = 200_000,
  hourOf,
}: {
  groundSize?: number;
  /** The simulation's hour of the day (0–24); noon light without it. */
  hourOf?: () => number;
}) {
  const sun = useRef<DirectionalLight>(null);
  const skyLight = useRef<HemisphereLight>(null);
  const litAt = useRef(-1);
  const onTexel = useMemo(() => new Vector3(), []);
  const controls = useThree((s) => s.controls) as {
    target?: { x: number; y: number; z: number };
  } | null;

  useLayoutEffect(() => {
    const light = sun.current;
    if (!light) return;
    const cam = light.shadow.camera;
    cam.left = -SHADOW_HALF_EXTENT;
    cam.right = SHADOW_HALF_EXTENT;
    cam.top = SHADOW_HALF_EXTENT;
    cam.bottom = -SHADOW_HALF_EXTENT;
    cam.near = 1;
    cam.far = 400;
    cam.updateProjectionMatrix();
    light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    light.shadow.bias = -0.0003;
    light.shadow.normalBias = 0.04;
    // Drawn once even when the view opens too high for shadows. Materials bind
    // a stand-in until the first pass, and that pass destroys it without
    // rebinding them: WebGPU then rejects every frame, and the canvas freezes.
    light.shadow.needsUpdate = true;
  }, []);

  useFrame((state) => {
    // The fog keeps its look at street level and moves out as the operator
    // zooms out over Metro Manila, so the map is never fogged over.
    const fog = state.scene.fog as Fog | null;
    if (fog) {
      const h = state.camera.position.y;
      fog.near = Math.max(FOG_NEAR_M, h * 2);
      fog.far = Math.max(FOG_FAR_M, h * 6);
    }
    const hour = hourOf ? ((hourOf() % 24) + 24) % 24 : 12;
    if (Math.abs(hour - litAt.current) >= RELIGHT_EVERY_H && sun.current && skyLight.current) {
      litAt.current = hour;
      const { day, low } = daylight(hour);
      const strength = NIGHT_LIGHT + (1 - NIGHT_LIGHT) * day;
      // The sky: night to day, flushed warm around sunrise and sunset.
      const background = state.scene.background as Color | null;
      const dusk = low * Math.min(1, 4 * day * (1 - day) + 0.25 * day);
      if (background instanceof Color) {
        background
          .copy(NIGHT_SKY)
          .lerp(DAY_SKY, day)
          .lerp(DUSK_SKY, dusk * 0.8);
        fog?.color.copy(background);
      }
      sun.current.intensity = SUN_INTENSITY * strength;
      sun.current.color
        .copy(MOON)
        .lerp(NOON_SUN, day)
        .lerp(LOW_SUN, low * day * 0.7);
      skyLight.current.intensity = SKY_INTENSITY * strength;
      skyLight.current.color.copy(NIGHT_SKY_LIGHT).lerp(DAY_SKY_LIGHT, day);
    }
    const light = sun.current;
    const t = controls?.target;
    if (!light || !t) return;
    light.shadow.autoUpdate = state.camera.position.y < SHADOWS_UNSEEN_FROM_M;
    // The sun moves in whole shadow-map pixels: sliding between them would
    // make every shadow's edge crawl as the view moves.
    onTexel.set(t.x, t.y, t.z);
    const right = SUN_RIGHT.dot(onTexel);
    const up = SUN_UP.dot(onTexel);
    onTexel
      .addScaledVector(SUN_RIGHT, texelStep(right) - right)
      .addScaledVector(SUN_UP, texelStep(up) - up);
    light.position.set(
      onTexel.x + SUN_OFFSET[0],
      onTexel.y + SUN_OFFSET[1],
      onTexel.z + SUN_OFFSET[2],
    );
    light.target.position.copy(onTexel);
    light.target.updateMatrixWorld();
  });

  return (
    <>
      <color attach="background" args={[SKY]} />
      <fog attach="fog" args={[SKY, FOG_NEAR_M, FOG_FAR_M]} />
      {/* Sky + sun add up to ~1.2× on flat ground: bright, without clipping light
          map colours to white (which is what made the first version look blank). */}
      <hemisphereLight ref={skyLight} args={['#ffffff', '#c9c0ae', SKY_INTENSITY]} />
      <directionalLight ref={sun} intensity={SUN_INTENSITY} castShadow />
      <mesh rotation-x={-Math.PI / 2} renderOrder={FLAT_ORDER.ground} receiveShadow>
        <planeGeometry args={[groundSize, groundSize]} />
        <meshLambertMaterial color={LAND_COLOR} depthTest={false} depthWrite={false} />
      </mesh>
    </>
  );
}
