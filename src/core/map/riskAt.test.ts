import { describe, expect, it } from 'vitest';
import { ROAD_RISKS, riskAt, type RoadRisk, type StreetLines } from './streets';

/** An ordinary road along z = 0, and optionally another along z = `at` that is a risk. */
function roads(risk?: RoadRisk, at = 30): StreetLines {
  return {
    points: new Float32Array([0, 0, 1000, 0]),
    starts: new Uint32Array([0, 2]),
    widths: new Float32Array([8]),
    national: new Uint8Array(1),
    risky: new Uint8Array(1),
    hazards: {
      points: new Float32Array(risk ? [0, at, 1000, at] : []),
      starts: new Uint32Array(risk ? [0, 2] : [0]),
      kinds: new Uint8Array(risk ? [ROAD_RISKS.indexOf(risk)] : []),
    },
  };
}

describe('where nobody can wait for a ride', () => {
  it('is on an expressway, a flyover, its ramps and tunnels', () => {
    for (const risk of ROAD_RISKS) expect(riskAt([roads(risk)], { x: 500, z: 28 })).toBe(risk);
  });

  it('is not the ordinary road alongside', () => {
    expect(riskAt([roads('expressway')], { x: 500, z: 8 })).toBeNull();
    expect(riskAt([roads()], { x: 500, z: 8 })).toBeNull();
  });

  it('is not somewhere with no road near', () => {
    expect(riskAt([roads('expressway')], { x: 500, z: 200 })).toBeNull();
  });
});
