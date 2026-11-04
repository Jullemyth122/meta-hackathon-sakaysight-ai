import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commuterView } from '@/core/advisory/commuter';
import { dispatch } from '@/core/advisory/dispatch';
import { driverView } from '@/core/advisory/driver';
import { noticesFor, riderNotices } from '@/core/agent/autopilot';
import {
  handOver,
  lateRiders,
  leaveOrWait,
  nextRides,
  seatsForNextStops,
  trafficAhead,
  vehiclesAhead,
  whoIsWaiting,
} from '@/core/agent/road';
import { normalizeScenario } from '@/core/fleet/scenario';
import { kindOf } from '@/core/people/passengerSystem';
import { fuelAhead, setStationData, stationsFor } from '@/core/fuel/stations';
import { Polyline } from '@/core/geo/polyline';
import { defaultRoute } from '@/core/geo/routes';
import { fleetPose } from '@/scene/world/lanes';
import { driverTools } from './agentTools';
import { DEMO_SCENES, sceneFleet, stageScene, type DemoScene } from './demoScenes';
import { boundaryLeft } from './earnings';
import { useApp } from './store';
import { TwinRuntime } from './twinRuntime';
import { twinState } from './twinState';

const route = defaultRoute();
const sceneOf = (id: string): DemoScene => DEMO_SCENES.find((s) => s.id === id)!;

/** The scene `id` set up, then run on for `seconds`. */
function play(id: string, seconds = 0) {
  const scene = sceneOf(id);
  const { scenario, start } = sceneFleet(scene, route);
  const twin = new TwinRuntime(route, undefined, normalizeScenario(scenario), start);
  stageScene(scene, twin);
  const run = (s: number) => {
    for (let i = 0; i < s * 10; i++) twin.step(0.1, i * 100);
  };
  run(seconds);
  const look = () => {
    const state = twinState(twin);
    const plan = dispatch(state);
    return { state, plan, view: driverView(state, 0, plan) };
  };
  const me = () => useApp.getState().commuter;
  const phone = () => {
    const { state, plan } = look();
    return commuterView(state, plan, me());
  };
  return { twin, run, look, me, phone };
}

describe('the demo scenes', () => {
  it('has them ready for both sides, each with a line to say', () => {
    expect(DEMO_SCENES.filter((s) => s.side === 'driver').length).toBeGreaterThanOrEqual(10);
    expect(DEMO_SCENES.filter((s) => s.side === 'commuter').length).toBeGreaterThanOrEqual(10);
    expect(new Set(DEMO_SCENES.map((s) => s.id)).size).toBe(DEMO_SCENES.length);
    for (const s of DEMO_SCENES) expect(s.say.length).toBeGreaterThan(5);
  });

  it('starts every scene at its time, with its own vehicle first', () => {
    for (const scene of DEMO_SCENES) {
      const { scenario, start } = sceneFleet(scene, route);
      const twin = new TwinRuntime(route, undefined, normalizeScenario(scenario), start);
      expect(twin.fleet.vehicles[0]!.plate).toBe(scene.vehicles[0]!.plate);
      const [hour, minute] = scene.at.split(':').map(Number) as [number, number];
      expect(twin.clockS).toBe(hour * 3600 + minute * 60);
      expect(twin.fleet.vehicles[0]!.duty).toBe('service');
    }
  });

  it('stop or pass: six waiting and two getting off say stop', () => {
    const { view } = play('stop-or-pass').look();
    expect(view.ahead[0]).toMatchObject({
      name: 'Malaria',
      action: 'stop',
      waiting: 6,
      dropOffs: 2,
    });
  });

  it('an empty stop says pass', () => {
    expect(play('empty-stop').look().view.ahead[0]!.action).toBe('pass');
  });

  it('the jam is heavy, and there to see: the road packed, the vehicle held up by it', () => {
    const scene = play('jam-shortcut', 30);
    const { state } = scene.look();
    expect(trafficAhead(state, 0).level).toBe('heavy');
    expect(trafficAhead(state, 0).extraMin).toBeGreaterThan(5);
    expect(trafficAhead(state, 0).stuckAhead).toBeGreaterThanOrEqual(10);
    scene.run(30);
    expect(scene.twin.fleet.vehicles[0]!.speedMps).toBeLessThan(2.5);
  });

  it('takes a way off the road and comes back on it, riders and all', () => {
    const scene = play('jam-shortcut');
    const { twin } = scene;
    const v = twin.fleet.vehicles[0]!;
    const riders = v.occupancy;
    const offRoad = (s: number) => {
      const p = route.polyline.pointAt(s);
      const h = route.polyline.headingAt(s, 4);
      return { x: p.x + Math.sin(h) * 60, z: p.z + Math.cos(h) * 60 };
    };
    const enterS = v.s + 10;
    const exitS = v.s + 900;
    const line = new Polyline([
      route.polyline.pointAt(enterS),
      offRoad(enterS + 30),
      offRoad(exitS - 30),
      route.polyline.pointAt(exitS),
    ]);
    expect(twin.fleet.takeWay(0, line, enterS, exitS)).toBe(true);
    scene.run(40);
    expect(v.detour?.on).toBe(true);
    const off = fleetPose(twin.fleet, 0, { x: 0, z: 0, heading: 0 });
    expect(route.polyline.project(off, [enterS - 50, exitS + 50]).offset).toBeGreaterThan(20);
    expect(v.speedMps).toBeGreaterThan(3);
    scene.run(180);
    expect(v.detour).toBeNull();
    expect(v.s).toBeGreaterThanOrEqual(exitS);
    expect(v.occupancy).toBe(riders);
  });

  it('stops on the side street it takes for those waiting by it, and they ride on', () => {
    const scene = play('which-way-pays');
    const { twin } = scene;
    const v = twin.fleet.vehicles[0]!;
    const riders = v.occupancy;
    const offRoad = (s: number, m = 60) => {
      const p = route.polyline.pointAt(s);
      const h = route.polyline.headingAt(s, 4);
      return { x: p.x + Math.sin(h) * m, z: p.z + Math.cos(h) * m };
    };
    const enterS = v.s + 10;
    const exitS = v.s + 900;
    const line = new Polyline([
      route.polyline.pointAt(enterS),
      offRoad(enterS + 30),
      offRoad(exitS - 30),
      route.polyline.pointAt(exitS),
    ]);
    // Three by the side street, halfway along it; going to SM Fairview.
    const flagS = (enterS + exitS) / 2;
    const middle = line.pointAt(line.length / 2);
    const ids = [0, 1, 2].map((k) =>
      twin.crew.join(5, 11, 0, 'walk', {
        flagS,
        flagAt: { x: middle.x + 3, z: middle.z + k },
        byStreet: true,
      }),
    );
    expect(twin.fleet.takeWay(0, line, enterS, exitS)).toBe(true);
    let stopped = false;
    for (let t = 0; t < 400 && v.detour; t += 1) {
      scene.run(1);
      if (v.detour?.on && v.currentStop !== null) stopped = true;
    }
    expect(stopped).toBe(true);
    expect(v.detour).toBeNull();
    expect(v.occupancy).toBe(riders + 3);
    for (const id of ids) expect(twin.crew.passengers.get(id)?.vehicleId).toBe(v.id);
  });

  it('will not turn at a junction already behind it', () => {
    const { twin } = play('jam-shortcut');
    const v = twin.fleet.vehicles[0]!;
    const line = new Polyline([route.polyline.pointAt(v.s - 40), route.polyline.pointAt(v.s)]);
    expect(twin.fleet.takeWay(0, line, v.s - 40, v.s + 200)).toBe(false);
  });

  it('late riders: some reach the stop just after the jeepney', () => {
    const { state, view } = play('late-riders').look();
    expect(lateRiders(state, view, 0)[0]!.count).toBeGreaterThanOrEqual(2);
  });

  it('late riders: asked, the jeepney waits at the stop for them, then goes', async () => {
    const scene = play('late-riders', 10);
    const v = scene.twin.fleet.vehicles[0]!;
    const coming = [...scene.twin.crew.passengers.values()].filter(
      (p) => p.phase === 'approaching',
    );
    const asked = (await driverTools(scene.twin, 0)('late_riders', {})) as {
      waitingNow: { at: string; riders: number; mostMin: number; tooLate: number } | null;
    };
    expect(asked.waitingNow).toMatchObject({ at: 'Sampaguita', tooLate: 1 });
    expect(asked.waitingNow!.riders).toBeGreaterThanOrEqual(2);
    expect(asked.waitingNow!.mostMin).toBe(2);
    const aboard = () =>
      coming.filter((p) => scene.twin.crew.passengers.get(p.id)?.lastVehicleId === 0).length;
    // Standing at the stop until everyone who makes it is on, then off.
    let leftWith = -1;
    for (let s = 0; s < 240 && leftWith < 0; s += 1) {
      scene.run(1);
      if (v.currentStop === null) leftWith = aboard();
    }
    expect(leftWith).toBe(asked.waitingNow!.riders);
    // It does not wait for the one too late, still on their way.
    expect(coming.some((p) => scene.twin.crew.passengers.get(p.id)?.phase === 'approaching')).toBe(
      true,
    );
  });

  it('a bus waits one minute: the one further off runs for the next', async () => {
    const scene = play('bus-waits-a-minute', 10);
    const v = scene.twin.fleet.vehicles[0]!;
    expect(v.kind).toBe('bus');
    const coming = [...scene.twin.crew.passengers.values()].filter(
      (p) => p.phase === 'approaching',
    );
    const asked = (await driverTools(scene.twin, 0)('late_riders', {})) as {
      waitingNow: { riders: number; mostMin: number; tooLate: number } | null;
    };
    expect(asked.waitingNow).toMatchObject({ riders: 2, mostMin: 1, tooLate: 1 });
    scene.run(90);
    expect(v.currentStop).toBeNull();
    const boarded = coming.filter((p) => scene.twin.crew.passengers.get(p.id)?.lastVehicleId === 0);
    expect(boarded.length).toBe(2);
  });

  it('not enough seats: nine waiting for two', () => {
    const { plan, view } = play('not-enough-seats').look();
    expect(seatsForNextStops(plan, view, 0)[0]).toMatchObject({ waiting: 9, enough: false });
  });

  it('bunching: the ones ahead have the seats, so drop back', () => {
    const { state, plan, view } = play('bunching').look();
    expect(vehiclesAhead(state, plan, view, 0).advice).toBe('hold_back');
  });

  it('low diesel: stations ahead, one the cheapest', () => {
    setStationData(JSON.parse(readFileSync('public/data/metro-manila-fuel.json', 'utf8')).stations);
    const { twin } = play('low-diesel');
    const p = fleetPose(twin.fleet, 0, { x: 0, z: 0, heading: 0 });
    const v = twin.fleet.vehicles[0]!;
    const ahead = fuelAhead(route, stationsFor(route), {
      s: v.s,
      direction: v.direction,
      x: p.x,
      z: p.z,
    });
    expect(ahead.length).toBeGreaterThan(1);
    expect(ahead.some((f) => f.cheapest)).toBe(true);
    expect(v.tankL / v.tankCapacityL).toBeLessThan(0.25);
  });

  it('by the road: it pulls over and takes them', () => {
    const scene = play('roadside');
    expect(scene.look().view.roadside[0]).toMatchObject({ canTake: true });
    scene.run(150);
    const taken = [...scene.twin.crew.passengers.values()].filter((p) => p.vehicleId === 0);
    expect(taken.some((p) => p.flagS !== undefined)).toBe(true);
  });

  it('alis na o hintay: at the terminal, who is coming is worth waiting for', () => {
    const scene = play('leave-or-wait', 40);
    const { state, view } = scene.look();
    const sum = leaveOrWait(state, view, 0);
    expect(sum).toMatchObject({ atTerminal: true, advice: 'wait' });
    expect(sum.coming).toBeGreaterThan(0);
    expect(sum.extraFaresPhp!).toBeGreaterThan(sum.waitCostPhp!);
  });

  it('boundary: short of the costs of the day, in laps', () => {
    const { twin } = play('boundary');
    const left = boundaryLeft(twin.fleet.vehicles[0]!, 20);
    expect(left.shortPhp).toBeGreaterThan(0);
    expect(left.lapsToCover).toBeGreaterThan(0);
  });

  it('pass riders on: they switch to the one right behind, and you U-turn for the crowd, in 3 minutes', async () => {
    const scene = play('pass-riders-on');
    // Only the scene's own three on the road: nobody else coming for the crowd.
    expect(scene.twin.fleet.vehicles.length).toBe(3);
    const sum = handOver(scene.look().state, 0);
    expect(sum).toMatchObject({ possible: true, riders: 3 });
    expect(sum.nextVehicle!.metresBehind).toBeLessThan(60);
    expect(sum.crowd).toMatchObject({ stop: 'Dela Costa Subdivision', waiting: 8 });
    expect(sum.gainPhp!).toBeGreaterThan(0);
    // Automatic AI sees it first of all, without being asked.
    const { state, view, plan } = scene.look();
    const notices = noticesFor({
      view,
      traffic: trafficAhead(state, 0),
      ahead: vehiclesAhead(state, plan, view, 0),
      seats: seatsForNextStops(plan, view, 0),
      late: lateRiders(state, view, 0),
      tank: 1,
      handOver: sum,
    });
    expect(notices[0]!.key).toBe('hand-over');
    const riders = [...scene.twin.crew.passengers.values()].filter((p) => p.vehicleId === 0);
    const going = riders.map((r) => r.destinationStop);
    const crowd = [...scene.twin.crew.passengers.values()].filter(
      (p) => p.phase === 'waiting' && p.originStop === sum.crowd!.at,
    );
    expect(await driverTools(scene.twin, 0)('hand_over', {})).toMatchObject({
      done: true,
      passedOn: 3,
      getOffAt: 'Amparo',
      uTurnNow: expect.any(String),
    });
    scene.run(175);
    const onNext = riders.filter((r) => scene.twin.crew.passengers.get(r.id)?.vehicleId === 1);
    expect(onNext.length).toBe(3);
    onNext.forEach((r) => expect(going).toContain(r.destinationStop));
    // Turned and back on the other side: the whole crowd is on board.
    expect(scene.twin.fleet.vehicles[0]!.detour).toBeNull();
    expect(crowd.filter((r) => scene.twin.crew.passengers.get(r.id)?.vehicleId === 0).length).toBe(
      8,
    );
  });

  it('a bus keeps to its stops, and cannot pass riders on', () => {
    const { twin, look } = play('bus-keeps-stops');
    const { state, view } = look();
    expect(view.roadside).toEqual([]);
    expect(twin.crew.flagAhead(twin.fleet.vehicles[0]!)).toBeNull();
    expect(handOver(state, 0).possible).toBe(false);
  });

  it('seniors at the next stop are told apart', () => {
    const { state, view } = play('seniors-waiting').look();
    expect(whoIsWaiting(state, view, 0)).toMatchObject({
      total: 5,
      needTimeToBoard: 3,
      discounted: 3,
      askRidersToMakeRoom: true,
    });
  });

  it('a pregnant rider has the seat beside her kept empty: one place fewer', () => {
    const scene = play('seniors-waiting');
    const v = scene.twin.fleet.vehicles[0]!;
    const places = v.capacity;
    const her = [...scene.twin.crew.passengers.values()].find(
      (p) => p.phase === 'waiting' && kindOf(p) === 'pregnant',
    )!;
    scene.run(120);
    const now = scene.twin.crew.passengers.get(her.id)!;
    expect(now.vehicleId).toBe(0);
    expect(now.room).not.toBeNull();
    expect(now.room).not.toBe(now.seat);
    const aboard = [...scene.twin.crew.passengers.values()].filter((p) => p.vehicleId === 0);
    expect(aboard.some((p) => p.seat === now.room)).toBe(false);
    expect(v.capacity).toBe(places - 1);
  });

  it('a seat: the full one is not yours, the next is', () => {
    const view = play('seat-for-me').phone();
    expect(view.arrivals[0]!.seatsForYou).toBe(0);
    expect(view.pickup?.plate).toBe('SIT 7719');
  });

  it('missed: the next ride, not the one that left', () => {
    expect(play('missed-ride').phone().pickup?.plate).toBe('NXT 1582');
  });

  it('wake me: a long ride asleep, woken a few minutes before the stop', () => {
    const scene = play('wake-me');
    const id = (scene.me() as { passenger: number }).passenger;
    const riding = () => scene.twin.crew.passengers.get(id)?.phase === 'seated';
    let wokenAtS = -1;
    let s = 0;
    for (; s < 3600 && riding(); s += 5) {
      scene.run(5);
      if (
        wokenAtS < 0 &&
        riding() &&
        riderNotices(scene.phone()).some((n) => n.key.startsWith('off:'))
      )
        wokenAtS = s;
    }
    expect(riding()).toBe(false);
    // Half an hour or so in the evening rush: long enough to sleep.
    expect(s / 60).toBeGreaterThan(25);
    expect(s / 60).toBeLessThan(60);
    // Woken in time to get ready, not at the last moment, nor long before.
    expect(wokenAtS).toBeGreaterThan(0);
    expect(s - wokenAtS).toBeGreaterThanOrEqual(60);
    expect(s - wokenAtS).toBeLessThanOrEqual(300);
  });

  it('by the road: the commuter is picked up where they stand', () => {
    const scene = play('flag-down');
    const id = (scene.me() as { passenger: number }).passenger;
    expect(scene.phone().roadside).toBe(true);
    scene.run(150);
    expect(scene.twin.crew.passengers.get(id)?.vehicleId).toBe(0);
  });

  it('a senior pays the discounted fare', () => {
    const view = play('senior-fare').phone();
    expect(view.trip.fareDiscounted).toBeLessThan(view.trip.fare);
    expect(useApp.getState().me.kind).toBe('senior');
  });

  it('the queue: fourteen ahead, so not the first one', () => {
    const view = play('long-queue').phone();
    expect(view.queueAhead).toBe(14);
    expect(view.pickup?.plate).toBe('QUE 7302');
  });

  it('a buntis is told of the jeepney with room, not the tight one', () => {
    const scene = play('priority-seat');
    const { state, plan } = scene.look();
    const me = scene.me() as { passenger: number };
    const rides = nextRides(state, plan, 4, 10, scene.twin.clockS, me.passenger);
    expect(rides.rides[0]).toMatchObject({ plate: 'SQZ 4407', roomy: false });
    expect(rides.rides.find((r) => r.plate === 'RUM 2951')).toMatchObject({ roomy: true });
  });

  it('crossing: they walk over the road and traffic gives way', () => {
    const scene = play('cross-road');
    let crossed = false;
    for (let i = 0; i < 60 && !crossed; i++) {
      scene.run(1);
      crossed = scene.twin.crew.crossingsNow.length > 0;
    }
    expect(crossed).toBe(true);
  });
});
