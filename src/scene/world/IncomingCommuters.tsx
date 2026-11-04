import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import { heldPlate } from '@/app/fleetBoard';
import { twinState } from '@/app/twinState';
import { areaCentre } from '@/core/people/stopLayout';
import { INCOMING_RADIUS_M } from '@/core/advisory/approach';
import { useTicker } from '@/ui/useTicker';
import { Labels, type SceneLabel } from './Labels';
import { approachTime, incomingMapData } from './incomingMap';
import '@/styles/incoming.scss';

/** At most this many "going home" labels at once, to keep the map readable… */
const GOING_HOME_LABELS = 16;
/** …and of tricycles still beyond the stops' 500 m. */
const FAR_TRICYCLE_LABELS = 12;

/** Stop demand and anonymous first-mile arrivals, refreshed without per-frame React work. */
export function IncomingCommuters() {
  useTicker(2);
  const { twin } = useRuntimes();
  const view = useApp((s) => s.view);
  const vehicle = useApp((s) => s.driverVehicle);
  const query = useApp((s) => s.commuter);
  const inside = useApp((s) => s.follow?.view === 'inside');
  if (view !== 'twin' && view !== 'driver' && view !== 'commuter') return null;
  const state = twinState(twin);
  const audience =
    view === 'driver' ? { view, vehicle } : view === 'commuter' ? { view, query } : { view };
  const data = incomingMapData(state, audience).slice(0, 24);
  const people = new Map(state.passengers.map((p) => [p.id, p]));
  // A commuter wants their own way, not how busy each stop is.
  const labels: SceneLabel[] = (view === 'commuter' ? [] : data).map((entry) => {
    const at = areaCentre(state.route, entry.stop, entry.direction);
    return {
      ...at,
      y: 3,
      kind: 'demand-stop',
      text: `${entry.waiting} waiting · ${entry.incoming.length} approaching`,
    };
  });
  // Stop totals remain complete; only individual labels are capped to keep the map readable.
  const markers = data
    .flatMap((entry) => entry.markers)
    .sort((a, b) => a.etaS - b.etaS)
    .slice(0, 24);
  for (const arrival of markers) {
    const person = people.get(arrival.passenger);
    if (!person) continue;
    labels.push({
      x: person.x,
      y: 3,
      z: person.z,
      kind: 'incoming-rider',
      text: `${view === 'commuter' ? 'You · ' : ''}${arrival.mode === 'tricycle' ? 'Tricycle' : 'Walking'} · ${Math.round(arrival.distanceM)} m · ${approachTime(arrival.etaS)}`,
    });
  }
  // The driver sees who is waving them down by the road, away from any stop:
  // one label for each group standing together, by the road or a side street.
  if (view === 'driver') {
    const groups = new Map<
      number,
      { x: number; z: number; n: number; street: boolean; heldFor: string | null }
    >();
    for (const p of state.passengers) {
      if (p.flagS === undefined || p.phase !== 'waiting') continue;
      const g = groups.get(p.flagS);
      if (g) g.n++;
      else
        groups.set(p.flagS, {
          x: p.x,
          z: p.z,
          n: 1,
          street: !!p.byStreet,
          // Asked for first by another driver (the fleet board): theirs for now.
          heldFor: p.byStreet ? heldPlate(twin, p.id) : null,
        });
    }
    for (const g of groups.values())
      labels.push({
        x: g.x,
        y: 3,
        z: g.z,
        kind: 'incoming-rider',
        text: `${g.n === 1 ? 'Waiting' : `${g.n} waiting`} ${g.street ? 'on the side street' : 'by the road'}${g.heldFor ? ` · held for ${g.heldFor}` : ''}`,
      });
  }
  // The operator also sees tricycles bringing people from further out than the stops' 500 m.
  if (view === 'twin') {
    const far: Array<{ x: number; z: number; m: number; s: number }> = [];
    twin.crew.forEachOutside((r) => {
      if (r.phase !== 'approaching' || r.approachMode !== 'tricycle' || !r.motion) return;
      const m = r.motion.remainingDistance(r.t);
      if (m > INCOMING_RADIUS_M)
        far.push({ x: r.pose.x, z: r.pose.z, m, s: r.motion.duration - r.t });
    });
    for (const f of far.sort((a, b) => b.m - a.m).slice(0, FAR_TRICYCLE_LABELS))
      labels.push({
        x: f.x,
        y: 3,
        z: f.z,
        kind: 'incoming-rider',
        text: `Tricycle · ${(f.m / 1000).toFixed(1)} km · ${approachTime(f.s)}`,
      });
  }
  // The operator also sees people on their way home from the jeepney, along the side streets.
  if (view === 'twin') {
    const home: Array<{ x: number; z: number; m: number; tricycle: boolean }> = [];
    twin.crew.forEachOutside((r) => {
      if (r.tour !== 'back' || r.phase !== 'walking' || !r.motion) return;
      const m = r.motion.remainingDistance(r.t);
      if (m > 10) home.push({ x: r.pose.x, z: r.pose.z, m, tricycle: r.leaveMode === 'tricycle' });
    });
    for (const h of home.sort((a, b) => b.m - a.m).slice(0, GOING_HOME_LABELS))
      labels.push({
        x: h.x,
        y: 3,
        z: h.z,
        kind: 'going-home',
        text: `Going home${h.tricycle ? ' · tricycle' : ''} · ${Math.round(h.m)} m`,
      });
  }
  return <Labels labels={labels} hidden={inside} />;
}
