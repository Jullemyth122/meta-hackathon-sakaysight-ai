/** Narrate the same bounded arrival facts as the phone, including in offline/math mode. */
type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as RecordValue) : null;
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const label = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 160;
const arrivalQuestion =
  /approach|on (?:my|the|their) way|coming.*stop|arriv.*stop|reach.*stop|parating|paparating|tricycle|walking/i;
const pickupQuestion = /jeep|bus|uv|van|ride|seat|pickup|pick.up|sakay|sundo/i;

export function arrivalAdvice(question: string, role: unknown, input: unknown): string | null {
  if (!arrivalQuestion.test(question) && !(role === 'commuter' && pickupQuestion.test(question)))
    return null;
  const screen = record(input);
  if (!screen) return null;
  if (role === 'commuter') {
    const approach = record(screen.approachingStop);
    if (!approach || !number(approach.distanceM) || !number(approach.etaMin) || !label(screen.stop))
      return null;
    if (approach.mode !== 'walk' && approach.mode !== 'tricycle') return null;
    const pickup = label(screen.yourJeepney)
      ? `${screen.yourJeepney} is the current pickup estimate; seats are not reserved.`
      : 'No catchable jeepney with a seat is shown yet.';
    return `You are ${approach.mode === 'tricycle' ? 'travelling by tricycle' : 'walking'} to ${screen.stop}: ${approach.distanceM} m remaining, about ${approach.etaMin} min. ${pickup} These are simulation estimates.`;
  }
  if (role !== 'driver' || !Array.isArray(screen.nextStops)) return null;
  // A question naming another visible stop should use that stop, otherwise the next one.
  const stops = screen.nextStops
    .slice(0, 3)
    .map(record)
    .filter((s): s is RecordValue => !!s);
  const stop =
    stops.find((s) => label(s.name) && question.toLowerCase().includes(s.name.toLowerCase())) ??
    stops[0];
  if (!stop || !label(stop.name) || !number(stop.waiting) || !number(stop.approaching)) return null;
  const first = record(stop.firstArrival);
  const eta =
    first && number(first.etaMin) && number(first.distanceToStopM)
      ? ` First arrival in about ${first.etaMin} min, ${first.distanceToStopM} m from the stop${first.mode === 'tricycle' ? ' by tricycle' : ''}.`
      : '';
  const action = stop.action === 'stop' ? 'Stop' : stop.action === 'pass' ? 'Pass' : null;
  const decision =
    action && label(stop.reason)
      ? ` ${action}: ${stop.reason}. Recheck when you reach the stop.`
      : '';
  return `${stop.name}: ${stop.waiting} waiting now; ${stop.approaching} approaching within 500 m.${eta}${decision} Approaching riders have no reserved seats. These are simulation estimates.`;
}
