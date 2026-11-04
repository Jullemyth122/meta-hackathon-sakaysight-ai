/**
 * How far along the app is getting ready, for the loading screen
 * (src/ui/Splash.tsx). Four stages, a quarter of the rail each, whatever order
 * they really finish in: the rail never passes a stop it has not reached. The
 * last is not loading but settling: the first frames compile every shader and
 * upload every tile, so the app is only ready once its frames have gone quiet.
 */

import type { MapStatus, NetworkStatus } from './store';

/** What the screen says at each stop, in the order of the stops in index.html. */
export const STAGES = [
  'Starting the 3D engine',
  'Loading every jeepney and bus route',
  'Drawing Metro Manila',
  'Getting traffic moving',
] as const;
/** …and on arriving. */
export const ARRIVED = 'Sakay na!';

/** This many frames in a row, none longer than this: the app runs smoothly. */
export const STEADY_FRAMES = 30;
export const STEADY_FRAME_MS = 50;

export interface Startup {
  /** The GPU renderer is up. */
  engine: boolean;
  network: NetworkStatus;
  map: MapStatus;
  /** No map to wait for: tiles are turned off. */
  noMap: boolean;
  /** Steady frames in a row since everything loaded. */
  steadyFrames: number;
}

export interface StartupProgress {
  /** The stage under way; STAGES.length when all are done. */
  stage: number;
  /** Of the rail, 0 to 1. */
  share: number;
}

function networkShare({ network }: Startup): number {
  if (network.state === 'ready' || network.state === 'error') return 1;
  return network.share ?? 0;
}

function mapShare({ map, noMap }: Startup): number {
  if (noMap || map.state === 'ready' || map.state === 'partial' || map.state === 'error') return 1;
  return map.total > 0 ? map.loaded / map.total : 0;
}

export function startupProgress(s: Startup): StartupProgress {
  const parts = [
    s.engine ? 1 : 0,
    networkShare(s),
    mapShare(s),
    Math.min(1, s.steadyFrames / STEADY_FRAMES),
  ];
  const under = parts.findIndex((p) => p < 1);
  const stage = under < 0 ? STAGES.length : under;
  return { stage, share: (stage + (parts[stage] ?? 0)) / parts.length };
}

/** Everything is in, and all that is left is for the frames to settle. */
export const allLoaded = (s: Startup) =>
  startupProgress({ ...s, steadyFrames: STEADY_FRAMES }).stage === STAGES.length;
