import { describe, expect, it } from 'vitest';
import { allLoaded, STAGES, STEADY_FRAMES, startupProgress, type Startup } from './startup';

const atStart: Startup = {
  engine: false,
  network: { state: 'loading', routes: 0 },
  map: { state: 'off', loaded: 0, total: 0 },
  noMap: false,
  steadyFrames: 0,
};
const loaded: Startup = {
  ...atStart,
  engine: true,
  network: { state: 'ready', routes: 547 },
  map: { state: 'ready', loaded: 12, total: 12 },
};

describe('startupProgress', () => {
  it('starts at the first stop with nothing done', () => {
    expect(startupProgress(atStart)).toEqual({ stage: 0, share: 0 });
  });

  it('moves through the stops as each thing arrives', () => {
    const engine = { ...atStart, engine: true };
    expect(startupProgress(engine).stage).toBe(1);
    const routes = { ...engine, network: loaded.network };
    expect(startupProgress(routes).stage).toBe(2);
    expect(startupProgress(loaded).stage).toBe(3);
    expect(startupProgress({ ...loaded, steadyFrames: STEADY_FRAMES })).toEqual({
      stage: STAGES.length,
      share: 1,
    });
  });

  it('fills with the routes as they are built', () => {
    const half = { ...atStart, engine: true, network: { ...atStart.network, share: 0.5 } };
    expect(startupProgress(half)).toEqual({ stage: 1, share: 0.375 });
  });

  it('never passes a stop it has not reached, whatever finished first', () => {
    const mapFirst = { ...loaded, network: atStart.network };
    expect(startupProgress(mapFirst)).toEqual({ stage: 1, share: 0.25 });
  });

  it('fills with the map tiles as they come in', () => {
    const half = { ...loaded, map: { state: 'loading' as const, loaded: 6, total: 12 } };
    expect(startupProgress(half)).toEqual({ stage: 2, share: 0.625 });
  });

  it('does not take a map that has not started loading for a finished one', () => {
    expect(startupProgress({ ...loaded, map: atStart.map }).stage).toBe(2);
  });

  it('is not held up by what has failed: the app says so itself', () => {
    const failed: Startup = {
      ...loaded,
      network: { state: 'error', routes: 0 },
      map: { state: 'error', loaded: 0, total: 12 },
    };
    expect(allLoaded(failed)).toBe(true);
  });

  it('has no map to wait for when tiles are off', () => {
    expect(allLoaded({ ...loaded, map: atStart.map, noMap: true })).toBe(true);
  });

  it('counts as loaded before the frames settle, not before the map is in', () => {
    expect(allLoaded(loaded)).toBe(true);
    expect(allLoaded({ ...loaded, map: { state: 'loading', loaded: 11, total: 12 } })).toBe(false);
  });
});
