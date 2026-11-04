import { describe, expect, it } from 'vitest';
import { waitOn, whoWaits, type FlowWait } from './NetworkLayer';

const L = 10_000;
const dt = 1 / 60;
const EASE = dt * 2.5;

describe('a vehicle of another route, waiting', () => {
  /** Drawn place over a run where its timetable does `speedAt`, held while `heldAt`. */
  function run(speedAt: (t: number) => number, heldAt: (t: number) => boolean, seconds = 30) {
    const w: FlowWait = { lag: 0, mps: 8, on: 100, s: 100 };
    let on = 100;
    const drawn: number[] = [];
    for (let t = 0; t < seconds; t += dt) {
      on += speedAt(t) * dt;
      waitOn(w, on, L, heldAt(t), dt, EASE);
      drawn.push(w.s);
    }
    return { w, drawn };
  }
  const neverBack = (drawn: readonly number[]) =>
    drawn.every((d, i) => i === 0 || d >= drawn[i - 1]! - 1e-6);

  it('stands dead still while held, however uneven the frames and whenever it is read', () => {
    const w: FlowWait = { lag: 30, mps: 0, on: 500, s: 470 };
    let on = 500;
    const frames = [1 / 60, 1 / 30, 1 / 120, 1 / 20, 1 / 60, 1 / 25];
    for (let k = 0; k < 600; k++) {
      const step = frames[k % frames.length]!;
      // What the models see is read before the wait is worked out, a frame apart.
      on += 8 * step;
      expect(w.s).toBeCloseTo(470, 9);
      waitOn(w, on, L, true, step, 0.05);
    }
    expect(w.s).toBeCloseTo(470, 9);
    expect(w.lag).toBeGreaterThan(30);
  });

  it('comes to a stop and stays there, never rolling back', () => {
    const { drawn } = run(
      () => 8,
      () => true,
    );
    expect(neverBack(drawn)).toBe(true);
    expect(drawn.at(-1)! - drawn.at(-120)!).toBeLessThan(0.01);
  });

  it('does not roll back when its timetable stops it at a stop while it waits', () => {
    // The timetable dwells 5 s out of 15: this is what made them rock.
    const { drawn } = run(
      (t) => (t % 15 < 10 ? 8 : 0),
      () => true,
    );
    expect(neverBack(drawn)).toBe(true);
  });

  it('does not roll back being held on and off', () => {
    const { drawn } = run(
      (t) => (t % 7 < 5 ? 8 : 0),
      (t) => t % 3 < 1.5,
    );
    expect(neverBack(drawn)).toBe(true);
  });

  it('catches up with its timetable afterwards, without jumping', () => {
    const { w, drawn } = run(
      () => 8,
      (t) => t < 8,
      60,
    );
    expect(neverBack(drawn)).toBe(true);
    expect(w.lag).toBe(0);
    const most = Math.max(...drawn.slice(1).map((d, i) => d - drawn[i]!));
    expect(most / dt).toBeLessThan(11);
  });

  it('gets going again only with room to, not the moment it could stand', () => {
    const v = { x: 0, z: 0, heading: 0, share: 1 };
    const ahead = { x: 15, z: 0, heading: 0 };
    expect(whoWaits([v], [ahead]).has(1)).toBe(false);
    expect(whoWaits([v], [ahead], new Set([1])).has(1)).toBe(true);
  });
});
