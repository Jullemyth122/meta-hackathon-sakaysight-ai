/**
 * The demo: moments of the day made ready, for a driver or a commuter. Pick
 * one and the twin is rebuilt at that time, with those vehicles where they
 * are, those riders on board and at the stops, and the line to say on the mic
 * in the Ask box. Nothing here is scripted past that: the simulation runs on
 * from there, and Muse answers from its tools as it would anywhere else.
 *
 * All on the route the app opens on. A scene is not the live map: it plays on
 * a twin of its own, while the live map's day is put aside, untouched, and
 * comes back as it was (store.ts DEMO_BORROWS, App.tsx). Real phones stay
 * with the live map. Vehicle 0 is the one the scene is about.
 */

import { FIELD_SCENARIO, OWNER_SHARE, type SimulationScenario } from '@/core/fleet/scenario';
import type { RiderKind } from '@/core/fare';
import { defaultRoute, stopsAhead, type Route } from '@/core/geo/routes';
import type { LocalPoint } from '@/core/geo/projection';
import { roadsidePoint } from '@/core/people/stopLayout';
import type { Zebra } from '@/core/people/zebra';
import type { FleetKind } from '@/core/vehicles/specs';
import { openTab } from '@/ui/Tabs';
import { stageWays, streetRiders, warmShortcut } from './agentTools';
import { aroundSpot } from './locate';
import { getNetwork, loadNetwork } from './network';
import { autoKey, useApp } from './store';
import { knownStreets } from './streets';
import type { FleetStart, TwinRuntime } from './twinRuntime';

export type SceneSide = 'driver' | 'commuter';

/** Vehicles round the rest of the route, besides the scene's own. */
const BACKGROUND_VEHICLES = 18;
/** Riders a day: a few turn up on their own, the stops that matter are staged. */
const SCENE_TRIPS = 1500;
/** The other vehicles keep this clear of the ones in the scene (metres). */
const CLEAR_OF_CAST_M = 500;
const BACKGROUND_RIDERS = 7;
const FULL_TANK = 0.9;
/** Stops ahead of vehicle 0 left to the scene: nobody there unless it says so. */
const QUIET_STOPS = 5;

// The route's stops, outbound to Fairview and back (see core/geo/routes.ts).
const TUNGKO = 0;
const SAMPAGUITA = 3;
const MALARIA = 4;
const MOUNTAIN_VIEW = 5;
const AMPARO = 6;
const DELA_COSTA = 7;
const MATER_CARMELI = 8;
const LAGRO = 10;
const FAIRVIEW = 11;
/** In "Spread the fleet", the one jeepney in the jam with seats, ahead of the students. */
const SEATS_AHEAD = 13;
/** Fairview–Quiapo's stops on España and Quezon Avenue (Manila, Quezon City). */
const ESPANA_OSMENA = 6;
const RS_CRISTOBAL = 9;
const YOUTH_COMMISSION = 16;
const MRT_QUEZON_AVENUE = 35;
/** In "Rush hour on España", the one jeepney in the jam with seats, ahead of the students. */
const ESPANA_SEATS_AHEAD = 16;
const BACK_AMPARO = 20;
/** FAIRVIEW - QUIAPO (Quezon City to Quiapo, a 39 km loop): stop 0 is Quezon Blvd, Quiapo. */
const FAIRVIEW_QUIAPO = 'puj1940';
/** Cubao – Proj. 4 via P. Tuazon, and two of its stops: 20th Ave / D. Silang, by Cubao, and Quirino Memorial Medical Center. */
const CUBAO_PROJECT_4 = 'puj1228';
const D_SILANG = 2;
const QUIRINO_MEMORIAL = 9;

interface SceneVehicle {
  plate: string;
  /** Metres short of this stop. */
  before: [stop: number, metres: number];
  kind?: FleetKind;
}

/** Traffic you can see: `count` vehicles nose to tail, from `fromM` to `toM` short of `stop`. */
function queue(stop: number, fromM: number, toM: number, count: number): SceneVehicle[] {
  return Array.from({ length: count }, (_, i) => ({
    plate: `TRF ${2100 + 73 * i}`,
    before: [stop, fromM - ((fromM - toM) * i) / (count - 1)],
    kind: i % 6 === 5 ? 'modern' : 'jeepney',
  }));
}

export interface DemoScene {
  id: string;
  side: SceneSide;
  title: string;
  /** What it shows, for whoever is presenting. */
  shows: string;
  /** Why someone would need this in real life (a commuter's scene). */
  why?: string;
  /** Who it is for: new to the city or the area, or daily commuters who know their route (sanay na). */
  who?: string;
  /** The line to say on the mic, in Taglish, and in English. */
  say: string;
  sayEn: string;
  /** The time it happens, 24-hour. */
  at: string;
  vehicles: SceneVehicle[];
  /** Sets the moment up. Returns the rider a commuter scene follows. */
  stage(s: Stage): number | void;
  /** The tab it opens on; else Ask. */
  tab?: 'now' | 'trip';
  /** Automatic AI on from the start: the scene is Muse speaking up by itself. */
  auto?: boolean;
  /**
   * The view: a driver's is from behind their vehicle, a commuter's on them.
   * `pov` from the driver's seat, `behind` from behind the vehicle they ride,
   * `wide` from above where they are.
   */
  camera?: 'pov' | 'behind' | 'wide';
  /** A picture sent with the line. */
  photo?: string;
  /** Only its own vehicles on the road: none round the rest of the route, nor other routes'. */
  quiet?: boolean;
  /** How fast it plays (SPEEDS): a long wait passes quickly. Real time when not given. */
  speed?: number;
  /** The network route it plays on (its id), when not the one every other scene is on. */
  route?: string;
}

/** What a scene can set up, on the twin it was built with. */
export class Stage {
  readonly route: Route;
  constructor(readonly twin: TwinRuntime) {
    this.route = twin.route;
  }

  /** The stop furthest on that `vehicle` calls at before its next terminal. */
  private lastStop(vehicle: number): number {
    const v = this.twin.fleet.vehicles[vehicle]!;
    return stopsAhead(this.route, v.nextStop, v.direction).at(-1) ?? v.nextStop;
  }

  /** On board `vehicle`: `off` riders getting off at each stop given, the rest ride on. */
  seat(vehicle: number, riders: number, off: Array<[stop: number, count: number]> = []): number[] {
    const stops = off.flatMap(([stop, count]) => Array<number>(count).fill(stop));
    const far = this.lastStop(vehicle);
    while (stops.length < riders) stops.push(far);
    return this.twin.crew.seatRiders(vehicle, stops);
  }

  /** As full as `vehicle` gets, less `free` places. */
  fill(vehicle: number, free = 0): void {
    const v = this.twin.fleet.vehicles[vehicle]!;
    this.seat(vehicle, v.capacity - free);
  }

  waiting(stop: number, count: number, kinds: readonly RiderKind[] = []): void {
    this.twin.crew.setWaiting(
      stop,
      Array.from({ length: count }, (_, i) => kinds[i]),
    );
  }

  /**
   * Someone on their way to `stop`, this far from it: in by the side streets
   * (out of the driver's sight), or `alongRoad`, on the pavement in sight of it.
   */
  coming(
    stop: number,
    metres: number,
    mode: 'walk' | 'tricycle' = 'walk',
    alongRoad = false,
  ): void {
    this.twin.crew.join(stop, this.lastFrom(stop), metres, mode, { alongRoad });
  }

  private lastFrom(stop: number): number {
    return stopsAhead(this.route, stop, 1).at(-1) ?? stop;
  }

  /** "You", at `stop` (or this far from it), going to `to`. */
  me(stop: number, to: number, opts: { metres?: number; kind?: RiderKind } = {}): number {
    return this.twin.crew.join(stop, to, opts.metres ?? 0, 'walk', {
      kind: opts.kind ?? 'regular',
    });
  }

  /** "You", on board `vehicle` with `others`, getting off at `to`. */
  aboard(vehicle: number, to: number, others: number, kind: RiderKind = 'regular'): number {
    const far = this.lastStop(vehicle);
    const stops = [to, ...Array<number>(others).fill(far)];
    return this.twin.crew.seatRiders(vehicle, stops, kind)[0]!;
  }

  /** Where `stop` is. */
  at(stop: number): LocalPoint {
    return this.route.polyline.pointAt(this.route.stops[stop]!.s);
  }

  /** Someone waving by the road, `metres` short of `stop`, going to `to`. */
  flagging(stop: number, metres: number, to: number, kind: RiderKind = 'regular'): number {
    const flagS = this.route.stops[stop]!.s - metres;
    return this.twin.crew.join(stop, to, 0, 'walk', {
      kind,
      flagS,
      flagAt: roadsidePoint(this.route, flagS, 1),
    });
  }

  /** The road crawling at `mps`, starting `fromM` ahead of vehicle 0, for `lengthM`. */
  jam(fromM: number, lengthM: number, mps: number): void {
    const v = this.twin.fleet.vehicles[0]!;
    this.twin.fleet.addSlowZone(v.s + fromM, lengthM, 1800, mps);
  }

  /** Vehicle 0 stops at `stop` and stands there `seconds` while its driver decides (and riders come). */
  pause(stop: number, seconds: number): void {
    this.twin.fleet.waitFor(0, stop, seconds);
  }

  /** Share of the tank left in `vehicle`. */
  tank(vehicle: number, share: number): void {
    const v = this.twin.fleet.vehicles[vehicle]!;
    v.tankL = v.tankCapacityL * share;
  }

  /** This vehicle's day so far. */
  ledger(vehicle: number, day: { fares: number; km: number; idleMin: number; riders: number }) {
    const today = this.twin.fleet.vehicles[vehicle]!.day;
    today.fareCentavos = day.fares * 100;
    today.metres = day.km * 1000;
    today.idleS = day.idleMin * 60;
    today.riders = day.riders;
    today.owner = false;
  }

  /** Where a trip being planned starts and ends. */
  trip(from: number | null, to: number | null): void {
    const app = useApp.getState();
    const end = (stop: number) => ({ name: this.route.stops[stop]!.name, at: this.at(stop) });
    if (from !== null) app.setTripEnd('home', end(from));
    if (to !== null) app.setTripEnd('to', end(to));
  }
}

const DRIVER: DemoScene[] = [
  {
    id: 'stop-or-pass',
    side: 'driver',
    title: 'Modern jeepney: stop or pass?',
    shows:
      'A modern jeepney. Riders who use the app say where they wait and where they get off: Muse tells the driver whether the next stop is worth stopping at.',
    say: 'Titigil ba ako sa susunod na stop?',
    sayEn: 'Should I stop at the next stop?',
    at: '07:10',
    vehicles: [{ plate: 'NBC 4721', before: [MALARIA, 200], kind: 'modern' }],
    stage: (s) => {
      s.seat(0, 11, [[MALARIA, 2]]);
      s.waiting(MALARIA, 6);
    },
  },
  {
    id: 'empty-stop',
    side: 'driver',
    title: 'Bus: nobody at the next stop',
    shows:
      'A city bus. Nobody waiting and nobody getting off: pass, and save the diesel a big bus burns stopping and starting.',
    say: 'May dapat ba akong hintuan sa susunod na stop?',
    sayEn: 'Do I need to stop at the next stop?',
    at: '10:35',
    vehicles: [{ plate: 'NEQ 2086', before: [SAMPAGUITA, 300], kind: 'bus' }],
    stage: (s) => void s.seat(0, 24),
    tab: 'now',
    camera: 'pov',
  },
  {
    id: 'which-way-pays',
    side: 'driver',
    title: 'Which way pays?',
    shows:
      'Jammed past Sampaguita, 10 seats free. Six students wait by the road before Malaria, going one stop; eight wait on a side street, going all the way to SM Fairview. Ask, and Muse draws the ways on the map (public streets only, never through a gated subdivision), puts fares, diesel and minutes on each, and drives the one that nets the most.',
    say: 'Traffic sa unahan. Diretso o dadaan sa gilid? Ikumpara mo kung saan ako mas kikita, kasama na ang diesel.',
    sayEn:
      'Traffic ahead. Straight on or round the side streets? Compare which way earns me more, diesel included.',
    at: '17:40',
    vehicles: [
      { plate: 'WAY 3150', before: [SAMPAGUITA, 150], kind: 'jeepney' },
      ...queue(SAMPAGUITA, 128, -560, 28),
    ],
    stage: (s) => {
      s.seat(0, 14, [[MOUNTAIN_VIEW, 3]]);
      // Everyone ahead in the jam is full: whoever waits is this driver's to take.
      for (let i = 1; i <= 28; i++) s.fill(i);
      s.jam(-60, 900, 1.2);
      // Six students by the road before Malaria, home a stop away (the
      // discounted fare); eight by the longer way round, the long ride to SM Fairview.
      for (let k = 0; k < 6; k++) s.flagging(MALARIA, 30, MOUNTAIN_VIEW, 'student');
      void streetRiders(s.twin, 0, [
        { at: 0.45, count: 4, to: FAIRVIEW },
        { at: 0.7, count: 4, to: FAIRVIEW },
      ]);
    },
  },
  {
    id: 'spread-the-fleet',
    side: 'driver',
    title: 'Spread the fleet',
    shows:
      'The same jam, three jeepneys. The one just ahead asked first and took the side street where eight wait; one further on with seats will pick up the six students. First come, first served: Muse does not send this driver after riders already taken, nor onto a street already full, but round the other street, where three wait, so the fleet spreads out.',
    say: 'Traffic pa rin. Saan ako dadaan na kikita pa rin, kahit may ibang jeep na nauna?',
    sayEn: 'Still traffic. Which way still pays for me, with other jeepneys ahead of me?',
    at: '17:40',
    vehicles: [
      { plate: 'FLT 2201', before: [SAMPAGUITA, 150], kind: 'jeepney' },
      { plate: 'FST 1180', before: [SAMPAGUITA, 135], kind: 'jeepney' },
      ...queue(SAMPAGUITA, 115, -560, 27),
    ],
    stage: (s) => {
      s.seat(0, 14, [[MOUNTAIN_VIEW, 3]]);
      // The one just ahead: seats for the eight on its side street.
      s.seat(1, 12);
      // The jam full, but for one jeepney further on with seats: the students' ride.
      for (let i = 2; i <= 28; i++) if (i !== SEATS_AHEAD) s.fill(i);
      s.seat(SEATS_AHEAD, 12);
      s.jam(-60, 900, 1.2);
      for (let k = 0; k < 6; k++) s.flagging(MALARIA, 30, MOUNTAIN_VIEW, 'student');
      // Eight by the longer way round, which the one ahead takes; three by the shorter.
      void stageWays(
        s.twin,
        0,
        [
          [
            { at: 0.45, count: 4, to: FAIRVIEW },
            { at: 0.7, count: 4, to: FAIRVIEW },
          ],
          [{ at: 0.5, count: 3, to: FAIRVIEW }],
        ],
        { vehicle: 1, way: 0 },
      );
    },
  },
  {
    id: 'espana-rush',
    side: 'driver',
    title: 'Rush hour on España',
    route: FAIRVIEW_QUIAPO,
    shows:
      'Manila, España Boulevard by UST at 5:40 PM, Quiapo to Fairview, jammed to Quezon Avenue. The jeepney just ahead took the street through Sampaloc where eleven wait for MRT Quezon Avenue, but it has seats for eight; one further on picks up the UST students. First come, first served, as far as the seats go: Muse sends this driver after it for the three it cannot take, not down an empty street.',
    say: 'Traffic sa España. Saan ako dadaan na kikita, may nauna nang jeep sa shortcut?',
    sayEn: 'Traffic on España. Which way pays, with a jeepney already on the shortcut?',
    at: '17:40',
    vehicles: [
      { plate: 'ESP 1611', before: [ESPANA_OSMENA, 160], kind: 'jeepney' },
      { plate: 'UST 2045', before: [ESPANA_OSMENA, 145], kind: 'jeepney' },
      ...queue(ESPANA_OSMENA, 125, -1200, 34),
    ],
    stage: (s) => {
      s.seat(0, 14);
      // The one ahead: seats for the eight by its street, no more.
      s.seat(1, 16);
      for (let i = 2; i <= 35; i++) if (i !== ESPANA_SEATS_AHEAD) s.fill(i);
      s.seat(ESPANA_SEATS_AHEAD, 12);
      s.jam(-60, 1500, 1.2);
      // UST students home along Quezon Avenue, a short ride.
      for (let k = 0; k < 6; k++) s.flagging(RS_CRISTOBAL, 20, YOUTH_COMMISSION, 'student');
      // Eight by the longer street through Sampaloc, which the one ahead takes;
      // three by the other. Both going to MRT-3 Quezon Avenue.
      void stageWays(
        s.twin,
        0,
        [
          [
            { at: 0.4, count: 4, to: MRT_QUEZON_AVENUE },
            { at: 0.65, count: 4, to: MRT_QUEZON_AVENUE },
          ],
          [{ at: 0.85, count: 3, to: MRT_QUEZON_AVENUE }],
        ],
        { vehicle: 1, way: 0 },
      );
    },
  },
  {
    id: 'jam-shortcut',
    side: 'driver',
    title: 'Jam ahead, a way round?',
    shows:
      'Crawling in a packed road. Ask, and Muse reroutes the jeepney onto the street alongside it, back on the road before Mountain View.',
    say: 'May traffic ba sa unahan? May shortcut ba?',
    sayEn: 'Is there traffic ahead? Is there a shortcut?',
    at: '17:40',
    vehicles: [
      { plate: 'TYK 5530', before: [MOUNTAIN_VIEW, 1365] },
      ...queue(MOUNTAIN_VIEW, 1342, 775, 28),
    ],
    stage: (s) => {
      s.seat(0, 14, [[MOUNTAIN_VIEW, 3]]);
      s.jam(-60, 680, 1.2);
      s.waiting(MOUNTAIN_VIEW, 4);
      warmShortcut(s.twin, 0);
    },
  },
  {
    id: 'late-riders',
    side: 'driver',
    title: 'Riders running late',
    shows:
      'Pulled in at Sampaguita, people on their way one to three minutes off. Ask, and the jeepney waits at the stop for those who make it within two minutes, taking each on as they come, then goes.',
    say: 'May humahabol ba sa akin? Hihintayin ko ba sila?',
    sayEn: 'Is anyone running to catch me? Should I wait for them?',
    at: '07:40',
    vehicles: [{ plate: 'DKP 6218', before: [SAMPAGUITA, 40] }],
    stage: (s) => {
      s.seat(0, 10);
      // The driver pulls in at the stop and asks: time to ask, before the wait itself.
      s.pause(SAMPAGUITA, 45);
      s.waiting(SAMPAGUITA, 1);
      // Two a minute or so off, who make it; one over three minutes off, who does not.
      s.coming(SAMPAGUITA, 60);
      s.coming(SAMPAGUITA, 85);
      s.coming(SAMPAGUITA, 320);
      s.coming(SAMPAGUITA, 420, 'tricycle');
    },
  },
  {
    id: 'not-enough-seats',
    side: 'driver',
    title: 'Not enough seats',
    shows: 'Nine waiting at the stop and two seats left: Muse says how many it cannot take.',
    say: 'Kasya ba ang upuan ko sa susunod na stop?',
    sayEn: 'Do I have enough seats for the next stop?',
    at: '18:05',
    vehicles: [
      { plate: 'HZM 7043', before: [MATER_CARMELI, 200] },
      { plate: 'JLR 2295', before: [MATER_CARMELI, 520] },
    ],
    stage: (s) => {
      s.fill(0, 2);
      s.seat(1, 6);
      s.waiting(MATER_CARMELI, 9);
    },
  },
  {
    id: 'bunching',
    side: 'driver',
    title: 'Buses bunched together',
    shows:
      'Three buses nose to tail: the two in front, half empty, take every rider ahead. Muse says to drop back and spread out, not race them.',
    say: 'Dapat ko bang lampasan ang mga sasakyan sa unahan?',
    sayEn: 'Should I overtake the vehicles ahead?',
    at: '10:20',
    vehicles: [
      { plate: 'VBS 3081', before: [MOUNTAIN_VIEW, 700], kind: 'bus' },
      { plate: 'KTG 8126', before: [MOUNTAIN_VIEW, 570], kind: 'bus' },
      { plate: 'MPL 4459', before: [MOUNTAIN_VIEW, 420], kind: 'bus' },
    ],
    stage: (s) => {
      s.seat(0, 30);
      s.seat(1, 26);
      s.seat(2, 28);
      s.waiting(MOUNTAIN_VIEW, 5);
    },
  },
  {
    id: 'low-diesel',
    side: 'driver',
    title: 'Bus low on diesel',
    shows:
      'A bus with twelve percent in the tank: the stations ahead on its side, with DOE prices, and where to fill.',
    say: 'Saan ang pinakamurang diesel sa unahan?',
    sayEn: 'Where is the cheapest diesel ahead?',
    at: '13:15',
    vehicles: [{ plate: 'FUE 1290', before: [DELA_COSTA, 760], kind: 'bus' }],
    stage: (s) => {
      s.seat(0, 32);
      s.tank(0, 0.12);
    },
  },
  {
    id: 'roadside',
    side: 'driver',
    title: 'Someone waving by the road',
    shows: 'Automatic AI speaks by itself: a rider is flagging down, not at a stop. Pull over.',
    say: 'Ano ang susunod kong gagawin?',
    sayEn: 'What should I do next?',
    at: '09:15',
    vehicles: [{ plate: 'CAW 7714', before: [MOUNTAIN_VIEW, 900] }],
    stage: (s) => {
      s.seat(0, 9);
      s.flagging(MOUNTAIN_VIEW, 620, LAGRO);
    },
    tab: 'now',
    auto: true,
  },
  {
    id: 'leave-or-wait',
    side: 'driver',
    title: 'UV Express: alis na o hintay?',
    shows:
      'A UV Express at the terminal fills up before it goes: twelve on, two seats left, more on their way. The fares of who is coming against the minutes of waiting, in pesos.',
    say: 'Alis na ba ako o hintay pa?',
    sayEn: 'Should I leave now or wait?',
    at: '06:50',
    vehicles: [
      { plate: 'TRM 5067', before: [TUNGKO, 25], kind: 'uv' },
      { plate: 'YXD 8831', before: [TUNGKO, 75], kind: 'uv' },
    ],
    stage: (s) => {
      s.waiting(TUNGKO, 12);
      for (const m of [90, 130, 170, 210, 250]) s.coming(TUNGKO, m);
    },
  },
  {
    id: 'boundary',
    side: 'driver',
    title: 'UV Express: how far to the boundary?',
    shows:
      'A UV Express driver on boundary: what is left to cover today, and how many trips that takes, spoken, so they never look down at numbers.',
    say: 'Magkano pa bago ma-boundary? Ilang ikot pa?',
    sayEn: 'How much more until I make the boundary? How many laps?',
    at: '14:30',
    vehicles: [{ plate: 'BDY 3058', before: [MOUNTAIN_VIEW, 500], kind: 'uv' }],
    stage: (s) => {
      s.seat(0, 10);
      s.ledger(0, { fares: 1480, km: 62, idleMin: 115, riders: 96 });
    },
  },
  {
    id: 'pass-riders-on',
    side: 'driver',
    title: 'Pass riders on, go back',
    shows:
      'Three riders left, a jeepney with seats right behind you, and eight waiting at Dela Costa across the road with no jeepney coming for them. Muse has your three switch to the one behind at Amparo, and you U-turn for the eight. Turn on Automatic AI and it does it by itself.',
    say: 'Ipapasa ko na ba ang pasahero ko sa kasunod para mabalikan ang mga naghihintay?',
    sayEn: 'Should I pass my riders to the jeepney behind and go back for the ones waiting?',
    at: '15:20',
    vehicles: [
      { plate: 'LPT 6604', before: [BACK_AMPARO, 350] },
      { plate: 'SNA 2178', before: [BACK_AMPARO, 385] },
      { plate: 'TJM 3390', before: [BACK_AMPARO, -250] },
    ],
    quiet: true,
    stage: (s) => {
      s.seat(0, 3);
      s.seat(1, 18);
      s.seat(2, 14);
      // Nobody at Amparo across the road: the crowd is one stop on, out of anyone's reach.
      s.waiting(AMPARO, 0);
      s.waiting(DELA_COSTA, 8);
    },
  },
  {
    id: 'diesel-plan',
    side: 'driver',
    title: 'Diesel plan, Fairview to Quiapo',
    shows:
      'Fairview – Quiapo, 39 km a round, 20 riders on board and a quarter of a tank. A Shell is just ahead and a Petron after it. Muse plans the three rounds left: past them to the Flying V, ₱5 a litre cheaper, only the litres needed, and the saving. The jeepney turns in where Muse says.',
    say: 'Saan ako magpapakarga ng diesel para makatipid? Tatlong ikot pa ako, Fairview–Quiapo.',
    sayEn:
      'Where should I fill up to save on diesel? I have three more rounds, Fairview to Quiapo.',
    at: '14:10',
    route: FAIRVIEW_QUIAPO,
    // On Commonwealth Avenue southbound, 13.2 km short of Quiapo: the Shell
    // just ahead, the Petron and the Flying V a couple of kilometres on.
    vehicles: [{ plate: 'FVQ 2471', before: [0, 13200] }],
    quiet: true,
    stage: (s) => {
      s.seat(0, 20);
      // Above what sends a driver to the next station by itself: Muse decides where.
      s.tank(0, 0.27);
    },
  },
  {
    id: 'bus-keeps-stops',
    side: 'driver',
    title: 'A bus keeps to its stops',
    shows: 'Someone waves by the road: a bus does not pull over, unlike a jeepney.',
    say: 'May pumapara sa gilid ng kalsada, hihinto ba ako?',
    sayEn: 'Someone is waving by the road. Should I stop?',
    at: '11:05',
    vehicles: [{ plate: 'BUS 8450', before: [MOUNTAIN_VIEW, 980], kind: 'bus' }],
    stage: (s) => {
      s.seat(0, 26);
      s.flagging(MOUNTAIN_VIEW, 620, LAGRO);
      s.waiting(MOUNTAIN_VIEW, 4);
    },
  },
  {
    id: 'bus-waits-a-minute',
    side: 'driver',
    title: 'A bus waits one minute',
    shows:
      'A bus pulled in at Mountain View, three people on their way. A bus is big and holds up the lane, so it waits one minute, not two: the two who make it get on, the one further off has to run for the next.',
    say: 'May humahabol ba? Hihintayin ko ba sila?',
    sayEn: 'Is anyone running for the bus? Should I wait for them?',
    at: '08:10',
    vehicles: [{ plate: 'BUS 3175', before: [MOUNTAIN_VIEW, 40], kind: 'bus' }],
    stage: (s) => {
      s.seat(0, 30);
      s.pause(MOUNTAIN_VIEW, 45);
      s.waiting(MOUNTAIN_VIEW, 1);
      // Running for it along the road, where the driver sees them.
      s.coming(MOUNTAIN_VIEW, 40, 'walk', true);
      s.coming(MOUNTAIN_VIEW, 70, 'walk', true);
      s.coming(MOUNTAIN_VIEW, 170, 'walk', true);
    },
  },
  {
    id: 'seniors-waiting',
    side: 'driver',
    title: 'Modern jeepney: a buntis and seniors next',
    shows:
      'A modern jeepney. Who is waiting, not only how many: a pregnant rider, a senior and a PWD. Muse tells the driver to ask riders to make room ("pakiusog") and give them time to get on; she gets the seat beside hers kept free.',
    say: 'Sino ang mga naghihintay sa susunod na stop? May buntis ba?',
    sayEn: 'Who is waiting at the next stop? Is anyone pregnant?',
    at: '09:40',
    vehicles: [{ plate: 'SRC 1935', before: [AMPARO, 200], kind: 'modern' }],
    stage: (s) => {
      s.seat(0, 7);
      s.waiting(AMPARO, 5, ['pregnant', 'senior', 'pwd', 'student', 'regular']);
    },
  },
];

const COMMUTER: DemoScene[] = [
  {
    id: 'plan-trip',
    side: 'commuter',
    title: 'How do I get there?',
    shows: 'Any trip across Metro Manila: Muse picks one, says why, and draws it on the map.',
    why: 'Going somewhere new, or across the city: Metro Manila has over 500 jeepney and bus routes and no one map of them, so even locals ask around. Muse picks the rides and where to change, and draws them.',
    who: 'New to the city or the area: students starting college in Manila, workers from the province, OFWs home, visitors. Or a regular going somewhere they have never been.',
    say: 'Paano pumunta sa Cubao mula sa SM Fairview?',
    sayEn: 'How do I get to Cubao from SM Fairview?',
    at: '08:15',
    vehicles: [{ plate: 'PLN 3346', before: [FAIRVIEW, 700] }],
    stage: (s) => s.trip(FAIRVIEW, null),
  },
  {
    id: 'seat-for-me',
    side: 'commuter',
    title: 'Will the bus have a seat?',
    shows: 'The first bus is packed: Muse says skip it, the next one has a seat for you.',
    why: 'You cannot see inside a bus until it stops in front of you. For a senior, someone with bags or a child, standing for 40 minutes is hard: knowing the next one has a seat is worth a short wait.',
    who: 'Daily commuters (sanay na) who know the route and want a seat: seniors, parents with a child, anyone with bags.',
    say: 'May upuan ba sa susunod na bus?',
    sayEn: 'Will the next bus have a seat?',
    at: '07:25',
    vehicles: [
      { plate: 'FUL 2204', before: [MALARIA, 260], kind: 'bus' },
      { plate: 'SIT 7719', before: [MALARIA, 1050], kind: 'bus' },
    ],
    stage: (s) => {
      s.fill(0);
      s.seat(1, 20);
      s.waiting(MALARIA, 2);
      return s.me(MALARIA, LAGRO);
    },
  },
  {
    id: 'missed-ride',
    side: 'commuter',
    title: 'I missed my modern jeepney',
    shows:
      'The modern jeepney just left. Muse plans again from where you stand, with the next one by the clock.',
    why: 'A modern jeepney just pulled away and you do not know when the next comes, or whether another ride is quicker. Muse plans again from where you stand.',
    who: 'Daily commuters (sanay na) whose usual ride just left, and who need the next best way now.',
    say: 'Na-miss ko ang modern jeep. Ano ang gagawin ko?',
    sayEn: 'I missed my modern jeepney. What should I do?',
    at: '08:40',
    vehicles: [
      { plate: 'GON 4410', before: [AMPARO, 870], kind: 'modern' },
      { plate: 'NXT 1582', before: [MOUNTAIN_VIEW, 900], kind: 'modern' },
    ],
    stage: (s) => {
      s.seat(0, 11);
      s.seat(1, 9);
      s.trip(null, LAGRO);
      return s.me(MOUNTAIN_VIEW, LAGRO);
    },
  },
  {
    id: 'signboard',
    side: 'commuter',
    title: 'Read this signboard',
    route: CUBAO_PROJECT_4,
    shows:
      'Quezon City, by Cubao: you wait on 20th Avenue and a jeepney comes, its board saying Cubao – Proj. 4. A photo of the board: Muse reads it, checks it against the route, and says whether it passes Quirino Memorial Medical Center, in Project 4.',
    why: 'A board shows only its two ends, never the places in between: it says Cubao – Proj. 4, not Quirino Memorial. Asking means flagging it down and shouting over the engine, and the driver or the riders may not know either. New to the area, a visitor, or hard of hearing: a photo answers in seconds, before it pulls away.',
    who: 'New to the area: a visitor, a student or worker new to Quezon City, anyone off their usual route. Also the hard of hearing.',
    say: 'Dadaan ba ito sa Quirino Memorial Medical Center?',
    sayEn: 'Does this one go past Quirino Memorial Medical Center?',
    at: '11:30',
    vehicles: [{ plate: 'SGN 9076', before: [D_SILANG, 300], kind: 'jeepney' }],
    stage: (s) => {
      s.seat(0, 8);
      return s.me(D_SILANG, QUIRINO_MEMORIAL);
    },
    photo: '/demo/signboard-cubao.jpg',
  },
  {
    id: 'jeep-to-my-street',
    side: 'commuter',
    title: 'The jeep comes to my street',
    route: FAIRVIEW_QUIAPO,
    shows:
      'Sampaloc, Manila, 5:40 PM: you and three neighbours wait on your own street, deep off España Boulevard. España is jammed, so the jeepney coming from Quiapo takes the way round through your street. Ask, and Muse says it is coming down your street with seats: wait there, no tricycle to España.',
    why: 'Off the main road you usually walk, or pay a tricycle about ₱20, to get to España. When a jeepney going round the jam comes down your own street, waiting where you are saves the fare and the walk, for you and your neighbours. The driver’s Muse counts you too.',
    who: 'Daily commuters (sanay na) living off the main road, on the streets jeepneys take round the jam: in Sampaloc, deep in from España.',
    say: 'May jeep bang dadaan dito sa kalye namin? O mag-tricycle pa ako papuntang España?',
    sayEn: 'Is a jeepney coming down our street, or do I take a tricycle to España?',
    at: '17:40',
    vehicles: [
      { plate: 'SPL 4120', before: [ESPANA_OSMENA, 101], kind: 'jeepney' },
      ...queue(ESPANA_OSMENA, -30, -1300, 34),
    ],
    stage: (s) => {
      s.seat(0, 14);
      for (let i = 1; i <= 34; i++) s.fill(i);
      // The jam just past the turn: the jeepney is at the corner in seconds, the queue in sight.
      s.jam(110, 1400, 1.2);
      // The jeepney takes the way round by your street; you and three
      // neighbours wait on it, as far from the highway as it goes (placed once
      // the street is known).
      void stageWays(
        s.twin,
        0,
        [[{ at: 'deepest', count: 3, to: MRT_QUEZON_AVENUE }]],
        { vehicle: 0, way: 0 },
        {
          way: 0,
          to: MRT_QUEZON_AVENUE,
        },
      );
    },
  },
  {
    id: 'wake-me',
    side: 'commuter',
    title: 'Wake me at my stop',
    shows:
      'A long ride home in the evening rush, Tungko to Lagro, about half an hour: you sleep, and Automatic AI wakes you a few minutes before your stop, without being asked. It plays at 30× and slows to real time as it wakes you.',
    why: 'A long ride home after work, and people doze off. Missing your stop at night means a costly, unsafe trip back. Muse watches the road for you and wakes you in time.',
    who: 'Daily commuters (sanay na) on a long ride home: tired workers and students who doze off.',
    say: 'Gisingin mo ako bago ako bumaba.',
    sayEn: 'Wake me up before my stop.',
    at: '19:10',
    vehicles: [{ plate: 'WKE 6031', before: [TUNGKO, -220] }],
    speed: 30,
    stage: (s) => {
      // The evening crawl on Quirino Highway, past Sampaguita.
      s.jam(1500, 3000, 2.5);
      return s.aboard(0, LAGRO, 13);
    },
    tab: 'trip',
    auto: true,
    camera: 'behind',
  },
  {
    id: 'flag-down',
    side: 'commuter',
    title: 'Wave one down by the road',
    shows: 'No stop near you: the jeepney coming with a seat pulls over where you stand.',
    why: 'Most people do not wait at a stop: they wave a jeepney down wherever they are. Muse tells the one coming with a seat where you stand, so it pulls over for you.',
    who: 'Daily commuters (sanay na) in barangays far from a stop, who wave jeepneys down every day.',
    say: 'Titigil ba ang jeep para sa akin dito?',
    sayEn: 'Will the jeepney stop for me here?',
    at: '09:50',
    vehicles: [{ plate: 'WAV 2863', before: [MOUNTAIN_VIEW, 980] }],
    stage: (s) => {
      s.seat(0, 8);
      return s.flagging(MOUNTAIN_VIEW, 620, LAGRO);
    },
  },
  {
    id: 'senior-fare',
    side: 'commuter',
    title: 'My bus fare as a senior',
    shows:
      'On a city bus: the LTFRB bus fare for this ride, with the 20% senior discount worked out for you.',
    why: 'Seniors are often charged the full fare, and few know the exact discounted fare the law gives them. Muse works it out, so they pay what is right.',
    who: 'Senior citizens, new or sanay, and those with them: the discount is theirs by law, and often not given.',
    say: 'Magkano ang pamasahe ko sa bus? Senior citizen ako.',
    sayEn: "How much is my bus fare? I'm a senior citizen.",
    at: '10:10',
    vehicles: [{ plate: 'FAR 5127', before: [MOUNTAIN_VIEW, 400], kind: 'bus' }],
    stage: (s) => s.aboard(0, LAGRO, 9, 'senior'),
    camera: 'behind',
  },
  {
    id: 'long-queue',
    side: 'commuter',
    title: 'Long queue for a modern jeepney',
    shows:
      'Rush hour, fourteen ahead of you: which modern jeepney you really get on, counting the queue and the standing room.',
    why: 'Fourteen people ahead at the terminal, and you cannot tell whether you fit in the next one. Muse counts the queue against the seats and standing room, so you know whether to wait or go another way.',
    who: 'Daily commuters (sanay na) in the rush-hour line at a terminal, deciding whether to wait.',
    say: 'Makakasakay ba ako sa susunod na modern jeep?',
    sayEn: 'Will I get on the next modern jeepney?',
    at: '07:35',
    vehicles: [
      { plate: 'QUE 1846', before: [MALARIA, 340], kind: 'modern' },
      { plate: 'QUE 7302', before: [MALARIA, 1100], kind: 'modern' },
    ],
    stage: (s) => {
      s.seat(0, 27);
      s.seat(1, 8);
      s.waiting(MALARIA, 14);
      return s.me(MALARIA, LAGRO);
    },
  },
  {
    id: 'priority-seat',
    side: 'commuter',
    title: 'A roomy jeep for a buntis',
    shows:
      'Pregnant, you need room, not a squeeze. The first jeepney has one tight place left; Muse says take the next, with room to sit.',
    why: 'A pregnant rider squeezed onto a packed bench is not safe, and many are shy to ask for room. Muse points her to the ride with room to sit, and tells the driver.',
    who: 'Pregnant riders, new or sanay; the same goes for PWD and seniors who need room.',
    say: 'Buntis ako, may maluwag bang jeep para sa akin?',
    sayEn: "I'm pregnant. Is there a jeepney with room for me?",
    at: '07:45',
    vehicles: [
      { plate: 'SQZ 4407', before: [MALARIA, 260] },
      { plate: 'RUM 2951', before: [MALARIA, 1050] },
    ],
    stage: (s) => {
      s.fill(0, 1);
      s.seat(1, 12);
      s.waiting(MALARIA, 1);
      return s.me(MALARIA, LAGRO, { kind: 'pregnant' });
    },
  },
  {
    id: 'cross-road',
    side: 'commuter',
    title: 'Crossing to the stop',
    shows:
      'You walk to the zebra crossing by the stop and cross there; the jeepney coming stops at it for you, then you get on.',
    why: 'Crossing a wide highway to reach the stop is one of the riskiest parts of a commute. Muse sends you to the zebra crossing, and the jeepney coming stops at it for you.',
    who: 'Both: someone new who does not know where it is safe to cross, and regulars who cut across the highway; parents and students most of all.',
    say: 'Ligtas ba tumawid papunta sa stop?',
    sayEn: 'Is it safe to cross to the stop?',
    at: '12:20',
    vehicles: [{ plate: 'CRS 8245', before: [MALARIA, 230] }],
    stage: (s) => {
      s.seat(0, 8);
      const to = s.at(MALARIA);
      const heading = s.route.polyline.headingAt(s.route.stops[MALARIA]!.s, 4);
      const across = { x: Math.sin(heading) * ACROSS_M, z: Math.cos(heading) * ACROSS_M };
      const from = { x: to.x - across.x, z: to.z - across.z };
      return s.twin.crew.join(MALARIA, LAGRO, ACROSS_M, 'walk', {
        kind: 'regular',
        from,
        keepStop: true,
        way: { points: [from, to], widths: [0], metres: ACROSS_M },
      });
    },
    tab: 'trip',
    camera: 'wide',
  },
];

/** Room round the crossing in its shot (metres). */
const CROSSING_MARGIN_M = 12;

/** "You" start this far from the stop, across the road from it (metres). */
const ACROSS_M = 34;

export const DEMO_SCENES: readonly DemoScene[] = [...DRIVER, ...COMMUTER];

/** The route `scene` is on: its own, or the one every other scene is on. */
function sceneRoute(scene: DemoScene): Route {
  const network = getNetwork();
  const first = defaultRoute();
  const id = scene.route ?? first.id;
  return network?.routes.find((r) => r.route.id === id)?.route ?? first;
}

/** "07:10" as a simulation's start. */
function clockOf(at: string): Pick<SimulationScenario, 'startHour' | 'startOffsetS'> {
  const [hour, minute] = at.split(':').map(Number) as [number, number];
  return { startHour: hour, startOffsetS: minute * 60 };
}

/** The vehicles a scene starts with: its own, then the rest round the route, clear of them. */
export function sceneFleet(
  scene: DemoScene,
  route: Route,
): { scenario: SimulationScenario; start: FleetStart[] } {
  const L = route.polyline.length;
  const wrap = (s: number) => ((s % L) + L) % L;
  const cast: FleetStart[] = scene.vehicles.map((v) => ({
    s: wrap(route.stops[v.before[0]]!.s - v.before[1]),
    occupancy: 0,
    plate: v.plate,
    kind: v.kind ?? 'jeepney',
  }));
  const apart = (a: number, b: number) => Math.min(wrap(a - b), wrap(b - a));
  const start = [...cast];
  for (let i = 0; i < (scene.quiet ? 0 : BACKGROUND_VEHICLES); i++) {
    const s = ((i + 0.25) / BACKGROUND_VEHICLES) * L;
    if (cast.some((c) => apart(c.s, s) < CLEAR_OF_CAST_M)) continue;
    start.push({
      s,
      occupancy: BACKGROUND_RIDERS,
      plate: `MNL ${1000 + 137 * i}`,
      kind: 'jeepney',
    });
  }
  return {
    scenario: {
      ...FIELD_SCENARIO,
      ...clockOf(scene.at),
      vehicles: start.length,
      dailyTrips: SCENE_TRIPS,
      ownerShare: OWNER_SHARE,
    },
    start,
  };
}

/** A scene on a route of its own checks for it this often while the network loads (ms). */
const ROUTE_WAIT_MS = 500;
/** Once the network is in, it looks this many more times before giving up on its route. */
const ROUTE_TRIES = 6;

/** Plays `scene`: the twin is rebuilt for it, and stageScene sets the moment up on the new one. */
export function startScene(scene: DemoScene, tries = ROUTE_TRIES): void {
  // On a route of its own (Cubao, España): it waits for that route, however
  // long the network takes to come in, and never plays on another instead.
  if (scene.route && !getNetwork()?.routes.some((r) => r.route.id === scene.route)) {
    const loading = useApp.getState().network.state === 'loading';
    if (loading || (getNetwork() && tries > 0)) {
      setTimeout(() => startScene(scene, loading ? tries : tries - 1), ROUTE_WAIT_MS);
      return;
    }
    // The network did not load: load it now, for this scene.
    if (!getNetwork()) {
      void loadNetwork(defaultRoute())
        .then(() => startScene(scene, 0))
        .catch(() => startScene({ ...scene, route: undefined }));
      return;
    }
  }
  const app = useApp.getState();
  const route = sceneRoute(scene);
  app.enterDemo();
  app.setLocating(false);
  app.setAutoAI(null);
  app.setAgentWay(null);
  app.setTripPreview(null);
  for (const end of ['home', 'from', 'to'] as const) app.setTripEnd(end, null);
  app.setMe({ kind: 'regular', place: null });
  app.setSimulationSpeed(scene.speed ?? 1);
  app.setOtherRoutes(scene.quiet ? false : (useApp.getState().demoKept?.otherRoutes ?? true));
  app.setDemoAsk(null);
  app.setDemoScene(scene.id);
  app.setFocus({ route, ...sceneFleet(scene, route) });
}

/** Sets `scene` up on the twin built for it. */
export function stageScene(scene: DemoScene, twin: TwinRuntime): void {
  // The side streets first, when known: people on their way come in by them,
  // out of the driver's sight, not along the route in front of it.
  const streets = knownStreets(twin.route.id);
  if (streets) twin.crew.setStreets(streets);
  const stage = new Stage(twin);
  const first = twin.fleet.vehicles[0]!;
  for (const stop of [first.nextStop, ...stopsAhead(twin.route, first.nextStop, 1)].slice(
    0,
    QUIET_STOPS,
  ))
    twin.crew.setWaiting(stop, []);
  // Its few vehicles have the road to themselves: a clear road's pace.
  if (scene.quiet) twin.fleet.emptyRoad();
  // Nobody peels off for diesel in the middle of a scene.
  for (const v of twin.fleet.vehicles) v.tankL = v.tankCapacityL * FULL_TANK;
  const rider = scene.stage(stage);
  const app = useApp.getState();
  if (scene.side === 'driver') {
    app.setFollow({ kind: 'sim', index: 0, view: scene.camera === 'pov' ? 'pov' : 'chase' });
  } else if (rider !== undefined) {
    app.setCommuter({ passenger: rider });
    if (scene.camera === 'behind')
      useApp.setState({ follow: { kind: 'sim', index: 0, view: 'chase' }, trackedRiderId: null });
    const spot = twin.crew.passengers.get(rider)?.spot;
    if (scene.camera === 'wide' && spot) app.requestShot('area', crossingShot(twin, spot));
  } else {
    app.requestShot('area', aroundSpot(app.tripEnds.home?.at ?? stage.at(0)));
  }
  if (scene.auto) app.setAutoAI(autoKey(rider === undefined ? 'vehicle' : 'person', rider ?? 0));
  if (scene.side === 'commuter' && rider !== undefined) app.setMe({ kind: riderKind(twin, rider) });
  openTab(scene.side, scene.tab ?? 'ask');
  app.setDemoAsk({ text: sceneLine(scene), photo: scene.photo, send: false });
}

/** Close over the pedestrian crossing nearest `spot`, kerb to kerb, else around the spot. */
function crossingShot(twin: TwinRuntime, spot: LocalPoint): LocalPoint[] {
  const middle = (z: Zebra) => ({ x: (z.left.x + z.right.x) / 2, z: (z.left.z + z.right.z) / 2 });
  const zebra = twin.crew.zebras.reduce<Zebra | null>((best, z) => {
    const d = (q: Zebra) => Math.hypot(middle(q).x - spot.x, middle(q).z - spot.z);
    return !best || d(z) < d(best) ? z : best;
  }, null);
  if (!zebra) return aroundSpot(spot);
  const xs = [zebra.left.x, zebra.right.x, spot.x];
  const zs = [zebra.left.z, zebra.right.z, spot.z];
  return [
    { x: Math.min(...xs) - CROSSING_MARGIN_M, z: Math.min(...zs) - CROSSING_MARGIN_M },
    { x: Math.max(...xs) + CROSSING_MARGIN_M, z: Math.max(...zs) + CROSSING_MARGIN_M },
  ];
}

const riderKind = (twin: TwinRuntime, id: number): RiderKind =>
  twin.crew.passengers.get(id)?.kind ?? 'regular';

/** The scene's line, in the language Muse is answering in. */
export const sceneLine = (scene: DemoScene): string =>
  useApp.getState().english ? scene.sayEn : scene.say;

/** The scene after `scene` on its side, round to the first. */
export function nextScene(scene: DemoScene): DemoScene {
  const side = DEMO_SCENES.filter((s) => s.side === scene.side);
  return side[(side.indexOf(scene) + 1) % side.length]!;
}
