import { beforeEach, describe, expect, it } from 'vitest';
import { defaultRoute } from '@/core/geo/routes';
import { DEMO_SCENES, sceneFleet, startScene } from './demoScenes';
import { useApp } from './store';

const scene = DEMO_SCENES.find((s) => s.id === 'jam-shortcut')!;
const app = () => useApp.getState();

describe('a demo scene and the live map', () => {
  beforeEach(() => {
    app().leaveDemo();
    app().setView('twin');
    app().setSimulationSpeed(30);
    app().setDriverVehicle(4);
    app().setTripEnd('to', { name: 'Lagro', at: { x: 1, z: 2 } });
  });

  const live = () => {
    const { scenario, route, simulationSpeed, driverVehicle, tripEnds } = app();
    return { scenario, route, simulationSpeed, driverVehicle, tripEnds };
  };

  it('a scene takes over while it plays', () => {
    const before = live();
    app().setView('driver');
    startScene(scene);
    expect(app().scenario).not.toBe(before.scenario);
    expect(app().simulationSpeed).toBe(1);
    expect(app().demoScene?.id).toBe(scene.id);
  });

  it('End gives the live map back, the very same day', () => {
    const before = live();
    app().setView('driver');
    startScene(scene);
    app().leaveDemo();
    expect(app().scenario).toBe(before.scenario);
    expect(app().route).toBe(before.route);
    expect(app().tripEnds).toBe(before.tripEnds);
    expect(app().simulationSpeed).toBe(30);
    expect(app().demoScene).toBeNull();
  });

  it('going to the live map ends the scene, however many were played', () => {
    const before = live();
    app().setView('driver');
    startScene(scene);
    startScene(DEMO_SCENES.find((s) => s.id === 'low-diesel')!);
    app().setView('twin');
    expect(app().scenario).toBe(before.scenario);
    expect(app().demoScene).toBeNull();
    expect(app().demoKept).toBeNull();
  });

  it('a scene stays while its own view does', () => {
    app().setView('driver');
    startScene(scene);
    app().setView('driver');
    expect(app().demoScene?.id).toBe(scene.id);
  });

  it('a scene is about its own vehicles, none of them the live fleet', () => {
    const { start } = sceneFleet(scene, defaultRoute());
    expect(start[0]!.plate).toBe('TYK 5530');
  });
});
