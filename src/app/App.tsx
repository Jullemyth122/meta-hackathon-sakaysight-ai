/**
 * Laptop dashboard. Owns the runtimes, wires the phone transport into them,
 * and lays out header / 3D viewport / side panel.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { getTransport } from '@/net';
import { DoorwayScene } from '@/scene/DoorwayScene';
import { Renderer } from '@/scene/Renderer';
import { TwinScene } from '@/scene/TwinScene';
import { DoorwayPanel } from '@/ui/DoorwayPanel';
import { Header } from '@/ui/Header';
import { CommuterPanel } from '@/ui/phone/CommuterPanel';
import { DemoScenes } from '@/ui/phone/DemoScenes';
import { DriverPanel } from '@/ui/phone/DriverPanel';
import { MirrorFrame } from '@/ui/MirrorFrame';
import { PipOverlay } from '@/ui/PipOverlay';
import { RideHud } from '@/ui/RideHud';
import { Splash } from '@/ui/Splash';
import { TwinPanel } from '@/ui/TwinPanel';
import { SimDock, ViewControls } from '@/ui/ViewControls';
import { ViewportError } from '@/ui/ViewportError';
import { DoorwayRuntime, type CameraFeed } from './doorwayRuntime';
import { RuntimeContext, type Runtimes } from './runtimeContext';
import { useLocateMe } from './useLocateMe';
import { useApp, type SessionSummary } from './store';
import { MAX_FRAME_DT_S, TwinRuntime } from './twinRuntime';
import { loadFuel, loadNetwork } from './network';
import { defaultRoute } from '@/core/geo/routes';
import { areaOf } from '@/core/tracking/area';
import { phoneGone } from '@/core/tracking/liveVehicle';
import { EconomicsLab } from '@/ui/EconomicsLab';

export function App() {
  const view = useApp((s) => s.view);
  const route = useApp((s) => s.route);
  const scenario = useApp((s) => s.scenario);
  const fleetStart = useApp((s) => s.fleetStart);
  const setBackend = useApp((s) => s.setBackend);
  const viewport = useRef<HTMLDivElement>(null);
  // Bumped when the GPU device is lost: remounting the canvas gets a new one.
  const [gpuGeneration, setGpuGeneration] = useState(0);

  // A new route rebuilds the twin; GPS history carries over and is re-matched.
  // A demo scene gets a twin of its own: the live map's stays as it is (`day`),
  // and is taken up again when the scene ends.
  const twinRef = useRef<TwinRuntime | null>(null);
  const day = useRef<TwinRuntime | null>(null);
  const scenes = useRef(new WeakSet<TwinRuntime>());
  const twin = useMemo(() => {
    const kept = day.current;
    if (kept && kept.scenario === scenario && kept.route === route) return kept;
    const scene = useApp.getState().demoKept !== null;
    const built = new TwinRuntime(
      route,
      scene ? undefined : (kept ?? undefined),
      scenario,
      fleetStart ?? undefined,
    );
    if (scene) scenes.current.add(built);
    return built;
  }, [route, scenario, fleetStart]);
  twinRef.current = twin;
  if (!scenes.current.has(twin)) day.current = twin;
  const doorway = useMemo(() => new DoorwayRuntime(), []);
  const runtimes = useMemo<Runtimes>(() => ({ twin, doorway }), [twin, doorway]);

  useLiveTelemetry(day);
  useLocateMe(twinRef, day);
  useNetwork();

  // Dev only: inspect the live simulation from the browser console.
  if (import.meta.env.DEV) Object.assign(window, { __commute: { runtimes, store: useApp } });

  // The driver and commuter apps look at the same twin, so switching between
  // them and the live twin keeps the 3D scene (and its loaded map).
  const onTwin = view !== 'doorway';
  const labVehicle = useApp((s) => s.labVehicle);
  const inScene = useApp((s) => s.demoScene !== null);
  // The Profit & service lab covers the twin rather than replacing it: the
  // canvas stays mounted (and stops drawing), so the map is not loaded again
  // on the way back.
  const economics = view === 'economics';
  // Behind the loading screen: the routes first, then the first frames. Side by
  // side, each only slows the other down.
  const building = useApp(
    (s) => !s.started && (s.network.state === 'off' || s.network.state === 'loading'),
  );
  // Without the twin's scene there is no frame loop to run its clock.
  useBackgroundClock(twin, !onTwin || economics);

  return (
    <RuntimeContext.Provider value={runtimes}>
      <Splash />
      <div className="app">
        <Header />
        {economics && <EconomicsLab />}
        <main className="stage" hidden={economics}>
          <div className="viewport" ref={viewport}>
            <ViewportError key={`${onTwin ? 'twin' : 'doorway'}-${gpuGeneration}`}>
              <Renderer
                camera={
                  onTwin
                    ? // Far enough to see a whole route plus horizon; CameraRig places it.
                      { position: [0, 2000, 2000], near: 1, far: 150_000 }
                    : { position: [-7.5, 3, 5.5], near: 0.05, far: 200 }
                }
                paused={economics || building}
                onBackend={setBackend}
                onLost={() => setGpuGeneration((g) => g + 1)}
              >
                {onTwin ? <TwinScene /> : <DoorwayScene />}
              </Renderer>
            </ViewportError>
            {onTwin && <RideHud />}
            {inScene && <div className="demo-flag">Demo scene · staged, not the live map</div>}
            {view === 'twin' && <ViewControls />}
            {(view === 'driver' || view === 'commuter') && <SimDock fuel={view === 'driver'} />}
            {view === 'doorway' && (
              <PipOverlay
                container={viewport}
                feed={labVehicle === 'jeepney' ? doorway : doorway.vehicleLab(labVehicle)}
              />
            )}
            {(view === 'twin' || view === 'driver') && (
              <RideCameraOverlay container={viewport} feed={twin.cabinFeed} />
            )}
            {(view === 'twin' || view === 'driver') && <MirrorFrame container={viewport} />}
          </div>
          {!economics && (
            <aside className="panel">
              {(view === 'driver' || view === 'commuter') && <DemoScenes side={view} />}
              {view === 'twin' ? (
                <TwinPanel />
              ) : view === 'driver' ? (
                <DriverPanel />
              ) : view === 'commuter' ? (
                <CommuterPanel />
              ) : (
                <DoorwayPanel />
              )}
            </aside>
          )}
        </main>
      </div>
    </RuntimeContext.Provider>
  );
}

/**
 * Run the twin's clock while its scene is not drawing (the sensor lab, the
 * Profit & service lab), at the chosen speed, so the simulated day goes on
 * as it does on screen. TwinScene runs it from its frame loop otherwise.
 */
function useBackgroundClock(twin: TwinRuntime, active: boolean) {
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const { simulationSpeed, skipNight } = useApp.getState();
      const dt = Math.min((now - last) / 1000, MAX_FRAME_DT_S);
      last = now;
      twin.advance(dt, Date.now(), simulationSpeed, skipNight);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [twin, active]);
}

/** Load the Metro Manila network once, behind the loading screen; the bundled route leads it. */
function useNetwork() {
  const setNetwork = useApp((s) => s.setNetwork);
  useEffect(() => {
    let cancelled = false;
    setNetwork({ state: 'loading', routes: 0 });
    loadNetwork(defaultRoute(), (share) => {
      if (!cancelled) setNetwork({ state: 'loading', routes: 0, share });
    })
      .then(async (n) => {
        // With every gas station in Metro Manila, for drivers on any route.
        const fuel = await loadFuel().catch(() => false);
        if (!cancelled) setNetwork({ state: 'ready', routes: n.routes.length, fuel });
      })
      .catch(
        (err: unknown) =>
          !cancelled && setNetwork({ state: 'error', routes: 0, message: String(err) }),
      );
    return () => {
      cancelled = true;
    };
  }, [setNetwork]);
}

/** The ridden jeepney's camera feed, only while riding a simulated one. */
function RideCameraOverlay({
  container,
  feed,
}: {
  container: RefObject<HTMLElement | null>;
  feed: CameraFeed;
}) {
  const riding = useApp((s) => s.follow?.kind === 'sim');
  return riding ? <PipOverlay container={container} feed={feed} /> : null;
}

/** How often phones that have gone are taken off the map (ms). */
const GONE_CHECK_MS = 5000;
/** Phones heard are put on the map at most this often (ms). */
const SESSIONS_EVERY_MS = 500;

/**
 * Subscribe once to the transport and feed every phone update into the twin.
 * A session left behind by a phone that never said it stopped is not one:
 * nothing on the map stands for a vehicle that is no longer there.
 */
function useLiveTelemetry(twinRef: RefObject<TwinRuntime | null>) {
  const setTransport = useApp((s) => s.setTransport);
  const areas = useApp((s) => s.watchAreas);
  /** The area each phone heard was last in. */
  const areaOfPhone = useRef(new Map<string, string>());

  // Only the areas the view shows (WatchArea.tsx), listened to anew as they change.
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    // Phones no longer in view are off the map at once, not a minute later.
    const wanted = new Set(areas);
    const { sessions, mySessionId, dropSession } = useApp.getState();
    for (const id of Object.keys(sessions)) {
      const area = areaOfPhone.current.get(id);
      if (id === mySessionId || (area && wanted.has(area))) continue;
      twinRef.current?.live.delete(id);
      areaOfPhone.current.delete(id);
      dropSession(id);
    }
    // On the map at most SESSIONS_EVERY_MS apart: hundreds of phones are one change, not hundreds.
    const heard = new Map<string, SessionSummary>();
    const flush = window.setInterval(() => {
      if (heard.size === 0) return;
      useApp.getState().upsertSessions([...heard.values()]);
      heard.clear();
    }, SESSIONS_EVERY_MS);
    void getTransport().then((t) => {
      if (cancelled) return;
      setTransport(t.kind);
      if (areas.length === 0) return;
      unsubscribe = t.subscribe(areas, (update) => {
        const id = update.meta.sessionId;
        // This phone's own place is on its map already (useLocateMe).
        if (id === useApp.getState().mySessionId) return;
        if (phoneGone(update.fix.timestamp, Date.now())) return;
        twinRef.current?.ingest(update);
        areaOfPhone.current.set(id, areaOf(update));
        heard.set(id, { meta: update.meta, trip: update.trip, lastFixAt: update.fix.timestamp });
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
      window.clearInterval(flush);
    };
  }, [areas, twinRef, setTransport]);

  useEffect(() => {
    const sweep = window.setInterval(() => {
      const { sessions, dropSession } = useApp.getState();
      for (const [id, s] of Object.entries(sessions))
        if (phoneGone(s.lastFixAt, Date.now())) {
          twinRef.current?.live.delete(id);
          dropSession(id);
        }
    }, GONE_CHECK_MS);
    return () => window.clearInterval(sweep);
  }, [twinRef]);
}
