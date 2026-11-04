/**
 * Takes over rendering when a camera inset is shown (useFrame priority 1):
 *
 *   1. ESP32 camera  → 320×240 render target (exactly a QVGA frame), at the
 *                      camera's own frame rate, not the screen's
 *   2. rear mirror   → render target, when riding in the front seat (optional)
 *   3. main camera   → screen
 *   4. HUD pass      → the frames drawn as quads: the camera picture-in-
 *                      picture bottom right, the mirror top centre
 *
 * The insets go through render targets rather than scissored viewports on
 * purpose: on WebGPU a viewport clear can wipe the whole framebuffer, while
 * a render target behaves the same on both backends.
 *
 * Each inset is a full extra render of the scene, so they are not redrawn
 * every screen frame, and how often depends on how much room the frame has:
 * smooth where there is plenty, cheaper on a packed route (insetPace.ts).
 *
 * The box/centroid overlay is HTML canvas on top (ui/PipOverlay.tsx); both
 * use PIP_LAYOUT so they line up.
 *
 * Orientation: the WebGL2 backend flips render-target textures when they are
 * sampled; the WebGPU backend does not (a WebGPU texture's first row is the
 * top). So on WebGPU the quads' v coordinate is flipped here, or the camera
 * frame shows upside down and the detection boxes miss the people.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  type DirectionalLight,
} from 'three';
import { sRGBTransferEOTF, texture } from 'three/tsl';
import { MeshBasicNodeMaterial, type Node, type WebGPURenderer } from 'three/webgpu';
import { ESP32_HEAD_DETECTOR, FRAME_H, FRAME_W } from '@/core/doorway/pipeline';
import { poseAtScale, viewScale } from '../world/viewScale';
import { InsetPace } from './insetPace';

/** Where the PiP sits, in CSS pixels from the bottom-right of the canvas. */
export const PIP_LAYOUT = { margin: 16, maxScale: 1, maxWidthFraction: 0.46 } as const;

/**
 * The rear-view mirror: a wide strip at the top right, `top` px down so it
 * clears the camera toolbar, opposite the jeepney card on the left
 * (ui/ViewControls).
 */
export const MIRROR_LAYOUT = {
  top: 64,
  margin: 16,
  width: 480,
  height: 140,
  maxWidthFraction: 0.4,
} as const;

/**
 * With the view zoomed out (or the camera still flying in), a picture means
 * posing the whole fleet at true size and back: this often, no more (seconds).
 */
const INSET_EVERY_ZOOMED_OUT_S = 1;

/** PiP size for a canvas width. It is anchored `margin` px from the bottom-right corner. */
export function pipSize(canvasW: number): { w: number; h: number } {
  const scale = Math.min(PIP_LAYOUT.maxScale, (canvasW * PIP_LAYOUT.maxWidthFraction) / FRAME_W);
  return { w: FRAME_W * scale, h: FRAME_H * scale };
}

/** Mirror size for a canvas width. It is anchored `top` px down, `margin` px from the right. */
export function mirrorSize(canvasW: number): { w: number; h: number } {
  const w = Math.min(MIRROR_LAYOUT.width, canvasW * MIRROR_LAYOUT.maxWidthFraction);
  return { w, h: (w * MIRROR_LAYOUT.height) / MIRROR_LAYOUT.width };
}

/** A render target and the quad that shows it on the HUD. */
function inset(width: number, height: number) {
  const target = new RenderTarget(width, height, { samples: 1 });
  // Its picture is finished output (see drawInset): shown as it is, not encoded again.
  const material = new MeshBasicNodeMaterial({
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  });
  material.colorNode = sRGBTransferEOTF(texture(target.texture).rgb) as Node<'vec3'>;
  const quad = new Mesh(new PlaneGeometry(1, 1), material);
  // The plane's original texture coordinates (bottom row v = 0, top row v = 1).
  const uv = quad.geometry.getAttribute('uv');
  const base = Array.from({ length: uv.count }, (_, i) => [uv.getX(i), uv.getY(i)] as const);
  return { target, quad, base, lastS: -Infinity };
}

/**
 * Draw an inset as finished output, as the screen is. A plain render target
 * wants other shaders (no tone mapping, no sRGB), and the first picture would
 * stop the view for seconds while every material in the scene is built again.
 */
function drawInset(
  gl: WebGPURenderer,
  target: RenderTarget,
  scene: Parameters<WebGPURenderer['render']>[0],
  camera: PerspectiveCamera,
): void {
  gl.setOutputRenderTarget(target);
  gl.setRenderTarget(target);
  gl.render(scene, camera);
  gl.setOutputRenderTarget(null);
}

/** The sun's shadow map is the main view's: a small pass must not draw it again. */
function withoutShadowPass(scene: Scene, draw: () => void): void {
  const sun = scene.getObjectByProperty('isDirectionalLight', true) as DirectionalLight | undefined;
  const updating = sun?.shadow.autoUpdate;
  if (sun) sun.shadow.autoUpdate = false;
  draw();
  if (sun) sun.shadow.autoUpdate = updating!;
}

/**
 * Draws one unseen inset as soon as `ready`, while the app is still starting
 * up: a render target's first picture needs a pipeline for everything in the
 * scene, and otherwise it would be the first click on a vehicle that waits.
 */
export function WarmInsets({ ready }: { ready: boolean }) {
  const done = useRef(false);
  useFrame((state) => {
    if (done.current || !ready) return;
    done.current = true;
    const gl = state.gl as unknown as WebGPURenderer;
    const target = new RenderTarget(FRAME_W, FRAME_H, { samples: 1 });
    const scene = state.scene as Scene;
    withoutShadowPass(scene, () => drawInset(gl, target, scene, new PerspectiveCamera()));
    gl.setRenderTarget(null);
    target.dispose();
  });
  return null;
}

export function PipRenderer({
  espCamera,
  mirrorCamera = null,
}: {
  espCamera: PerspectiveCamera;
  /** Looks back from the jeepney; shown as a mirror while set. */
  mirrorCamera?: PerspectiveCamera | null;
}) {
  const size = useThree((s) => s.size);
  const renderer = useThree((s) => s.gl) as unknown as WebGPURenderer;
  const pace = useMemo(() => new InsetPace(), []);

  const hud = useMemo(() => {
    const scene = new Scene();
    const camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);
    const esp = inset(FRAME_W, FRAME_H);
    const mirror = inset(MIRROR_LAYOUT.width * 1.5, MIRROR_LAYOUT.height * 1.5);
    scene.add(esp.quad, mirror.quad);
    return { scene, camera, esp, mirror };
  }, []);

  // Set (not toggle) the orientation, so running this twice is harmless. The
  // mirror is also flipped left to right: it is a mirror.
  useEffect(() => {
    const webgpu = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    for (const [view, mirrored] of [
      [hud.esp, false],
      [hud.mirror, true],
    ] as const) {
      const uv = view.quad.geometry.getAttribute('uv');
      view.base.forEach(([u, v], i) => {
        uv.setXY(i, mirrored ? 1 - u : u, webgpu ? 1 - v : v);
      });
      uv.needsUpdate = true;
    }
  }, [renderer, hud]);

  // Pixel-space HUD camera: (0, 0) is the canvas's bottom-left corner.
  useEffect(() => {
    const { camera, esp, mirror } = hud;
    camera.left = 0;
    camera.right = size.width;
    camera.top = size.height;
    camera.bottom = 0;
    camera.updateProjectionMatrix();
    const pip = pipSize(size.width);
    esp.quad.scale.set(pip.w, pip.h, 1);
    esp.quad.position.set(
      size.width - PIP_LAYOUT.margin - pip.w / 2,
      PIP_LAYOUT.margin + pip.h / 2,
      0,
    );
    const m = mirrorSize(size.width);
    mirror.quad.scale.set(m.w, m.h, 1);
    mirror.quad.position.set(
      size.width - MIRROR_LAYOUT.margin - m.w / 2,
      size.height - MIRROR_LAYOUT.top - m.h / 2,
      0,
    );
  }, [hud, size]);

  useEffect(
    () => () => {
      for (const view of [hud.esp, hud.mirror]) {
        view.target.dispose();
        view.quad.geometry.dispose();
        view.quad.material.dispose();
      }
    },
    [hud],
  );

  useFrame((state, dt) => {
    pace.update(dt);
    const { mirror: mirrorFps, esp: espShare } = pace.rates;
    const espFps = ESP32_HEAD_DETECTOR.fps * espShare;
    // R3F types `gl` as WebGLRenderer; Renderer.tsx actually gives us a WebGPURenderer.
    const gl = state.gl as unknown as WebGPURenderer;
    const { scene, camera } = state;
    const now = state.clock.elapsedTime;
    const mainScale = viewScale(state);
    const rescaled = mainScale !== 1;
    // Half a frame early counts as on time: a picture due every two frames
    // would otherwise miss by a hair and wait for the third.
    const due = (lastS: number, everyS: number) => now - lastS >= everyS - dt / 2;
    const espDue = due(hud.esp.lastS, rescaled ? INSET_EVERY_ZOOMED_OUT_S : 1 / espFps);
    // Never both in one frame: each is a whole extra render, and together they stall it.
    const mirrorDue =
      !espDue &&
      !!mirrorCamera &&
      due(hud.mirror.lastS, rescaled ? INSET_EVERY_ZOOMED_OUT_S : 1 / mirrorFps);
    hud.mirror.quad.visible = !!mirrorCamera;

    if (espDue || mirrorDue) {
      // The insets stand for real cameras and mirrors: they see everything
      // at true size, not enlarged for the zoomed-out main view (see
      // world/viewScale.ts).
      if (rescaled) poseAtScale(1);
      withoutShadowPass(scene as Scene, () => {
        if (espDue) {
          drawInset(gl, hud.esp.target, scene, espCamera);
          hud.esp.lastS = now;
        }
        if (mirrorDue) {
          drawInset(gl, hud.mirror.target, scene, mirrorCamera!);
          hud.mirror.lastS = now;
        }
      });
      if (rescaled) poseAtScale(mainScale);
    }
    gl.setRenderTarget(null);
    gl.render(scene, camera);

    // Draw the insets on top without clearing what is already on screen.
    // The quads ignore depth, so no depth clear is needed either.
    const autoClear = gl.autoClear;
    gl.autoClear = false;
    gl.render(hud.scene, hud.camera);
    gl.autoClear = autoClear;
  }, 1);

  return null;
}
