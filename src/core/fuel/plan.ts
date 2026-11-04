/**
 * Where to buy diesel, and how much: the stations on the way (no detour),
 * their prices, the tank, and the diesel the distance still to drive takes
 * with the riders on board. At each station the driver buys only enough to
 * reach a cheaper one in range; with none cheaper in range, what the rest of
 * the way needs, up to a full tank. So the dear litres are as few as can be,
 * and the cheap ones as many.
 */

export interface PlanStation {
  name: string;
  /** Along the way from here (metres). */
  metresAhead: number;
  /** Expected price (pesos a litre); null when not known: not planned on. */
  pesoPerL: number | null;
}

export interface FuelPlanInput {
  tankL: number;
  tankCapacityL: number;
  /** Diesel a kilometre with the riders on board (litres). */
  litresPerKm: number;
  /** Still to drive (km). */
  kmToGo: number;
  /** On the way, any order. */
  stations: readonly PlanStation[];
}

export interface FuelStopPlan {
  name: string;
  metresAhead: number;
  litres: number;
  pesoPerL: number;
  php: number;
}

export interface FuelPlan {
  /** How far the tank goes now, down to the reserve (km). */
  reachKm: number;
  /** True when the tank covers the whole way: no stop needed. */
  enough: boolean;
  stops: FuelStopPlan[];
  totalLitres: number;
  totalPhp: number;
  /** The same litres all bought at the nearest station with a price. */
  atNearestPhp: number | null;
  savingPhp: number;
  /** The way cannot be covered: no station in reach before the tank runs low. */
  shortKm: number;
}

/** Never planned below this share of the tank. */
export const RESERVE_SHARE = 0.1;

const round1 = (x: number) => Math.round(x * 10) / 10;
const peso = (x: number) => Math.round(x);

export function fuelPlan(input: FuelPlanInput): FuelPlan {
  const { tankCapacityL, litresPerKm, kmToGo } = input;
  const reserve = RESERVE_SHARE * tankCapacityL;
  const rangeKm = (litres: number) => Math.max(0, litres - reserve) / litresPerKm;
  const stations = input.stations
    .filter((s) => s.pesoPerL !== null && s.metresAhead / 1000 < kmToGo)
    .map((s) => ({ ...s, km: s.metresAhead / 1000, price: s.pesoPerL! }))
    .sort((a, b) => a.km - b.km);
  const reachKm = rangeKm(input.tankL);
  const stops: FuelStopPlan[] = [];
  let fuel = input.tankL;
  let at = 0;
  let price = Infinity; // where it starts is no station
  let shortKm = 0;
  for (;;) {
    const fullRange = at + rangeKm(tankCapacityL);
    const inReachFull = stations.filter((s) => s.km > at && s.km <= fullRange);
    // The first one in reach of a full tank that is cheaper than here.
    const cheaper = inReachFull.find((s) => s.price < price);
    let next: (typeof stations)[number] | null = null;
    let needL: number;
    if (cheaper) {
      next = cheaper;
      needL = reserve + (cheaper.km - at) * litresPerKm;
    } else if (kmToGo <= fullRange) {
      needL = reserve + (kmToGo - at) * litresPerKm;
    } else {
      // None cheaper in reach, and the end is not: fill up, and on to the cheapest in reach.
      needL = tankCapacityL;
      next = inReachFull.reduce<(typeof stations)[number] | null>(
        (best, s) => (!best || s.price < best.price ? s : best),
        null,
      );
    }
    const buy = Math.min(tankCapacityL, Math.max(fuel, needL)) - fuel;
    if (buy > 0.05 && price !== Infinity) {
      const here = stops.at(-1)!;
      here.litres = round1(here.litres + buy);
      here.php = peso(here.litres * here.pesoPerL);
      fuel += buy;
    }
    if (!next) {
      if (rangeKm(fuel) + at < kmToGo) shortKm = round1(kmToGo - at - rangeKm(fuel));
      break;
    }
    if (next.km - at > rangeKm(fuel)) {
      // Cannot reach it on what is in the tank (only at the start): as far as it goes.
      shortKm = round1(next.km - at - rangeKm(fuel));
      break;
    }
    fuel -= (next.km - at) * litresPerKm;
    at = next.km;
    price = next.price;
    stops.push({
      name: next.name,
      metresAhead: next.metresAhead,
      litres: 0,
      pesoPerL: next.price,
      php: 0,
    });
  }
  const bought = stops.filter((s) => s.litres > 0);
  const totalLitres = round1(bought.reduce((n, s) => n + s.litres, 0));
  const totalPhp = peso(bought.reduce((n, s) => n + s.litres * s.pesoPerL, 0));
  const nearest = stations[0];
  const atNearestPhp = nearest && totalLitres > 0 ? peso(totalLitres * nearest.price) : null;
  return {
    reachKm: round1(reachKm),
    enough: reachKm >= kmToGo,
    stops: bought,
    totalLitres,
    totalPhp,
    atNearestPhp,
    savingPhp: atNearestPhp === null ? 0 : Math.max(0, atNearestPhp - totalPhp),
    shortKm,
  };
}
