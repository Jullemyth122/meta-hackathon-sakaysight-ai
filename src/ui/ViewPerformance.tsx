import { viewTiming } from '@/core/performance/frameTiming';
import { useTicker } from './useTicker';

/** Which graphics chip, in a word, for the header: this matters on a two-GPU laptop. */
function chipName(name: string | null): string {
  if (!name) return 'GPU unnamed';
  if (/nvidia|rtx|gtx/i.test(name)) return 'NVIDIA';
  if (/radeon|amd/i.test(name)) return 'Radeon';
  if (/intel/i.test(name)) return 'Intel';
  return name.slice(0, 16);
}

export function ViewPerformance() {
  useTicker(1);
  const r = viewTiming.report;
  return (
    <span
      className="chip"
      aria-label="3D view performance"
      title={
        r
          ? `Main 3D view, last ${r.frames} frames. 95% of frames: ${r.p95Ms.toFixed(1)} ms or faster. Longest: ${r.longestMs.toFixed(1)} ms. CPU is this page's code; GPU is the graphics chip (${viewTiming.gpuName ?? 'not named by the browser'}). 60 FPS needs both under 16.7 ms: the bigger number is what is holding it back. Detector FPS is separate.`
          : 'Measuring the main 3D view while this tab is active. Detector FPS is separate.'
      }
    >
      {r
        ? `${Math.round(r.fps)} FPS · CPU ${r.cpuMs.toFixed(0)} ms · GPU ${
            r.gpuMs === null ? '–' : `${r.gpuMs.toFixed(0)} ms`
          } · ${chipName(viewTiming.gpuName)}`
        : 'View FPS: measuring…'}
    </span>
  );
}
