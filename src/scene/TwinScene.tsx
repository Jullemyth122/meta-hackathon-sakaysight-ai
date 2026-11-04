/**
 * The live digital twin: the 3D map, the route, the simulated fleet, and the
 * jeepneys driven by real phones.
 */

import { MapControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import { MOUSE, TOUCH } from 'three';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import { loadStreets } from '@/app/streets';
import { MAX_FRAME_DT_S } from '@/app/twinRuntime';
import { stationsFor, type FuelStation } from '@/core/fuel/stations';
import type { MapLabel } from '@/core/map/buildTile';
import type { LiveVehicle } from '@/core/tracking/liveVehicle';
import { CameraRig } from './CameraRig';
import { FRAME_ORDER } from './frameOrder';
import { MapTiles } from './map/MapTiles';
import { WarmInsets } from './doorway/PipRenderer';
import { Environment } from './world/Environment';
import { Fleet } from './world/Fleet';
import { brandColour, FuelStations } from './world/FuelStations';
import { useMapStations } from './world/useMapStations';
import { Labels, type SceneLabel } from './world/Labels';
import { LivePeople } from './world/LivePeople';
import { LiveVehicles } from './world/LiveVehicles';
import { WatchArea } from './world/WatchArea';
import { RouteLine } from './world/RouteLine';
import { Stops } from './world/Stops';
import { Zebras } from './world/Zebras';
import { CabinCameraFeed } from './world/CabinCameraFeed';
import { YourJeepneyLabel } from './world/YourJeepneyLabel';
import { RefuelLabels } from './world/RefuelLabels';
import { StationCars } from './world/StationCars';
import { viewArea } from '@/app/viewArea';
import { laneLine } from './world/lanes';
import { NetworkLayer } from './world/NetworkLayer';
import { IncomingCommuters } from './world/IncomingCommuters';
import { MyPlace } from './world/MyPlace';

/** Labels float above what they name: place names over rooftops, stop names over the pin. */
const PLACE_LABEL_Y = 30;
const STOP_LABEL_Y = 7.5;
/** Stops of one name this close (metres) are the one stop, each side of the road: one label. */
const SAME_STOP_M = 120;

const MAP_MOUSE = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
const ORBIT_MOUSE = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
const MAP_TOUCHES = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE };
const ORBIT_TOUCHES = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };

const AREA_LABELS = new Set(['suburb', 'quarter', 'town', 'city', 'village']);
const NO_STATIONS: readonly FuelStation[] = [];
/** The names still shown to a commuter on a trip: enough to know where they are. */
const BIG_PLACES = new Set(['city', 'town']);

const NO_PEOPLE: readonly LiveVehicle[] = [];

export function TwinScene() {
  const { twin } = useRuntimes();
  // In development only: the camera and controls, for checking the scene from scripts.
  const three = useThree();
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __commuteThree: three });
  }, [three]);
  const route = twin.route;
  const sessionIds = useApp((s) => Object.keys(s.sessions).join('|'));
  const mapState = useApp((s) => s.map.state);
  const networkReady = useApp((s) => s.network.state === 'ready');
  const follow = useApp((s) => s.follow);
  const tracked = useApp((s) => s.trackedRiderId);
  const speed = useApp((s) => s.simulationSpeed);
  const skipNight = useApp((s) => s.skipNight);
  const view = useApp((s) => s.view);
  const inScene = useApp((s) => s.demoScene !== null);
  const [placeLabels, setPlaceLabels] = useState<MapLabel[]>([]);
  const following = follow !== null || tracked !== null;
  // Re-placed when Metro Manila's stations arrive (they cover every route).
  const fuelLoaded = useApp((s) => s.network.fuel === true);
  const stations = useMemo(() => stationsFor(route), [route, fuelLoaded]);
  // All of them for the operator; only those near a driver's jeepney for them;
  // none for a commuter, who has no use for them.
  const fuel = useMapStations(twin, view === 'commuter' ? NO_STATIONS : stations);

  const liveEntries = useMemo(
    () =>
      sessionIds
        .split('|')
        .filter(Boolean)
        .map((id) => ({ id, vehicle: twin.live.get(id) }))
        .filter((e): e is { id: string; vehicle: LiveVehicle } => !!e.vehicle),
    [sessionIds, twin],
  );
  const isPerson = (id: string) => useApp.getState().sessions[id]?.meta.role === 'commuter';
  const onRoad = useMemo(() => liveEntries.filter((e) => !isPerson(e.id)), [liveEntries]);
  const livePeople = useMemo(
    () => liveEntries.filter((e) => isPerson(e.id)).map((e) => e.vehicle),
    [liveEntries],
  );
  const liveVehicles = useMemo(() => onRoad.map((e) => e.vehicle), [onRoad]);
  const liveIds = useMemo(() => onRoad.map((e) => e.id), [onRoad]);
  const liveKinds = useMemo(
    () => onRoad.map((e) => useApp.getState().sessions[e.id]?.meta.vehicleKind ?? 'jeepney'),
    [onRoad],
  );

  // A commuter on a trip sees that trip's labels (TripPlanLayer.tsx), not the route's.
  const onTrip = useApp((s) => view === 'commuter' && !!(s.tripPreview ?? s.tripLegs));
  const labels = useMemo<SceneLabel[]>(() => {
    const stops: SceneLabel[] = [];
    for (const stop of onTrip ? [] : route.stops) {
      const p = route.polyline.pointAt(stop.s);
      const x = p.x + Math.sin(p.heading) * 8;
      const z = p.z + Math.cos(p.heading) * 8;
      // The same stop across the road (a loop's other way): one name, between the two.
      const same = stops.find(
        (l) => l.text === stop.name && Math.hypot(l.x - x, l.z - z) < SAME_STOP_M,
      );
      if (same) {
        same.x = (same.x + x) / 2;
        same.z = (same.z + z) / 2;
        continue;
      }
      stops.push({
        text: stop.name,
        kind: stop.terminal ? 'terminal' : 'stop',
        x,
        y: STOP_LABEL_Y,
        z,
        scaleWithView: true,
      });
    }
    const places = placeLabels
      .filter((l) => !onTrip || BIG_PLACES.has(l.kind))
      .map((l) => ({ ...l, y: PLACE_LABEL_Y }));
    // A driver's stations across the road are shown, faded: no U-turns.
    const gas = fuel.shown.map((st) => {
      const across = fuel.across?.has(st.id) ?? false;
      return {
        text: across ? `⛽ ${st.brand} · across` : `⛽ ${st.brand}`,
        farText: '⛽',
        tone: brandColour(st.brand),
        kind: across ? 'fuel-across' : 'fuel',
        x: st.at.x,
        y: STOP_LABEL_Y,
        z: st.at.z,
      };
    });
    return [...places, ...gas, ...stops];
  }, [route, placeLabels, fuel, onTrip]);

  useFrame(
    (_, dt) => twin.advance(Math.min(dt, MAX_FRAME_DT_S), Date.now(), speed, skipNight),
    FRAME_ORDER.simulation,
  );

  // The side streets around the stops, where riders come from and go to (with the map on).
  const mapOn = mapState !== 'off';
  useEffect(() => (mapOn ? loadStreets(twin) : undefined), [twin, mapOn]);

  // Draw our own road only when there is no map underneath to provide one.
  const mapShowsRoads = route.projection !== null && mapState !== 'off' && mapState !== 'error';
  // The route band lies on the lane its vehicles drive in.
  const lane = useMemo(() => laneLine(route), [route]);
  // The side panel names the place in view from the map's own labels.
  useEffect(() => {
    viewArea.labels = placeLabels.filter((l) => AREA_LABELS.has(l.kind));
  }, [placeLabels]);

  return (
    <>
      <Environment hourOf={() => twin.fleet.timeOfDay / 3600} />
      <MapControls
        makeDefault
        enabled={follow?.view !== 'inside'}
        enableDamping={follow?.view !== 'inside'}
        maxPolarAngle={following ? Math.PI / 2.02 : Math.PI / 2.15}
        minDistance={follow?.view === 'pov' ? 0.08 : following ? 0.35 : 2}
        maxDistance={follow?.view === 'pov' ? 0.45 : following ? 9_000 : 40_000}
        zoomToCursor={!following}
        mouseButtons={following ? ORBIT_MOUSE : MAP_MOUSE}
        touches={following ? ORBIT_TOUCHES : MAP_TOUCHES}
      />
      <CameraRig />
      {route.projection && <MapTiles route={route} onLabels={setPlaceLabels} />}
      <RouteLine line={lane} withRoad={!mapShowsRoads} />
      <FuelStations route={route} stations={fuel.shown} />
      <Stops fleet={twin.fleet} crew={twin.crew} />
      <Zebras crew={twin.crew} />
      <IncomingCommuters />
      <MyPlace />
      <Fleet fleet={twin.fleet} crew={twin.crew} />
      <StationCars fleet={twin.fleet} />
      <WatchArea twin={twin} />
      <LiveVehicles vehicles={liveVehicles} ids={liveIds} kinds={liveKinds} />
      <LivePeople
        people={view === 'twin' ? livePeople : NO_PEOPLE}
        showYou={view === 'commuter' && !inScene}
      />
      <NetworkLayer />
      {/* Map labels would show through the cabin walls from inside. */}
      <Labels labels={labels} hidden={follow?.view === 'inside' || follow?.view === 'pov'} />
      {follow?.kind === 'sim' && <CabinCameraFeed index={follow.index} />}
      <WarmInsets ready={networkReady} />
      {view === 'commuter' && <YourJeepneyLabel twin={twin} />}
      {view !== 'commuter' && (
        <RefuelLabels twin={twin} hidden={follow?.view === 'inside' || follow?.view === 'pov'} />
      )}
    </>
  );
}
