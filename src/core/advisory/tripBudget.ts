import { FUEL, type FleetKind } from '../vehicles/specs';

/** Whole route geometry, never the driver's moving three-stop horizon. */
export interface TripRoute {
  name: string;
  loop: boolean;
  lengthKm: number;
  stops: { name: string; km: number; terminal: boolean; aliases: string[] }[];
}

export function tripRouteFor(route: {
  name: string;
  loop: boolean;
  polyline: { length: number };
  stops: readonly { name: string; s: number; terminal?: boolean }[];
}): TripRoute {
  return {
    name: route.name,
    loop: route.loop,
    lengthKm: route.polyline.length / 1000,
    stops: route.stops.map((s) => ({
      name: s.name,
      km: s.s / 1000,
      terminal: !!s.terminal,
      aliases: /SM City San Jose del Monte/i.test(s.name)
        ? ['SM Tungko', 'SM Tung', 'SM SJDM']
        : /SM City Fairview.*Terminal/i.test(s.name)
          ? ['SM Fairview', 'SM City Fairview']
          : /Tungko.*Station/i.test(s.name)
            ? ['Tungko']
            : [],
    })),
  };
}

/** Planning assumptions, NOT measured vehicle performance. Moving efficiency
 * excludes stationary idling; start fuel excludes idle, preventing double counting. */
export interface TripBudgetInputs {
  movingKmPerL: number;
  dieselPhpPerL: number;
  idleLPerHour: number;
  startLitresPerStop: number;
  dwellSecondsPerStop: number;
  trafficIdleMinutesPerLeg: number;
  terminalIdleMinutesPerLeg: number;
  /** null = visit each mapped stop on that leg once. */
  stopsPerLeg: number | null;
  otherCostsPhp: number;
}

/** The defaults for a `kind` (its own diesel: a bus 2.5 km a litre, a jeepney 6). */
export function defaultBudgetInputs(
  dieselPhpPerL: number,
  kind: FleetKind = 'jeepney',
): TripBudgetInputs {
  return {
    movingKmPerL: FUEL[kind].kmPerL,
    dieselPhpPerL,
    idleLPerHour: FUEL[kind].idleLPerH,
    startLitresPerStop: 0.02,
    dwellSecondsPerStop: 30,
    trafficIdleMinutesPerLeg: 10,
    terminalIdleMinutesPerLeg: 10,
    stopsPerLeg: null,
    otherCostsPhp: 0,
  };
}

export interface TripBudget {
  status: 'estimate' | 'clarification';
  answer: string;
  count?: number;
  kind?: 'round-trip' | 'one-way';
  inputs?: TripBudgetInputs;
  legs?: {
    from: string;
    to: string;
    km: number;
    stops: number;
    drivingLitres: number;
    startLitres: number;
    idleMinutes: number;
    idleLitres: number;
    totalLitres: number;
  }[];
  totals?: {
    km: number;
    stops: number;
    drivingLitres: number;
    startLitres: number;
    idleMinutes: number;
    idleLitres: number;
    litres: number;
    fuelPhp: number;
    listedCostsPhp: number;
  };
}

const WHOLE =
  /\b(round[ -]?trips?|balikan|ikot|laps?|whole trip|full trip|full route|buong (?:biyahe|ruta)|one[ -]?way)\b/i;
const COST = /\b(fuel|diesel|gas|gastos|gumagastos|cost|budget|konsumo|consumption|calculation)\b/i;
const FOLLOW_UP =
  /\b(what about|how about|paano|bakit|instead|same|realistic|total|diesel|km\s*\/\s*l|lit(?:er|re)|pesos?|php|price|waiting|idle|stop|traffic)\b|₱/i;

export function isTripBudgetQuestion(question: string, history: readonly string[] = []): boolean {
  if (/\b(fare|pamasahe|ticket)\b/i.test(question) && !COST.test(question)) return false;
  if (WHOLE.test(question)) return true;
  if (/\b\d+\s+trips?\b/i.test(question) && COST.test(question)) return true;
  // Keep ordinary navigation, savings and station questions on their own path.
  if (
    /\b(next stop|skip|pass the|should i stop|save|saving|cheapest|cheaper|nearest|saan.*diesel|pinakamura)\b/i.test(
      question,
    )
  )
    return false;
  if (COST.test(question) && /\b(total|whole|buong|kabuuan|magkano|from|mula)\b/i.test(question))
    return true;
  return FOLLOW_UP.test(question) && history.some((q) => WHOLE.test(q));
}

/** Recent user questions only; client/LLM answers cannot override the calculator. */
export function budgetHistory(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((q): q is string => typeof q === 'string')
        .slice(-4)
        .map((q) => q.slice(0, 500))
    : [];
}

const words: Record<string, number> = {
  one: 1,
  isa: 1,
  isang: 1,
  two: 2,
  dalawa: 2,
  dalawang: 2,
  three: 3,
  tatlo: 3,
  tatlong: 3,
  five: 5,
  lima: 5,
  limang: 5,
  ten: 10,
  sampu: 10,
  sampung: 10,
};
const NUMBER =
  '(?:-?\\d+(?:\\.\\d+)?|one|isa|isang|two|dalawa|dalawang|three|tatlo|tatlong|five|lima|limang|ten|sampu|sampung)';
const REPEATS = new RegExp(
  `(?<![\\w.-])(${NUMBER})\\s*(?:times?\\s*)?(?:round[ -]?trips?|laps?|ikot|balikan|one[ -]?way(?:\\s+trips?)?|trips?)\\b`,
  'i',
);
const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const fmt = (n: number, digits = 2) =>
  n.toLocaleString('en-PH', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function tripBudget(
  question: string,
  route: TripRoute | undefined,
  configured: Partial<TripBudgetInputs> = {},
  history: readonly string[] = [],
  priceBasis = 'configured diesel price; verify your pump receipt',
): TripBudget | null {
  if (!isTripBudgetQuestion(question, history)) return null;
  const clarify = (answer: string): TripBudget => ({ status: 'clarification', answer });
  if (
    !route ||
    !Number.isFinite(route.lengthKm) ||
    route.lengthKm <= 0 ||
    !Array.isArray(route.stops) ||
    route.stops.length < 2
  )
    return clarify(
      'I need the complete route and both endpoints to price the whole trip. The nearby-stop distance is not a round-trip distance. Reload the app to send the full route.',
    );
  if (
    route.stops.some(
      (s) =>
        !s ||
        typeof s.name !== 'string' ||
        !Array.isArray(s.aliases) ||
        s.aliases.some((a) => typeof a !== 'string') ||
        !Number.isFinite(s.km) ||
        s.km < 0 ||
        s.km > route.lengthKm,
    )
  )
    return clarify(
      'The full-route distances are invalid. Load a valid route before calculating trip costs.',
    );

  let count = 1;
  let kind: 'round-trip' | 'one-way' = 'round-trip';
  let ambiguous = false;
  let priceFromQuestion = false;
  let origin = route.stops.findIndex((s) => s.terminal);
  if (origin < 0) origin = 0;
  let destination = route.stops.findIndex((s, i) => i !== origin && s.terminal);
  if (destination < 0) destination = route.stops.length - 1;
  const inputs = { ...defaultBudgetInputs(0), ...configured };
  for (const q of [...history, question]) {
    if (/\b(one[ -]?way|isang direksyon)\b/i.test(q)) kind = 'one-way';
    else if (/\b(round[ -]?trips?|balikan|ikot|laps?)\b/i.test(q)) kind = 'round-trip';
    const repetitions = q.match(REPEATS);
    if (repetitions) {
      count = words[repetitions[1]!.toLowerCase()] ?? Number(repetitions[1]);
      ambiguous =
        !/round|lap|ikot|balikan|one[ -]?way/i.test(q) && !history.some((h) => WHOLE.test(h));
    }
    // Longest alias wins ("SM Tungko" must not also mean Tungko station).
    const matches = route.stops
      .flatMap((s, i) =>
        [s.name, ...s.aliases].flatMap((alias) => {
          const start = plain(q).indexOf(plain(alias));
          return start < 0 ? [] : [{ i, start, end: start + plain(alias).length }];
        }),
      )
      .sort((a, b) => a.start - b.start || b.end - a.end);
    const unique = matches.filter(
      (m, i) => !matches.slice(0, i).some((p) => p.start <= m.start && p.end >= m.end),
    );
    let matchedEndpoints = false;
    for (let i = 0; i + 1 < unique.length; i++) {
      const a = unique[i]!,
        b = unique[i + 1]!;
      if (
        a.i !== b.i &&
        /^(to|hanggang|papuntang|and|at|pabalik sa)$/.test(plain(q).slice(a.end, b.start).trim())
      ) {
        origin = a.i;
        destination = b.i;
        matchedEndpoints = true;
        break;
      }
    }
    if (
      !matchedEndpoints &&
      /\b(?:from|mula(?: sa)?|galing(?: sa)?)\s+[a-z].*\b(?:to|hanggang|papuntang)\b/i.test(q)
    )
      return clarify(
        `I could not match both requested endpoints to ${route.name}. Use the mapped stop names (SM Tungko is SM City San Jose del Monte). I will not replace an unknown trip with the driver's nearby stops.`,
      );
    const efficiency = q.match(/(-?\d+(?:\.\d+)?)\s*km\s*(?:\/|per)\s*(?:l\b|liters?|litres?)/i);
    if (efficiency) inputs.movingKmPerL = Number(efficiency[1]);
    const price =
      q.match(/(?:₱|php\s*|pesos?\s*)(-?\d+(?:\.\d+)?)\s*(?:\/|per)\s*(?:l\b|liters?|litres?)/i) ??
      q.match(/(-?\d+(?:\.\d+)?)\s*(?:pesos?|php)\s*(?:\/|per)\s*(?:l\b|liters?|litres?)/i);
    if (price) {
      inputs.dieselPhpPerL = Number(price[1]);
      priceFromQuestion = true;
    }
    const stops = q.match(/(\d+)\s*(?:stops|hinto)\s*(?:per|each|bawat)\s*(?:leg|way|biyahe)/i);
    if (stops) inputs.stopsPerLeg = Number(stops[1]);
    const wait = q.match(
      /(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?|minuto)\s*(?:of\s+)?(?:traffic|waiting|idle)(?:\s+(?:per|each)\s+(?:leg|way))?/i,
    );
    if (wait) inputs.trafficIdleMinutesPerLeg = Number(wait[1]);
  }
  if (ambiguous)
    return clarify(
      'Do you mean one-way trips or full round trips? One ikot/lap here means origin → destination → origin; 10 ikot means 20 one-way legs.',
    );
  if (!Number.isInteger(count) || count < 1 || count > 1000)
    return clarify(
      'Use a whole number of trips from 1 to 1,000. Specify one-way trips or round trips.',
    );
  const bounds: Record<Exclude<keyof TripBudgetInputs, 'stopsPerLeg'>, [number, number]> = {
    movingKmPerL: [0.1, 100],
    dieselPhpPerL: [0.01, 1000],
    idleLPerHour: [0, 20],
    startLitresPerStop: [0, 2],
    dwellSecondsPerStop: [0, 3600],
    trafficIdleMinutesPerLeg: [0, 1440],
    terminalIdleMinutesPerLeg: [0, 1440],
    otherCostsPhp: [0, 1000000],
  };
  for (const [key, [lo, hi]] of Object.entries(bounds)) {
    const value = inputs[key as keyof typeof bounds];
    if (!Number.isFinite(value) || value < lo || value > hi)
      return clarify(
        `Enter a valid ${key} (${lo}–${hi}) in Trip cost assumptions before estimating.`,
      );
  }
  if (
    inputs.stopsPerLeg !== null &&
    (!Number.isInteger(inputs.stopsPerLeg) || inputs.stopsPerLeg < 0 || inputs.stopsPerLeg > 1000)
  )
    return clarify('Stops per leg must be blank (mapped stops) or a whole number from 0 to 1,000.');

  const a = route.stops[origin]!,
    b = route.stops[destination]!;
  const ahead = (start: number, end: number) => (end - start + route.lengthKm) % route.lengthKm;
  const outward = route.loop ? ahead(a.km, b.km) : Math.abs(b.km - a.km);
  if (outward < 0.001) return clarify('Choose two different endpoints for the trip.');
  const inward = route.loop ? route.lengthKm - outward : outward;
  const mappedStops = (start: number, end: number, km: number) =>
    route.stops.filter((s) =>
      route.loop
        ? ahead(start, s.km) > 0.000001 && ahead(start, s.km) <= km + 0.000001
        : s.km !== start && s.km >= Math.min(start, end) && s.km <= Math.max(start, end),
    ).length;
  const leg = (from: typeof a, to: typeof a, km: number) => {
    const stops = inputs.stopsPerLeg ?? mappedStops(from.km, to.km, km);
    const drivingLitres = km / inputs.movingKmPerL;
    const startLitres = stops * inputs.startLitresPerStop;
    const idleMinutes =
      (stops * inputs.dwellSecondsPerStop) / 60 +
      inputs.trafficIdleMinutesPerLeg +
      inputs.terminalIdleMinutesPerLeg;
    const idleLitres = (idleMinutes / 60) * inputs.idleLPerHour;
    return {
      from: from.name,
      to: to.name,
      km,
      stops,
      drivingLitres,
      startLitres,
      idleMinutes,
      idleLitres,
      totalLitres: drivingLitres + startLitres + idleLitres,
    };
  };
  const legs = [leg(a, b, outward), ...(kind === 'round-trip' ? [leg(b, a, inward)] : [])];
  const sum = (
    key:
      | 'km'
      | 'stops'
      | 'drivingLitres'
      | 'startLitres'
      | 'idleMinutes'
      | 'idleLitres'
      | 'totalLitres',
  ) => legs.reduce((n, l) => n + l[key], 0) * count;
  const litres = sum('totalLitres'),
    fuelPhp = litres * inputs.dieselPhpPerL;
  const totals = {
    km: sum('km'),
    stops: sum('stops'),
    drivingLitres: sum('drivingLitres'),
    startLitres: sum('startLitres'),
    idleMinutes: sum('idleMinutes'),
    idleLitres: sum('idleLitres'),
    litres,
    fuelPhp,
    listedCostsPhp: fuelPhp + inputs.otherCostsPhp,
  };
  const taglish = /\b(bakit|magkano|kasi|yung|aking|gastos|balikan|ikot|paano|sampu|isang)\b/i.test(
    question,
  );
  const scope = `${count} ${kind === 'round-trip' ? 'round trips / ikot' : 'one-way trips'} (${count * legs.length} one-way legs)`;
  const answer =
    `${taglish ? 'Para sa' : 'For'} ${scope}: ${fmt(totals.km)} km; ${taglish ? 'tantiyang diesel' : 'estimated diesel'} ${fmt(litres)} L = ₱${fmt(fuelPhp)}.\n\n` +
    legs.map((l) => `${l.from} → ${l.to}: ${fmt(l.km)} km per leg, ${l.stops} stops.`).join('\n') +
    (kind === 'round-trip'
      ? `\nOne ikot = ${a.name} → ${b.name} → ${a.name}; ${fmt(outward + inward)} km. ${count} × this whole round trip, not the remaining distance from your jeepney.`
      : '') +
    `\n\nFor all ${count}: moving ${fmt(totals.drivingLitres)} L + stop/start ${fmt(totals.startLitres)} L + engine-on waiting ${fmt(totals.idleLitres)} L (${fmt(totals.idleMinutes, 1)} min) = ${fmt(litres)} L. × ₱${fmt(inputs.dieselPhpPerL)}/L = ₱${fmt(fuelPhp)}.` +
    `\n\nAssumptions: moving ${inputs.movingKmPerL} km/L under passenger load; ${inputs.startLitresPerStop} L/start (excludes idle); ${inputs.dwellSecondsPerStop}s boarding/drop-off dwell per stop; ${inputs.trafficIdleMinutesPerLeg} min traffic idle + ${inputs.terminalIdleMinutesPerLeg} min terminal idle per leg; idle ${inputs.idleLPerHour} L/hour. Price: ${priceFromQuestion ? 'your quoted price' : priceBasis}. Totals use unrounded distances and litres.` +
    `\nThese are adjustable planning inputs, not measured consumption or a prediction of future queues. Each repeated lap uses the same assumptions. If your km/L already includes traffic and idling, set extra idle/start allowances to zero to avoid double counting.` +
    (inputs.otherCostsPhp > 0
      ? `\nOther costs entered for the entire run: ₱${fmt(inputs.otherCostsPhp)}; listed total ₱${fmt(totals.listedCostsPhp)}.`
      : '\nFuel expense only. Boundary/rental, maintenance, tolls and meals are not included.') +
    '\nFare revenue and take-home profit need actual paid trips/fares and all other expenses; the current onboard count cannot tell us ten laps of earnings.' +
    (!route.loop
      ? '\nReturn distance assumes the same road in reverse; verify the actual return route.'
      : '');
  return { status: 'estimate', answer, count, kind, inputs, legs, totals };
}
