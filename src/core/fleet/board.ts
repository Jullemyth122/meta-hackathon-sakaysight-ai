/**
 * The fleet board: how one driver's Muse knows what another's is about to do.
 *
 * Muse takes a while to answer. Two drivers in the same jam who ask at the
 * same time would both be told the eight riders on the side street are
 * theirs, and both race for them (agawan). So the moment a driver's ways are
 * weighed, the riders the best one picks up by its side streets are held
 * for that driver, on one board the whole fleet reads:
 *
 * - Asked first, held first. Someone held for one driver is not counted for
 *   another, and a way round held by as many as may take it is full.
 * - A hold lasts a minute at most (HOLD_MS), long enough for Muse to answer
 *   and the driver to say yes. Taking the way confirms it (the vehicle on its
 *   way down the street then has them); staying on the route, or the minute
 *   passing, lets them go for the next driver to ask.
 * - Only as many as the driver has seats are held: the rest stay free.
 *
 * Nobody bargains with anybody: the board settles it in the order drivers
 * asked, without a word from Muse, so it costs no more AI. In the simulation
 * the board lives with the twin; on the road it would live where the phones
 * already share their places (the live map's database).
 */

/** How long riders stay held for the driver who asked (ms of real time: Muse's answer). */
export const HOLD_MS = 60_000;

export interface Hold {
  /** The vehicle holding them, and its plate, said to the next driver. */
  vehicle: number;
  plate: string;
  /** Who is held: passenger ids, by the way's side streets. */
  riders: ReadonlySet<number>;
  /** The way round held, by where it leaves and rejoins the route; null staying on it. */
  enterS: number | null;
  exitS: number | null;
  /** When it was asked, and until when it holds (performance.now(), ms). */
  askedAt: number;
  until: number;
}

export class FleetBoard {
  private holds = new Map<number, Hold>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Riders held for `vehicle` on its way, replacing whatever it held before. */
  hold(h: Omit<Hold, 'askedAt' | 'until'>, forMs = HOLD_MS): Hold {
    const t = this.now();
    const held: Hold = { ...h, riders: new Set(h.riders), askedAt: t, until: t + forMs };
    this.holds.set(h.vehicle, held);
    return held;
  }

  /** The vehicle took its way (or stayed on the route): its hold is done. */
  release(vehicle: number): void {
    this.holds.delete(vehicle);
  }

  /** Holds still standing, but `except`'s own, oldest (asked first) first. */
  standing(except?: number): Hold[] {
    const t = this.now();
    for (const [k, h] of this.holds) if (h.until <= t) this.holds.delete(k);
    return [...this.holds.values()]
      .filter((h) => h.vehicle !== except)
      .sort((a, b) => a.askedAt - b.askedAt);
  }

  /** Whom `rider` is held for, if anyone but `except`. */
  heldFor(rider: number, except?: number): Hold | undefined {
    return this.standing(except).find((h) => h.riders.has(rider));
  }

  /** How many others hold the way round from `enterS` to `exitS` (within `nearM` of its ends). */
  onTheWay(enterS: number, exitS: number, except: number, nearM: number): Hold[] {
    return this.standing(except).filter(
      (h) =>
        h.enterS !== null &&
        h.exitS !== null &&
        Math.abs(h.enterS - enterS) < nearM &&
        Math.abs(h.exitS - exitS) < nearM,
    );
  }

  /** This vehicle's own hold, while it stands. */
  of(vehicle: number): Hold | undefined {
    return this.standing().find((h) => h.vehicle === vehicle);
  }
}
