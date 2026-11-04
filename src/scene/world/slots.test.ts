import { describe, expect, it } from 'vitest';
import { chooseDetail, keepSlots, STAY_DETAIL, type Detail, type Slotted } from './slots';

describe('drawing slots for the nearest jeepneys', () => {
  it('keeps each jeepney in its slot (so in its colour) while it stays near; newcomers fill the gaps', () => {
    const a: Slotted = [1, 0];
    const b: Slotted = [1, 1];
    const c: Slotted = [2, 5];
    const d: Slotted = [3, 2];
    let slots = keepSlots([null, null, null], [a, b, c]);
    expect(slots).toEqual([a, b, c]);
    // The order by distance changes: nobody moves.
    slots = keepSlots(slots, [c, a, b]);
    expect(slots).toEqual([a, b, c]);
    // b drives off, d comes near: d takes b's slot, a and c stay.
    slots = keepSlots(slots, [d, c, a, b]);
    expect(slots).toEqual([a, d, c]);
    // Fewer near than slots: the rest are empty.
    expect(keepSlots(slots, [c])).toEqual([null, null, c]);
  });

  it('paints a jeepney the same whichever slot it is in, over many refills', () => {
    // As NetworkLayer: a flow jeepney's livery by its own number.
    const livery = (s: Slotted): string => ['red', 'yellow', 'green'][s[1] % 3]!;
    const fleet: Slotted[] = Array.from({ length: 30 }, (_, i) => [i % 4, i]);
    const seen = new Map<string, string>();
    let slots: Array<Slotted | null> = Array(8).fill(null);
    for (let t = 0; t < 50; t++) {
      // The nearest eight change every refill.
      const nearest = [...fleet].sort(
        (x, y) => ((x[1] * 7 + t * 3) % 30) - ((y[1] * 7 + t * 3) % 30),
      );
      const before = new Map<string, number>(
        slots.flatMap((s, k) => (s ? [[`${s[0]}:${s[1]}`, k] as [string, number]] : [])),
      );
      slots = keepSlots(slots, nearest);
      slots.forEach((s, k) => {
        if (!s) return;
        const id = `${s[0]}:${s[1]}`;
        // Still near: same slot as before.
        if (before.has(id)) expect(before.get(id)).toBe(k);
        const colour = livery(s);
        expect(seen.get(id) ?? colour).toBe(colour);
        seen.set(id, colour);
      });
    }
  });
});

describe('how much detail each vehicle gets', () => {
  const limits = { full: { jeepney: 2, bus: 1 }, nearM: 700, near: 3 };
  const jeepney = (key: number, away: number) => ({ key, kind: 'jeepney' as const, away });
  const none = new Map<number, Detail>();

  it('the nearest of each kind in full, then the outside, then the outline', () => {
    const got = chooseDetail(
      [jeepney(1, 10), jeepney(2, 20), jeepney(3, 30), jeepney(4, 900)],
      none,
      limits,
    );
    expect([...got.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 'full'],
      [2, 'full'],
      [3, 'near'],
      [4, 'far'],
    ]);
  });

  it('counts each kind on its own', () => {
    const got = chooseDetail(
      [jeepney(1, 10), jeepney(2, 20), jeepney(3, 30), { key: 4, kind: 'bus', away: 500 }],
      none,
      limits,
    );
    expect(got.get(4)).toBe('full');
  });

  it('runs out of the nearer model before it leaves anyone undrawn', () => {
    const many = Array.from({ length: 40 }, (_, n) => jeepney(n, 100 + n));
    const got = [...chooseDetail(many, none, limits).values()];
    expect(got.filter((d) => d === 'near')).toHaveLength(3);
    expect(got.filter((d) => d === 'far')).toHaveLength(35);
  });

  it('two vehicles level with each other do not keep trading places', () => {
    const a = jeepney(1, 100);
    const b = jeepney(2, 100);
    const c = jeepney(3, 100);
    let was = chooseDetail([a, b, c], none, limits);
    const first = [...was.entries()].sort().join();
    // The order by distance wobbles a few percent at each refill.
    for (let t = 0; t < 20; t++) {
      const wobble = (x: ReturnType<typeof jeepney>, n: number) =>
        jeepney(x.key, x.away * (1 + 0.04 * Math.sin(t * 2.1 + n * 2)));
      was = chooseDetail([wobble(a, 0), wobble(b, 1), wobble(c, 2)], was, limits);
      expect([...was.entries()].sort().join()).toBe(first);
    }
  });

  it('holds a vehicle at the edge of a detail until it is clearly past it', () => {
    const edge = 700;
    const was = chooseDetail([jeepney(9, 1), jeepney(8, 2), jeepney(1, edge - 1)], none, limits);
    expect(was.get(1)).toBe('near');
    const at = (away: number, from: ReadonlyMap<number, Detail>) =>
      chooseDetail([jeepney(9, 1), jeepney(8, 2), jeepney(1, away)], from, limits).get(1);
    expect(at(edge + 40, was)).toBe('near');
    expect(at(edge * STAY_DETAIL + 1, was)).toBe('far');
    // Coming back in, not until it is inside the line.
    const out = new Map<number, Detail>([[1, 'far']]);
    expect(at(edge + 1, out)).toBe('far');
    expect(at(edge - 1, out)).toBe('near');
  });
});
