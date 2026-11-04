export interface FrameReport {
  fps: number;
  p95Ms: number;
  longestMs: number;
  frames: number;
  /** Mean time the page's code took a frame (simulation, placing things, issuing the draws). */
  cpuMs: number;
  /** Mean time the graphics chip took a frame; null when the browser will not say. */
  gpuMs: number | null;
}

/** Main-view frame intervals, including stutters; independent of detector FPS. */
export class FrameTiming {
  report: FrameReport | null = null;
  /** The chip drawing the view, as the browser names it. */
  gpuName: string | null = null;
  private samples: number[] = [];
  private seconds = 0;
  private cpu = { total: 0, n: 0 };
  private gpu = { total: 0, n: 0 };

  reset(): void {
    this.report = null;
    this.samples.length = 0;
    this.seconds = 0;
    this.cpu = { total: 0, n: 0 };
    this.gpu = { total: 0, n: 0 };
  }

  addCpu(ms: number): void {
    this.cpu.total += ms;
    this.cpu.n++;
  }

  addGpu(ms: number): void {
    this.gpu.total += ms;
    this.gpu.n++;
  }

  add(dtS: number): void {
    if (!(dtS > 0) || !Number.isFinite(dtS)) return;
    this.samples.push(dtS * 1000);
    this.seconds += dtS;
    if (this.seconds < 2) return;
    this.samples.sort((a, b) => a - b);
    this.report = {
      fps: this.samples.length / this.seconds,
      p95Ms: this.samples[Math.ceil(this.samples.length * 0.95) - 1]!,
      longestMs: this.samples[this.samples.length - 1]!,
      frames: this.samples.length,
      cpuMs: this.cpu.total / Math.max(1, this.cpu.n),
      gpuMs: this.gpu.n > 0 ? this.gpu.total / this.gpu.n : null,
    };
    this.samples.length = 0;
    this.seconds = 0;
    this.cpu = { total: 0, n: 0 };
    this.gpu = { total: 0, n: 0 };
  }
}

export const viewTiming = new FrameTiming();
