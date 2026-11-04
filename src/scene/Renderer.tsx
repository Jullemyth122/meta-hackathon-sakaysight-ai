/**
 * The R3F canvas, backed by three's WebGPURenderer.
 *
 * WebGPURenderer uses WebGPU when the browser has it and silently falls back
 * to WebGL2 when it does not, so this is safe on every phone and laptop.
 * Set VITE_RENDERER=webgl to force the WebGL2 backend (useful for comparing).
 *
 * Constraint that comes with WebGPU: only built-in / node materials. No
 * ShaderMaterial, no onBeforeCompile, which also rules out drei's <Text>
 * and anything else that patches shaders. Labels are HTML overlays instead.
 */

import { Canvas, extend, useThree, type ThreeToJSXElements } from '@react-three/fiber';
import { useEffect, type ReactNode } from 'react';
import * as THREE from 'three/webgpu';
import { onPhone } from '@/app/device';
import { config } from '@/config';
import { viewTiming } from '@/core/performance/frameTiming';
import { FrameMonitor } from './FrameMonitor';

declare module '@react-three/fiber' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}
// Make every three/webgpu class available as a JSX element.
extend(THREE as unknown as Parameters<typeof extend>[0]);

interface Props {
  children: ReactNode;
  camera: { position: [number, number, number]; fov?: number; near?: number; far?: number };
  /** Stop drawing (the canvas is hidden), keeping the scene and its loaded map. */
  paused?: boolean;
  onBackend?: (backend: 'WebGPU' | 'WebGL2') => void;
  /**
   * The GPU dropped our device (driver reset, GPU memory pressure, many hot
   * reloads). Nothing draws after that, so the owner should remount us.
   */
  onLost?: (reason: string) => void;
}

/** Half a screen's rate and a little less sharp: a phone's battery is the drawing. */
const PHONE_FRAME_MS = 32;
const PHONE_DPR = 1.5;

/** Asks for a frame at the phone's pace (the Canvas draws on demand there). */
function PhonePace() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < PHONE_FRAME_MS) return;
      last = now;
      invalidate();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [invalidate]);
  return null;
}

export function Renderer({ children, camera, paused = false, onBackend, onLost }: Props) {
  return (
    <Canvas
      shadows
      frameloop={paused ? 'never' : onPhone ? 'demand' : 'always'}
      camera={{ fov: 42, near: 0.3, far: 6000, ...camera }}
      // Cap pixel ratio: 3× phones would quadruple fill cost for no visible gain.
      dpr={[1, onPhone ? PHONE_DPR : 1.75]}
      gl={async (props) => {
        const renderer = new THREE.WebGPURenderer({
          ...(props as ConstructorParameters<typeof THREE.WebGPURenderer>[0]),
          antialias: true,
          forceWebGL: config.renderer === 'webgl',
          powerPreference: 'high-performance',
          // From 5 cm to 150 km, an ordinary depth buffer cannot tell what is in
          // front of what far from the camera: surfaces flicker as the view turns.
          reversedDepthBuffer: true,
          // For the view's GPU time in the header (FrameMonitor); off by itself if unsupported.
          trackTimestamp: true,
        });
        await renderer.init();
        const adapter = (
          renderer.backend as {
            device?: { adapterInfo?: { vendor?: string; description?: string } };
          }
        ).device?.adapterInfo;
        viewTiming.gpuName = adapter?.description || adapter?.vendor || null;
        renderer.onDeviceLost = (info) => {
          console.warn('GPU device lost:', info.message);
          onLost?.(info.message);
        };
        renderer.toneMapping = THREE.NeutralToneMapping;
        const isWebGPU =
          (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
        onBackend?.(isWebGPU ? 'WebGPU' : 'WebGL2');
        return renderer;
      }}
    >
      {/* Restarted after a pause, so the gap is not measured as one long frame. */}
      <FrameMonitor key={String(paused)} />
      {onPhone && !paused && <PhonePace />}
      {children}
    </Canvas>
  );
}
