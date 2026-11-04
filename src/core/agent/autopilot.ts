/**
 * Automatic AI: what is worth saying without being asked, to a driver with
 * eyes on the road, or a commuter with theirs on their phone. The moments are
 * found here, by rule, so it only speaks when something has changed; Muse then
 * says it in plain Taglish (net/agent.ts), and these words are spoken as they
 * are if Muse cannot be reached.
 */

import type { CommuterView } from '../advisory/commuter';
import type { DriverView } from '../advisory/driver';
import type { HandOver, LateRiders, SeatsAtStop, TrafficAhead, VehiclesAhead } from './road';

export interface Notice {
  /** The same key is not said twice in a row of NOTICE_AGAIN_MS. */
  key: string;
  text: string;
  /**
   * Done as it is said, not only said: resolves to the words for what was
   * done, or null if it could not be done after all (then nothing is said).
   */
  act?: () => Promise<string | null>;
}

export interface Moment {
  view: DriverView;
  traffic: TrafficAhead;
  ahead: VehiclesAhead;
  seats: SeatsAtStop[];
  late: LateRiders[];
  /** Share of the tank left, 0 to 1. */
  tank: number;
  /** Passing the riders on to the jeepney behind and going back for a crowd (handOver). */
  handOver?: HandOver;
}

/** A ride this close is worth a word (seconds). */
const RIDE_SOON_S = 180;
/** A rider is told to get ready this long before their stop (seconds). */
const WAKE_BEFORE_S = 180;
/** Below this share of the tank, say so. */
const LOW_TANK = 0.25;
/** The next stop is worth a word this close (metres). */
const STOP_SOON_M = 400;
/** Riders few enough to pass on to the jeepney behind, without being asked. */
const FEW_RIDERS = 5;
/** That jeepney is right behind: they switch over at once (metres). */
const RIGHT_BEHIND_M = 150;

/** Most important first: the first one not said lately is what gets said. */
export function noticesFor({
  view,
  traffic,
  ahead,
  seats,
  late,
  tank,
  handOver,
}: Moment): Notice[] {
  const out: Notice[] = [];
  // A few riders, a jeepney with seats right behind, a crowd nobody is coming
  // for across the road: pass them on and go back, before the stop is passed.
  if (
    handOver?.possible &&
    handOver.riders! <= FEW_RIDERS &&
    handOver.nextVehicle!.metresBehind <= RIGHT_BEHIND_M &&
    handOver.gainPhp! > 0
  )
    out.push({
      key: 'hand-over',
      text: `Your ${handOver.riders} riders can switch to ${handOver.nextVehicle!.plate} right behind, and you go back for the ${handOver.crowd!.waiting} waiting at ${handOver.crowd!.stop}. Pay that driver ₱${handOver.payNextDriverPhp}, you gain ₱${handOver.gainPhp}.`,
    });
  if (traffic.level === 'heavy')
    out.push({
      key: 'traffic',
      text: `Heavy traffic ahead, about ${traffic.extraMin} minutes longer than usual, ${traffic.stuckAhead} vehicles stuck ahead.`,
    });
  const flagging = view.roadside[0];
  if (flagging && flagging.canTake && flagging.distanceM < STOP_SOON_M)
    out.push({
      key: `roadside:${flagging.passenger}`,
      text: `Someone is waiting by the road ${Math.round(flagging.distanceM)} metres ahead, not at a stop. Pull over for them.`,
    });
  const next = view.ahead[0];
  const firstSeats = seats[0];
  if (next && firstSeats && !firstSeats.enough && next.distanceM < STOP_SOON_M)
    out.push({
      key: `seats:${next.stop}`,
      text: `${next.name}: ${firstSeats.waiting + firstSeats.approaching} want a seat, you will have ${firstSeats.freeOnArrival} free.`,
    });
  const lateNext = late[0];
  if (next && lateNext && lateNext.count > 0 && next.distanceM < STOP_SOON_M)
    out.push({
      key: `late:${next.stop}`,
      text: `${lateNext.count} coming to ${next.name} about ${lateNext.soonestLateMin} minutes after you pass. Your call.`,
    });
  if (next && next.distanceM < STOP_SOON_M && (next.action === 'stop' || next.forYou === 0))
    out.push({
      key: `stop:${next.stop}:${next.action}`,
      text: `${next.name}: ${next.action === 'stop' ? 'stop' : 'pass'}, ${next.reason}.`,
    });
  if (ahead.advice === 'hold_back' && ahead.count >= 2)
    out.push({
      key: 'hold-back',
      text: `${ahead.count} vehicles ahead will take the ${ahead.waitingAhead} waiting. You could drop back.`,
    });
  if (tank < LOW_TANK)
    out.push({ key: 'fuel', text: `Diesel is down to ${Math.round(tank * 100)} percent.` });
  return out;
}

const inMinutes = (s: number) => Math.max(1, Math.round(s / 60));

/** A commuter's moments, most important first. */
export function riderNotices(view: CommuterView): Notice[] {
  const out: Notice[] = [];
  const { arrivals, destination, phase, pickup, riding, roadside, stop } = view;
  if (riding) {
    // In time to wake up and get to the back: close, or a few minutes off.
    if (riding.remainingM < STOP_SOON_M || riding.etaS < WAKE_BEFORE_S)
      out.push({
        key: `off:${destination.index}`,
        text: `${destination.name} is about ${inMinutes(riding.etaS)} minutes away. Get ready to get off.`,
      });
    return out;
  }
  if (phase !== 'approaching' && phase !== 'waiting') return out;
  const place = roadside ? 'your spot' : stop.name;
  const missed = arrivals.find((a) => !a.catchable && a.etaS < RIDE_SOON_S);
  if (missed)
    out.push({
      key: `missed:${missed.plate}`,
      text: `${missed.plate} passes ${place} before you get there.`,
    });
  const first = arrivals[0];
  if (first && first.catchable && first.seatsForYou <= 0 && first.etaS < RIDE_SOON_S)
    out.push({
      key: `full:${first.plate}`,
      text: `${first.plate} is coming, but it has no seat for you.`,
    });
  if (pickup && pickup.catchable && pickup.etaS < RIDE_SOON_S)
    out.push({
      key: `pickup:${pickup.plate}`,
      text: `${pickup.plate} reaches ${place} in about ${inMinutes(pickup.etaS)} minutes, with a seat for you.`,
    });
  if (phase === 'waiting' && !pickup)
    out.push({ key: 'no-seat', text: 'Nothing in sight has a seat for you yet.' });
  return out;
}

const numbersIn = (text: string) => text.replace(/,/g, '').match(/\d+(\.\d+)?/g) ?? [];

/** Whether `said` keeps to the numbers in `facts`: Muse must not bring in any of its own. */
export function onlyItsNumbers(facts: string, said: string): boolean {
  const known = new Set(numbersIn(facts));
  return numbersIn(said).every((n) => known.has(n));
}
