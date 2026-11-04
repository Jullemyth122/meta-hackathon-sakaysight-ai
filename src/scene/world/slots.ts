/**
 * Handing a fixed number of drawing slots to whichever things are nearest,
 * a few times a second, without shuffling them: a thing already in a slot
 * keeps it while it stays among the nearest, and only newcomers take the
 * slots set free. A slot's look (a jeepney's livery) then never jumps from
 * one jeepney to another, and nothing flickers as the order changes.
 */

/** A thing drawn: route and number. */
export type Slotted = readonly [number, number];

/** How a vehicle is drawn: its full model, its outside only, or its outline. */
export type Detail = 'full' | 'near' | 'far';

/** A vehicle already drawn in a detail keeps it until this much past the point of changing. */
export const STAY_DETAIL = 1.15;

export interface DetailLimits<Kind extends string> {
  /** How many of each kind in full, the nearest. */
  full: Record<Kind, number>;
  /** Out to this far `near`, at most `near` of them; the rest `far`. */
  nearM: number;
  near: number;
}

/**
 * How each vehicle is drawn, from how far off it looks. A vehicle gets some
 * slack to stay as it is (STAY_DETAIL), or two about level would trade places
 * at every refill and blink between models.
 */
export function chooseDetail<Kind extends string>(
  things: ReadonlyArray<{ key: number; kind: Kind; away: number }>,
  was: ReadonlyMap<number, Detail>,
  limits: DetailLimits<Kind>,
): Map<number, Detail> {
  const rank = (t: { key: number; away: number }, keeps: boolean) =>
    keeps ? t.away / STAY_DETAIL : t.away;
  const out = new Map<number, Detail>();
  const byFull = [...things].sort(
    (a, b) => rank(a, was.get(a.key) === 'full') - rank(b, was.get(b.key) === 'full'),
  );
  const fullLeft = { ...limits.full };
  for (const t of byFull) {
    if (fullLeft[t.kind] <= 0) continue;
    fullLeft[t.kind]--;
    out.set(t.key, 'full');
  }
  const close = (t: { key: number }) => {
    const drawn = was.get(t.key);
    return drawn === 'full' || drawn === 'near';
  };
  const byNear = [...things].sort((a, b) => rank(a, close(a)) - rank(b, close(b)));
  let nearLeft = limits.near;
  for (const t of byNear) {
    if (out.has(t.key)) continue;
    const inRange = rank(t, close(t)) <= limits.nearM;
    out.set(t.key, inRange && nearLeft > 0 ? 'near' : 'far');
    if (inRange) nearLeft--;
  }
  return out;
}

/** The slots after a refill: `prev` kept where still `nearest`, the rest of `nearest` in the gaps. */
export function keepSlots(
  prev: ReadonlyArray<Slotted | null>,
  nearest: ReadonlyArray<Slotted>,
): Array<Slotted | null> {
  const key = (s: Slotted) => `${s[0]}:${s[1]}`;
  const wanted = new Set(nearest.slice(0, prev.length).map(key));
  const next = prev.map((s) => (s && wanted.has(key(s)) ? s : null));
  const drawn = new Set(next.flatMap((s) => (s ? [key(s)] : [])));
  let free = 0;
  for (const s of nearest.slice(0, prev.length)) {
    if (drawn.has(key(s))) continue;
    while (next[free]) free++;
    next[free] = s;
  }
  return next;
}
