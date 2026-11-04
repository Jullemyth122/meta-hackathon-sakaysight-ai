import { describe, expect, it } from 'vitest';
import { areaOf, areasAround, MOST_CELLS } from './area';
import type { SessionUpdate } from './types';

const at = (lat: number, lng: number, role: 'commuter' | 'driver' = 'driver') =>
  ({
    meta: { sessionId: 's', vehicleId: 'v', source: 'driver-device', role, startedAt: 0 },
    fix: { lat, lng, accuracyM: 5, speedMps: null, headingDeg: null, timestamp: 0 },
  }) as Pick<SessionUpdate, 'meta' | 'fix'>;

describe('the map cells phones are filed under', () => {
  it('files a driver and a commuter on the same spot apart', () => {
    expect(areaOf(at(14.7525, 121.0563))).toBe('v:1475_12105');
    expect(areaOf(at(14.7525, 121.0563, 'commuter'))).toBe('p:1475_12105');
  });

  it('a view listens to the cells it covers, of the kinds it shows', () => {
    const spot = { lat: 14.7525, lng: 121.0563 };
    const own = areaOf(at(spot.lat, spot.lng));
    const near = areasAround(spot, 1500, ['v']);
    expect(near).toContain(own);
    expect(near.every((a) => a.startsWith('v:'))).toBe(true);
    // 1.5 km round: a few cells, not the whole city.
    expect(near.length).toBeGreaterThanOrEqual(4);
    expect(near.length).toBeLessThanOrEqual(25);
    // A phone 5 km off is not in it.
    expect(near).not.toContain(areaOf(at(spot.lat + 0.045, spot.lng)));
  });

  it('never more than MOST_CELLS cells, however far out the view', () => {
    const all = areasAround({ lat: 14.6, lng: 121 }, 40_000, ['v', 'p']);
    expect(all.length).toBe(2 * MOST_CELLS);
    expect(areasAround({ lat: 14.6, lng: 121 }, 1000, [])).toEqual([]);
  });
});
