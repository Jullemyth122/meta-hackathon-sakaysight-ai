/**
 * Lifts the loading screen. The screen itself is in index.html, painted before
 * any script loads; this only tells it how far along things are, and takes it
 * away once the app runs smoothly behind it, so nobody sees it get there.
 */

import { useEffect } from 'react';
import {
  allLoaded,
  ARRIVED,
  STAGES,
  STEADY_FRAME_MS,
  startupProgress,
  type Startup,
} from '@/app/startup';
import { useApp } from '@/app/store';
import { config } from '@/config';

/** Shown at least this long from the page opening, not a flash (ms). */
const LEAST_MS = 2000;
/** Everything loaded and the frames will not settle: a slow GPU; carry on (ms). */
const SETTLE_MS = 5000;
/**
 * Never longer than this once the app is running, whatever is still loading:
 * it is a way out for a machine in real trouble, as lifting early brings back
 * the lag this screen is here to hide (ms).
 */
const MOST_MS = 45_000;
/** How long the arrival stays up before the jeepney drives off (ms). */
const ARRIVED_MS = 450;
/** The drive off and the fade, as in index.html's `.is-leaving` (ms). */
const LEAVE_MS = 1100;

export function Splash() {
  useEffect(() => {
    const root = document.getElementById('splash');
    const now = document.getElementById('splash-now');
    const share = document.getElementById('splash-share');
    const fill = root?.querySelector('.sp-fill');
    const stops = root?.querySelectorAll('.sp-stops li');
    if (!root || !now || !share || !fill || !stops) return;

    let raf = 0;
    let timer = 0;
    const opened = performance.now();
    let last = opened;
    let steadyFrames = 0;
    let loadedAt: number | null = null;
    // Carry on from where the screen's own slow fill got to before any script ran.
    const { transform } = getComputedStyle(fill);
    let shown = { stage: 0, share: transform === 'none' ? 0 : new DOMMatrix(transform).a };

    const paint = () => {
      const percent = Math.round(shown.share * 100);
      root.style.setProperty('--share', String(shown.share));
      root.setAttribute('aria-valuenow', String(percent));
      share.textContent = `${percent}%`;
      now.textContent = STAGES[shown.stage] ?? ARRIVED;
      stops.forEach((stop, i) => {
        stop.classList.toggle('is-done', i < shown.stage);
        stop.classList.toggle('is-on', i === shown.stage);
      });
    };

    paint();
    root.classList.add('is-live');

    const leave = () => {
      useApp.getState().setStarted();
      root.classList.add('is-leaving');
      timer = window.setTimeout(() => {
        root.remove();
        document.getElementById('splash-style')?.remove();
      }, LEAVE_MS);
    };

    const tick = (time: number) => {
      const { backend, network, map, started } = useApp.getState();
      const status: Startup = {
        engine: backend !== null,
        network,
        map,
        noMap: config.mapTiles === 'off',
        steadyFrames,
      };
      const ready = allLoaded(status);
      if (ready) loadedAt ??= time;
      steadyFrames = ready && time - last <= STEADY_FRAME_MS ? steadyFrames + 1 : 0;
      last = time;

      // Never backwards: a tile list that grows must not take the bar with it.
      const { stage, share: done } = startupProgress(status);
      if (stage > shown.stage || done > shown.share) {
        shown = { stage: Math.max(stage, shown.stage), share: Math.max(done, shown.share) };
        paint();
      }

      const settled = stage === STAGES.length || (loadedAt !== null && time - loadedAt > SETTLE_MS);
      if (started || time - opened > MOST_MS || (settled && time > LEAST_MS)) {
        shown = { stage: STAGES.length, share: 1 };
        paint();
        timer = window.setTimeout(leave, ARRIVED_MS);
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, []);

  return null;
}
