import type { FleetKind } from './vehicles/specs';

/**
 * Metro Manila traditional jeepney fare, as used by the prototype:
 * ₱14 for the first 4 km, then ₱2 per started km. Students, seniors and PWD
 * get 20% off, rounded to the nearest 25 centavos.
 *
 * Fares change by LTFRB order. Keep these numbers in one place and check them
 * against the current fare matrix before showing them to riders.
 */

export interface FareRule {
  base: number;
  baseKm: number;
  perKm: number;
  discountPct: number;
}

export const PH_TRADITIONAL_JEEPNEY: FareRule = { base: 14, baseKm: 4, perKm: 2, discountPct: 20 };

/**
 * The other PUVs, LTFRB matrix in effect from 28 September 2026 (as
 * transcribed by ParkinganPH and reported by Top Gear PH): the modern
 * jeepney ₱17 for 4 km then ₱2.40/km; the air-conditioned city bus ₱18 for
 * 5 km then ₱2.98/km; the UV Express ₱2.60/km, no minimum. 20% off for
 * students, seniors and PWD on all of them.
 */
export const PH_MODERN_JEEPNEY: FareRule = { base: 17, baseKm: 4, perKm: 2.4, discountPct: 20 };
export const PH_CITY_BUS_AIRCON: FareRule = { base: 18, baseKm: 5, perKm: 2.98, discountPct: 20 };
export const PH_UV_EXPRESS: FareRule = { base: 0, baseKm: 0, perKm: 2.6, discountPct: 20 };

/** The fare rule of each kind of vehicle in the fleet. */
export const FARE_BY_VEHICLE: Record<FleetKind, FareRule> = {
  jeepney: PH_TRADITIONAL_JEEPNEY,
  modern: PH_MODERN_JEEPNEY,
  bus: PH_CITY_BUS_AIRCON,
  uv: PH_UV_EXPRESS,
};
const PUBLISHED_FARES: Readonly<Record<FleetKind, FareRule>> = { ...FARE_BY_VEHICLE };

/**
 * A new fare for one kind of vehicle, from a fare matrix read off a photo
 * (fareMatrix.ts): from now on every fare in the app is worked out with it.
 */
export function setFareRule(kind: FleetKind, rule: FareRule): void {
  FARE_BY_VEHICLE[kind] = rule;
}

/** Back to the fares above, as published (a demo scene starts from them). */
export function resetFareRules(): void {
  Object.assign(FARE_BY_VEHICLE, PUBLISHED_FARES);
}

/**
 * Who a rider is, for the fare: students, senior citizens and persons with
 * disability pay the discounted fare (RA 11314, RA 9994, RA 10754); being
 * pregnant earns a priority seat, not a discount.
 */
export const RIDER_KINDS = ['regular', 'student', 'senior', 'pwd', 'pregnant'] as const;
export type RiderKind = (typeof RIDER_KINDS)[number];
export const RIDER_KIND_LABEL: Record<RiderKind, string> = {
  regular: 'Regular',
  student: 'Student',
  senior: 'Senior citizen',
  pwd: 'Person with disability (PWD)',
  pregnant: 'Pregnant',
};
export const discountedKind = (kind: RiderKind): boolean =>
  kind === 'student' || kind === 'senior' || kind === 'pwd';

export function fareFor(km: number, discounted = false, rule = PH_TRADITIONAL_JEEPNEY): number {
  // Small epsilon so 4.0000001 km from float maths does not cost an extra peso.
  const extraKm = Math.max(0, Math.ceil(km - rule.baseKm - 1e-9));
  // Fares are charged to the nearest 25 centavos (₱2.98 a km is not).
  const full = Math.round((rule.base + extraKm * rule.perKm) * 4) / 4;
  return discounted ? Math.round(full * (1 - rule.discountPct / 100) * 4) / 4 : full;
}
