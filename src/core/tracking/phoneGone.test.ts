import { describe, expect, it } from 'vitest';
import { phoneGone } from './liveVehicle';

describe('a phone that has gone', () => {
  const now = 1_000_000_000;

  it('stays while it was heard from lately, a pause in the signal included', () => {
    expect(phoneGone(now, now)).toBe(false);
    expect(phoneGone(now - 30_000, now)).toBe(false);
  });

  it('leaves the map once nothing has been heard for a minute', () => {
    expect(phoneGone(now - 61_000, now)).toBe(true);
    // Left in the database for hours by a page closed without stopping.
    expect(phoneGone(now - 13 * 3600 * 1000, now)).toBe(true);
  });
});
