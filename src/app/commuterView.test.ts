import { describe, expect, it } from 'vitest';
import { useApp } from './store';

describe('going from the live twin to a phone', () => {
  it('takes the vehicle being followed to the driver’s phone', () => {
    const s = useApp.getState();
    s.setView('twin');
    s.setFollow({ kind: 'sim', index: 7, view: 'chase' });
    s.setView('driver');
    const after = useApp.getState();
    expect(after.driverVehicle).toBe(7);
    expect(after.follow).toMatchObject({ kind: 'sim', index: 7, view: 'pov' });
  });

  it('takes it to the commuter’s phone, the camera staying on it until there is a rider', () => {
    const s = useApp.getState();
    s.setView('twin');
    s.setFollow({ kind: 'sim', index: 5, view: 'chase' });
    s.setView('commuter');
    expect(useApp.getState().commuterVehicle).toBe(5);
    expect(useApp.getState().follow).toMatchObject({ index: 5 });
    // A rider on it: the phone is theirs, and the pick is done.
    s.setCommuter({ passenger: 42, chosen: true });
    expect(useApp.getState().commuterVehicle).toBeNull();
    expect(useApp.getState().trackedRiderId).toBe(42);
  });

  it('picks it up from a click in 3D on the commuter’s phone too', () => {
    const s = useApp.getState();
    s.setView('commuter');
    s.setFollow({ kind: 'sim', index: 3, view: 'chase' });
    expect(useApp.getState().commuterVehicle).toBe(3);
    s.setCommuter({ passenger: 1 });
  });

  it('with nothing followed, a phone goes on as it was', () => {
    const s = useApp.getState();
    s.setView('twin');
    s.setFollow(null);
    s.setDriverVehicle(2);
    s.setView('twin');
    s.setFollow(null);
    s.setView('driver');
    expect(useApp.getState().driverVehicle).toBe(2);
    s.setView('twin');
    s.setFollow(null);
    s.setView('commuter');
    expect(useApp.getState().commuterVehicle).toBeNull();
  });
});

describe('opening the commuter’s phone', () => {
  it('leaves the camera where it is, until there is a rider to follow', () => {
    const s = useApp.getState();
    s.setView('twin');
    s.setFollow(null);
    s.setCommuter({ stop: 0, destination: 1 });
    s.requestShot('overview');
    const shot = useApp.getState().shot;
    // Not sent to the first stop (Tungko): look around, pick a spot or someone to be.
    s.setView('commuter');
    expect(useApp.getState().shot).toEqual(shot);
    expect(useApp.getState().trackedRiderId).toBeNull();
    // Someone already in the twin, chosen to be: the camera follows them…
    s.setCommuter({ passenger: 718, chosen: true });
    expect(useApp.getState().trackedRiderId).toBe(718);
    // …and coming back to the phone later still does.
    s.setView('twin');
    s.setView('commuter');
    expect(useApp.getState().trackedRiderId).toBe(718);
  });
});
