import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { behindCamera, labelSight } from './Labels';

describe('map labels', () => {
  const camera = new PerspectiveCamera(42, 2, 2, 150_000);
  camera.position.set(0, 400, 0);
  camera.lookAt(1000, 0, 1000);
  camera.updateMatrixWorld();

  it('knows what is behind the camera, however the depth range runs', () => {
    expect(behindCamera(camera, new Vector3(500, 0, 500))).toBe(false);
    expect(behindCamera(camera, new Vector3(-500, 0, -500))).toBe(true);
    expect(behindCamera(camera, new Vector3(-5, 400, -5))).toBe(true);
  });

  it('keeps to the ground it can see: more from higher up', () => {
    expect(labelSight(15)).toBe(900);
    expect(labelSight(1000)).toBe(7000);
  });
});
