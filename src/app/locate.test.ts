import { describe, expect, it } from 'vitest';
import { aroundSpot, homeMoved } from './locate';

describe('homeMoved', () => {
  const home = { x: 0, z: 0 };

  it('takes the first fix, with no start set yet', () => {
    expect(homeMoved(null, home, 500)).toBe(true);
  });

  it('stays put for GPS wandering around one spot', () => {
    expect(homeMoved(home, { x: 12, z: 9 }, 8)).toBe(false);
  });

  it('moves once they have really gone', () => {
    expect(homeMoved(home, { x: 80, z: 0 }, 10)).toBe(true);
  });

  it('does not trust a move smaller than the fix is unsure of', () => {
    expect(homeMoved(home, { x: 80, z: 0 }, 150)).toBe(false);
  });
});

describe('aroundSpot', () => {
  it('has the spot in the middle', () => {
    const [a, b] = aroundSpot({ x: 100, z: -40 });
    expect((a!.x + b!.x) / 2).toBe(100);
    expect((a!.z + b!.z) / 2).toBe(-40);
  });
});
