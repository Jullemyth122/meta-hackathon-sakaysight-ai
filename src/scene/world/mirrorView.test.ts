import { describe, expect, it } from 'vitest';
import { VEHICLES, type FleetKind } from '@/core/vehicles/specs';
import { mirrorView } from './CabinCameraFeed';

const KINDS: FleetKind[] = ['jeepney', 'modern', 'uv', 'bus'];

describe('the rear-view mirror', () => {
  it.each(KINDS)('%s: looks back from behind the vehicle, clear of its body', (kind) => {
    const { eye, look } = mirrorView(kind);
    const rear = kind === 'jeepney' ? -3.1 : -VEHICLES[kind].lengthM / 2;
    const top = kind === 'jeepney' ? 2.5 : VEHICLES[kind].heightM;
    expect(eye.x).toBeLessThan(rear);
    expect(eye.y).toBeGreaterThan(top);
    expect(look.x).toBeLessThan(eye.x - 20);
    expect(look.y).toBeLessThan(eye.y); // down at the road
    expect(eye.z).toBe(0);
    expect(look.z).toBe(0);
  });
});
