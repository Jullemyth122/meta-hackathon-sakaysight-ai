/**
 * A fare matrix, read off a photo by Muse, turned into the app's fare rule.
 *
 * LTFRB fares change by order, and every jeepney, bus and UV Express must
 * post the matrix inside: a table of kilometres against the regular and
 * the discounted fare. Muse reads the table; this checks every row it read
 * against one rule (a fare for the first km, then so much a km), so a
 * misread row shows up instead of quietly changing anybody's fare. Only a
 * matrix that fits is used.
 */
import { fareFor, type FareRule } from './fare';

export interface MatrixRow {
  km: number;
  regular: number;
  /** Students, seniors and PWD; not every matrix photo shows it. */
  discounted?: number;
}

/** A fare off by more than this from the rule did not fit (₱: fares go by 25 centavos). */
const FITS_PHP = 0.26;
/** Of this many rows, one may be misread and the rest still settle the rule. */
const ROWS_PER_SLIP = 10;

/**
 * The rows as Muse sends them: `[[km, regular, discounted], ...]`, or
 * objects with those names. Anything else is dropped.
 */
export function parseRows(input: unknown): MatrixRow[] {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const num = (x: unknown) => {
    const n = typeof x === 'string' ? Number(x.replace(/[₱P,\s]/g, '')) : Number(x);
    return Number.isFinite(n) ? n : NaN;
  };
  const rows: MatrixRow[] = [];
  for (const r of value) {
    const [km, regular, discounted] = Array.isArray(r)
      ? [num(r[0]), num(r[1]), num(r[2])]
      : r && typeof r === 'object'
        ? [
            num((r as Record<string, unknown>).km),
            num((r as Record<string, unknown>).regular),
            num((r as Record<string, unknown>).discounted),
          ]
        : [NaN, NaN, NaN];
    if (!(km > 0) || !(regular > 0)) continue;
    rows.push(
      Number.isFinite(discounted) && discounted > 0 ? { km, regular, discounted } : { km, regular },
    );
  }
  // One row a km (the first read), in order.
  const byKm = new Map<number, MatrixRow>();
  for (const r of rows) if (!byKm.has(r.km)) byKm.set(r.km, r);
  return [...byKm.values()].sort((a, b) => a.km - b.km);
}

export interface MatrixRead {
  /** The rule, when the rows fit one. */
  rule: FareRule | null;
  rowsRead: number;
  /** Rows that do not fit the rule: maybe misread, to check on the photo. */
  offRows: Array<{ km: number; read: number; ruleSays: number }>;
  /** Why no rule, in a sentence. */
  why?: string;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN;
};

/** The fare rule a matrix's rows follow, when they follow one. */
export function ruleFromMatrix(rows: readonly MatrixRow[], discountPct = 20): MatrixRead {
  const read = (why: string, offRows: MatrixRead['offRows'] = []): MatrixRead => ({
    rule: null,
    rowsRead: rows.length,
    offRows,
    why,
  });
  if (rows.length < 3) return read('Fewer than three rows could be read off the photo.');
  const first = rows[0]!;
  const last = rows.at(-1)!;
  if (first.regular > 200 || last.regular > 2000) return read('Those are not fares.');

  // The minimum fare, as far as it goes; then so much a km.
  const base = first.regular;
  const baseKm = Math.max(
    ...rows.filter((r) => Math.abs(r.regular - base) < 0.01).map((r) => r.km),
  );
  // Discount: what the discounted column takes off, else the law's 20%.
  const cuts = rows
    .filter((r) => r.discounted !== undefined)
    .map((r) => (1 - r.discounted! / r.regular) * 100);
  const pct = cuts.length ? Math.round(median(cuts)) : discountPct;
  // The printed fares are rounded to 25 centavos, so the last row gives the
  // rate a km only roughly: the rates near it, by the centavo, are tried.
  const near = (estimate: number) =>
    Array.from({ length: 11 }, (_, k) => Math.round(estimate * 100) / 100 + (k - 5) / 100)
      .map((x) => Math.round(x * 100) / 100)
      .filter((x) => x > 0);
  const candidates: FareRule[] = [];
  if (last.km > baseKm)
    for (const perKm of near((last.regular - base) / (last.km - baseKm)))
      candidates.push({ base, baseKm, perKm, discountPct: pct });
  // So much a km from the first (a UV Express): no minimum.
  for (const perKm of near(last.regular / last.km))
    candidates.push({ base: 0, baseKm: 0, perKm, discountPct: pct });
  const fitOf = (rule: FareRule) => {
    const gaps = rows.map((r) => ({
      km: r.km,
      read: r.regular,
      ruleSays: fareFor(r.km, false, rule),
    }));
    return {
      rule,
      off: gaps.filter((x) => Math.abs(x.read - x.ruleSays) > FITS_PHP),
      error: gaps.reduce((sum, x) => sum + Math.abs(x.read - x.ruleSays), 0),
      // A round rate (₱2.20, not ₱2.21) where both fit as well: what an order would set.
      cents: Math.round(rule.perKm * 100) % 10 === 0 ? 0 : 1,
    };
  };
  const best = candidates
    .map(fitOf)
    .reduce((a, b) =>
      b.off.length < a.off.length ||
      (b.off.length === a.off.length &&
        (b.error < a.error - 1e-9 || (Math.abs(b.error - a.error) < 1e-9 && b.cents < a.cents)))
        ? b
        : a,
    );
  if (best.off.length > Math.floor(rows.length / ROWS_PER_SLIP))
    return read(
      `${best.off.length} of the ${rows.length} rows do not follow one fare rule: they may be misread.`,
      best.off,
    );
  return { rule: best.rule, rowsRead: rows.length, offRows: best.off };
}

/** The fare for a ride of `km` on the matrix: the row for the km started, else the rule's. */
export function fareOnMatrix(
  rows: readonly MatrixRow[],
  rule: FareRule,
  km: number,
  discounted: boolean,
): number {
  const row = rows.find((r) => r.km >= Math.ceil(km - 1e-9));
  if (row && (!discounted || row.discounted !== undefined))
    return discounted ? row.discounted! : row.regular;
  return fareFor(km, discounted, rule);
}
