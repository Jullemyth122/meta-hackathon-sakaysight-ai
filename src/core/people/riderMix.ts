/**
 * Who rides, when and where: the shares of regular, student, senior, PWD
 * and pregnant riders change through the day, the week and from stop to
 * stop, around the day's average (the base mix). So one jeepney can fill
 * with students at a school at 6:30 while the next one, at 10, carries
 * seniors to the market.
 *
 *   hour   students ride to school 6–8 AM and home 3–6 PM, few at night;
 *          seniors from mid-morning to mid-afternoon, off the rush; PWD
 *          riders a little more off the rush too.
 *   week   day 0 (day 1 of the month) is a Monday, an assumption. On
 *          Saturdays and Sundays few students ride, a few more seniors.
 *   stop   at a school's stop, students are several times as common once
 *          classes let out (from SCHOOL_OUT_H); in the morning they come
 *          to it (the twin's destinations) more than they leave it.
 *   day    each day every kind's share wanders by up to DAY_SWING either
 *          way, so no two days are alike.
 *
 * `calibrate` keeps the base meaning what it says, the share of a weekday's
 * riders as a whole, while the hours and stops move around it. All of this
 * is a simulation assumption, not survey data.
 */

import { RIDER_KINDS, type RiderKind } from '../fare';

export type Mix = Record<RiderKind, number>;

/** A weekday's riders as a whole (assumption): riderKindOf draws from this too. */
export const BASE_MIX: Mix = {
  regular: 0.65,
  student: 0.2,
  senior: 0.08,
  pwd: 0.05,
  pregnant: 0.02,
};

// Each kind relative to its day's average, by hour from midnight.
// prettier-ignore
const STUDENT_BY_HOUR = [
  0.1, 0.1, 0.1, 0.1, 0.1, 0.5, // 0–5
  2.2, 2.2, 0.9, 0.6, 0.6, 1.1, // 6–11: to school; half-day classes at noon
  1.2, 0.8, 0.8, 1.5, 1.8, 1.5, // 12–17: home from school
  1, 0.6, 0.4, 0.25, 0.15, 0.1, // 18–23
];
// prettier-ignore
const SENIOR_BY_HOUR = [
  0.2, 0.2, 0.2, 0.2, 0.2, 0.4, // 0–5
  0.5, 0.6, 1, 1.7, 1.9, 1.8, // 6–11: errands, market, clinic
  1.5, 1.6, 1.5, 1.2, 0.8, 0.6, // 12–17
  0.5, 0.4, 0.3, 0.2, 0.15, 0.1, // 18–23
];
// prettier-ignore
const PWD_BY_HOUR = [
  0.8, 0.8, 0.8, 0.8, 0.8, 0.8, // 0–5
  0.6, 0.6, 0.8, 1.3, 1.3, 1.3, // 6–11
  1.3, 1.3, 1.3, 1.3, 0.8, 0.6, // 12–17
  0.6, 0.8, 0.8, 0.8, 0.8, 0.8, // 18–23
];
/** At a school's stop, students are this many times as common from SCHOOL_OUT_H, before it this many. */
const SCHOOL_STUDENTS = 3;
const SCHOOL_OUT_H = 11;
const SCHOOL_MORNING_STUDENTS = 1.5;
/** On Saturdays and Sundays, students this share of a weekday's; seniors this many times. */
const WEEKEND_STUDENTS = 0.25;
const WEEKEND_SENIORS = 1.3;
/** Each day, each kind's share is up to this much higher or lower (seeded by the day). */
const DAY_SWING = 0.2;

/** When and where a rider sets out. */
export interface MixWhere {
  /** Hour of the day (0–24, fractions allowed). */
  hour: number;
  /** Day index: 0 is day 1 of the month, a Monday. */
  day: number;
  /** At a school's stop. */
  school: boolean;
}

/** Whether day index `day` (0 = a Monday) is a Saturday or Sunday. */
export const weekend = (day: number): boolean => ((day % 7) + 7) % 7 >= 5;

/** Whether a stop is a school's, by its name. */
export const schoolStop = (name: string): boolean =>
  /\b(school|university|college|academy|campus|institute)\b/i.test(name);

/** Kind `kind`'s factor at `w`, the day's swing aside. */
function factor(kind: RiderKind, w: MixWhere): number {
  const h = ((Math.floor(w.hour) % 24) + 24) % 24;
  const end = weekend(w.day);
  if (kind === 'student')
    return (
      STUDENT_BY_HOUR[h]! *
      (w.school ? (h >= SCHOOL_OUT_H ? SCHOOL_STUDENTS : SCHOOL_MORNING_STUDENTS) : 1) *
      (end ? WEEKEND_STUDENTS : 1)
    );
  if (kind === 'senior') return SENIOR_BY_HOUR[h]! * (end ? WEEKEND_SENIORS : 1);
  if (kind === 'pwd') return PWD_BY_HOUR[h]!;
  return 1;
}

/** Day `day`'s swing for `kind`, 1 ± DAY_SWING, fixed by `seed`. */
function swing(kind: RiderKind, day: number, seed: number): number {
  let h = Math.imul(seed ^ 0x6d697820, 0x9e3779b1) ^ Math.imul(day + 1, 0x85ebca6b);
  h = Math.imul(h ^ Math.imul(RIDER_KINDS.indexOf(kind) + 1, 0xc2b2ae35), 0x27d4eb2f);
  const u = ((h ^ (h >>> 15)) >>> 0) / 4_294_967_296;
  return 1 + DAY_SWING * (2 * u - 1);
}

const ONES = Object.fromEntries(RIDER_KINDS.map((k) => [k, 1])) as Mix;

/**
 * The mix at `w`: `base` × `cal` (see calibrate) × the hour's, week's and
 * stop's factors × the day's swing (fixed by `seed`; none when `seed` is
 * null), as shares adding up to 1.
 */
export function mixAt(base: Mix, w: MixWhere, cal: Mix = ONES, seed: number | null = 0): Mix {
  const raw = RIDER_KINDS.map(
    (k) => base[k] * cal[k] * factor(k, w) * (seed === null ? 1 : swing(k, w.day, seed)),
  );
  const total = raw.reduce((a, b) => a + b, 0);
  return Object.fromEntries(
    RIDER_KINDS.map((k, i) => [k, total > 0 ? raw[i]! / total : k === 'regular' ? 1 : 0]),
  ) as Mix;
}

/**
 * Factors for mixAt that make a weekday's mix, over riders setting out as
 * `cells` say (how many, at what hour, at a school or not), average to
 * `base`. Without them the morning's students would add to the base.
 */
export function calibrate(
  base: Mix,
  cells: ReadonlyArray<{ weight: number; hour: number; school: boolean }>,
): Mix {
  const cal = { ...ONES };
  const total = cells.reduce((a, c) => a + c.weight, 0);
  if (total <= 0) return cal;
  // The same hour and kind of stop gives the same mix, however many stops.
  const together = new Map<string, { weight: number; hour: number; school: boolean }>();
  for (const c of cells) {
    const key = `${c.hour}:${c.school}`;
    const same = together.get(key);
    if (same) same.weight += c.weight;
    else together.set(key, { ...c });
  }
  for (let round = 0; round < 50; round++) {
    const avg = { ...ONES };
    for (const k of RIDER_KINDS) avg[k] = 0;
    for (const c of together.values()) {
      const mix = mixAt(base, { hour: c.hour, day: 0, school: c.school }, cal, null);
      for (const k of RIDER_KINDS) avg[k] += (c.weight * mix[k]) / total;
    }
    for (const k of RIDER_KINDS) if (avg[k] > 0) cal[k] *= base[k] / avg[k];
  }
  return cal;
}

/** The kind that draw `u` (0–1) picks from `mix`. */
export function drawKind(mix: Mix, u: number): RiderKind {
  let sum = 0;
  for (const k of RIDER_KINDS) {
    sum += mix[k];
    if (u < sum) return k;
  }
  return 'regular';
}
