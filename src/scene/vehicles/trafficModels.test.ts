import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { VEHICLES, type FleetKind, type VehicleKind } from '@/core/vehicles/specs';
import {
  TRAFFIC_DETAILS,
  TRAFFIC_LOOKS,
  trafficModel,
  trafficParts,
  type TrafficDetail,
} from './trafficModels';
import { zFights } from './zFighting';

const KINDS: FleetKind[] = ['jeepney', 'modern', 'uv', 'bus'];
const triangles = (look: (typeof TRAFFIC_LOOKS)[number], detail: TrafficDetail) =>
  trafficModel(look, detail).attributes.position!.count / 3;

describe('the models of the traffic', () => {
  it.each(TRAFFIC_LOOKS)(
    '%s: far cheaper than in full, and each detail cheaper than the last',
    (look) => {
      expect(triangles(look, 'near')).toBeLessThan(1200);
      expect(triangles(look, 'near')).toBeGreaterThan(200); // more than a shape: it has to look right
      expect(triangles(look, 'far')).toBeLessThan(160);
      expect(triangles(look, 'far')).toBeGreaterThan(36); // never a box (12)
    },
  );

  it.each(TRAFFIC_DETAILS)('%s: every vertex has its colour', (detail) => {
    for (const look of TRAFFIC_LOOKS) {
      const m = trafficModel(look, detail);
      expect(m.attributes.color!.count).toBe(m.attributes.position!.count);
      const c = m.attributes.color!.array as Float32Array;
      expect(c.every(Number.isFinite)).toBe(true);
    }
  });

  it('paints each jeepney livery differently, on one shape', () => {
    const a = trafficModel('red', 'near').attributes;
    const b = trafficModel('green', 'near').attributes;
    expect(a.position!.array).toEqual(b.position!.array);
    expect(a.color!.array).not.toEqual(b.color!.array);
  });

  it.each(TRAFFIC_DETAILS)('%s: the size of the real vehicle, standing on the ground', (detail) => {
    for (const kind of ['modern', 'uv', 'bus'] as VehicleKind[]) {
      const S = VEHICLES[kind];
      const all = new Box3();
      for (const g of Object.values(trafficParts(kind, detail))) {
        g!.computeBoundingBox();
        all.union(g!.boundingBox!);
      }
      const size = all.getSize(new Vector3());
      expect(all.min.y).toBeGreaterThan(-0.05);
      expect(size.y).toBeGreaterThan(S.heightM - 0.1);
      expect(size.y).toBeLessThan(S.heightM + 0.1);
      expect(size.x).toBeGreaterThan(S.lengthM - 0.25);
      expect(size.x).toBeLessThan(S.lengthM + 0.4);
      expect(size.z).toBeGreaterThan(S.widthM - 0.1);
      expect(size.z).toBeLessThan(S.widthM + 0.5);
    }
  });

  it.each(KINDS.flatMap((k) => TRAFFIC_DETAILS.map((d) => [k, d] as const)))(
    '%s %s: no two colours in one face anywhere',
    (kind, detail) => {
      const fights = zFights(trafficParts(kind, detail));
      expect(fights.map((f) => `${f.slots.join('/')} at ${f.at.map((c) => c.toFixed(2))}`)).toEqual(
        [],
      );
    },
  );
});
