import { addAfterEffect, addEffect, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { viewTiming } from '@/core/performance/frameTiming';

interface TimedRenderer {
  backend: { trackTimestamp?: boolean };
  resolveTimestampsAsync(type: 'render'): Promise<number | undefined>;
}

/**
 * Frame intervals, and how long each frame took each side: the page's code
 * (from the start of the frame to the last draw issued) and the graphics chip
 * (the renderer's GPU timestamps, where the browser allows them).
 */
export function FrameMonitor() {
  const gl = useThree((s) => s.gl) as unknown as TimedRenderer;
  const skip = useRef(true);
  useEffect(() => {
    let startedAt = 0;
    let frames = 0;
    let reading = false;
    const stopStart = addEffect(() => {
      startedAt = performance.now();
    });
    const stopEnd = addAfterEffect(() => {
      if (document.hidden || startedAt === 0) return;
      viewTiming.addCpu(performance.now() - startedAt);
      frames++;
      if (reading || !gl.backend.trackTimestamp) return;
      reading = true;
      const over = frames;
      frames = 0;
      // Reads back what the frames since the last reading took, together.
      gl.resolveTimestampsAsync('render')
        .then((ms) => {
          if (ms) viewTiming.addGpu(ms / over);
        })
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    });
    return () => {
      stopStart();
      stopEnd();
    };
  }, [gl]);
  useEffect(() => {
    const reset = () => {
      viewTiming.reset();
      skip.current = true;
    };
    reset();
    document.addEventListener('visibilitychange', reset);
    return () => {
      document.removeEventListener('visibilitychange', reset);
      viewTiming.reset();
    };
  }, []);
  useFrame((_, dt) => {
    if (document.hidden) return;
    if (skip.current) {
      skip.current = false;
      return;
    }
    viewTiming.add(dt);
  }, -100);
  return null;
}
