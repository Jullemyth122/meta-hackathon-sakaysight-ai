/**
 * The Metro Manila jeepney network: every route of the DOTC GTFS feed as a
 * loop on the road (scripts/build-network.mjs), in the same scene metres as
 * the bundled Tungko route, so one map holds them all.
 *
 * Only one route at a time is simulated in full (people boarding, the
 * driver and commuter apps, the AI): the focused one. The rest run as flows
 * (flow.ts). This file turns the network file into Routes and finds stops
 * near a point.
 */

import { Polyline } from '../geo/polyline';
import type { LatLng, LocalPoint, Projection } from '../geo/projection';
import { kerbsAlong, smoothRoute, type Route, type Stop } from '../geo/routes';
import { removeSpurs } from './spurs';

/** Spur-cutting passes over a route's path (each can bare a spur the last one hid). */
const SPUR_PASSES = 4;

/** One route as written by scripts/build-network.mjs. */
export interface NetworkRouteFile {
  id: string;
  name: string;
  from: string;
  to: string;
  /** Loop length, metres. */
  length: number;
  /** Road length over stop-to-stop distance (one-way grids push it up too). */
  detour: number;
  /**
   * Share of the path that wanders between stops (e.g. to a U-turn slot on
   * the wrong carriageway): the quality check. Older files lack it.
   */
  wander?: number;
  /** Typical time between jeepneys, seconds (GTFS frequencies). */
  headwayS: number;
  /** Encoded polyline (precision 1e6) of the loop, closing on itself. */
  path: string;
  /** [name, metres along the loop], in running order. */
  stops: Array<[string, number]>;
  /** Stops in the GTFS feed for the loop; fewer placed means the path missed them. */
  stopsTotal?: number;
  /** Indices into stops of the two terminals (the start, and where the way back starts). */
  terminals: [number, number];
  /** How many vehicles it has, once planned (core/network/fleetSize.ts). */
  fleet?: number;
  /** Left out of the network, and why (kept in the file to bring back). */
  hidden?: string;
  /** A bus or UV Express route (its own terminals and fleet); absent, a jeepney route. */
  kind?: 'bus' | 'uv';
  /**
   * The road under each stretch of the loop, [metres along, class, one-way
   * 1/0], so its kerbs line up with the map's roads (corridor routes only).
   */
  roads?: Array<[number, string, number]>;
  /** Where the route comes from when not the GTFS feed (scripts/add-corridor-routes.mjs). */
  source?: string;
}

export interface NetworkFile {
  origin: LatLng;
  source: string;
  /** Routes in the GTFS feed; only those whose paths fit their stops are in `routes`. */
  routesInFeed?: number;
  /** Paths already cleaned of spurs (scripts/despur-network.mjs): nothing to do on load. */
  spursRemoved?: boolean;
  routes: NetworkRouteFile[];
}

/** A route of the network, ready for the twin. */
export interface NetworkRoute {
  route: Route;
  meta: NetworkRouteFile;
}

/** Decode an encoded polyline at precision 1e6. */
export function decodePath(encoded: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lng += next();
    out.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return out;
}

/** Encode points as a polyline at precision 1e6 (the network file's format). */
export function encodePath(points: readonly LatLng[]): string {
  let out = '';
  let pLat = 0;
  let pLng = 0;
  const num = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const { lat, lng } of points) {
    const la = Math.round(lat * 1e6);
    const ln = Math.round(lng * 1e6);
    out += num(la - pLat) + num(ln - pLng);
    pLat = la;
    pLng = ln;
  }
  return out;
}

/**
 * How people say a GTFS stop: "Quirino Highway / La Mesa Road Intersection,
 * Caloocan City" is "Quirino Highway / La Mesa Road".
 */
export function shortStopName(name: string): string {
  return name
    .split(',')[0]!
    .replace(/\s+Intersection$/i, '')
    .trim();
}

/** "HULO - P. VICTORINO/KALENTONG" → "Hulo - P. Victorino/Kalentong"; mixed case is kept. */
export function routeTitle(name: string): string {
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .replace(/(^|[\s/(-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
}

/** A far terminal this close to where the road turns round is right (metres)… */
const FAR_TERMINAL_KEEP_M = 1000;
/** …else the stop this close to the turn becomes it; failing that, a new stop there. */
const FAR_TERMINAL_SNAP_M = 300;

/**
 * Put a loop's far terminal where its road turns round: the point of the
 * path farthest from the start terminal (stops[0], at s = 0).
 *
 * The network build matched the far terminal by the name of the first stop
 * of the way back, but the feed reuses names: Novaliches – Tala's "City of
 * San Jose del Monte" matched a stop on Quirino Highway by SM Fairview, 19 km
 * short of the turn, so its jeepneys lined up and parked there and drove the
 * real end without stopping. In place: `stops` keeps running order.
 */
export function placeFarTerminal(stops: Stop[], line: Polyline, endName: string): void {
  const start = line.pointAt(0);
  let turnS = 0;
  let farthest = -1;
  line.points.forEach((p, i) => {
    const d = Math.hypot(p.x - start.x, p.z - start.z);
    if (d > farthest) {
      farthest = d;
      turnS = line.cumulative[i]!;
    }
  });
  const turn = line.pointAt(turnS);
  const offTurn = (st: Stop) => {
    const p = line.pointAt(st.s);
    return Math.hypot(p.x - turn.x, p.z - turn.z);
  };
  const listed = stops.findIndex((st, i) => i > 0 && st.terminal);
  if (listed > 0 && offTurn(stops[listed]!) <= FAR_TERMINAL_KEEP_M) return;
  if (listed > 0) delete stops[listed]!.terminal;
  let nearest = -1;
  for (let i = 1; i < stops.length; i++)
    if (nearest < 0 || offTurn(stops[i]!) < offTurn(stops[nearest]!)) nearest = i;
  if (nearest > 0 && offTurn(stops[nearest]!) <= FAR_TERMINAL_SNAP_M) {
    stops[nearest]!.terminal = true;
    return;
  }
  const at = stops.findIndex((st) => st.s > turnS);
  stops.splice(at < 0 ? stops.length : at, 0, { name: endName, s: turnS, terminal: true });
}

/**
 * A network route as a loop Route in the shared scene projection, its road
 * path cleaned of the router's out-and-back spurs (see spurs.ts) unless the
 * file says that was done already.
 */
/** The file's path as drawn on the road, closed and with its spurs cut; stops in metres along it. */
function cleanPath(meta: NetworkRouteFile, projection: Projection, clean: boolean) {
  const raw: LocalPoint[] = decodePath(meta.path).map((p) => projection.toLocal(p));
  const first = raw[0]!;
  const last = raw[raw.length - 1]!;
  // A loop must close exactly, so driving off its end continues at its start.
  if (Math.hypot(first.x - last.x, first.z - last.z) > 0.5) raw.push({ ...first });
  // Cutting one spur can bare another next to it: again until none is left.
  let path = { points: raw, stopS: meta.stops.map(([, s]) => s), spurs: clean ? 1 : 0 };
  for (let pass = 0; pass < SPUR_PASSES && path.spurs > 0; pass++) {
    const terminalS = meta.terminals.map((i) => path.stopS[i] ?? 0);
    path = removeSpurs(path.points, path.stopS, terminalS);
  }
  return path;
}

/** The line a route's `roads` are measured along. */
export function routeLine(meta: NetworkRouteFile, projection: Projection): Polyline {
  return new Polyline(cleanPath(meta, projection, true).points);
}

export function networkRoute(meta: NetworkRouteFile, projection: Projection, clean = true): Route {
  const path = cleanPath(meta, projection, clean);
  const drawn = new Polyline(path.points);
  // Corners into curves; stops and kerbs follow onto the new line.
  const { polyline, kerbs, toSmooth } = smoothRoute(
    drawn,
    true,
    meta.roads?.length ? kerbsAlong(drawn, meta.roads) : undefined,
  );
  const L = polyline.length;
  const terminals = new Set(meta.terminals);
  const stops: Stop[] = meta.stops.map(([name], i) => ({
    name: shortStopName(name),
    s: Math.min(Math.max(0, toSmooth(path.stopS[i]!)), L - 1),
    ...(terminals.has(i) && { terminal: true }),
  }));
  stops[0]!.s = 0; // the loop starts at its first terminal
  placeFarTerminal(stops, polyline, shortStopName(meta.to));
  // "Towards" the next terminal, as on the Tungko route.
  stops.forEach((st, i) => {
    for (let k = 1; k <= stops.length; k++) {
      const next = stops[(i + k) % stops.length]!;
      if (next.terminal) {
        st.towards = next.name;
        break;
      }
    }
  });
  return {
    id: meta.id,
    name: routeTitle(meta.name),
    source: 'osm',
    polyline,
    loop: true,
    ...(meta.kind && { kind: meta.kind }),
    stops,
    stopsSource: 'gtfs',
    projection,
    ...(kerbs && { kerbs }),
    note:
      'Stops from the DOTC GTFS feed (2015); road path by OSRM on OpenStreetMap. ' +
      'Routes may have changed since; verify by riding.',
  };
}

/** A stop of some route, at a point in the scene. */
export interface NetworkStop {
  route: number;
  stop: number;
  x: number;
  z: number;
}

/** Grid cell size for finding stops near a point (metres). */
const CELL_M = 250;

/** Every stop of every route, findable by position. */
export class StopIndex {
  private readonly cells = new Map<string, NetworkStop[]>();

  constructor(routes: readonly Route[]) {
    routes.forEach((route, r) =>
      route.stops.forEach((st, i) => {
        const p = route.polyline.pointAt(st.s);
        const entry = { route: r, stop: i, x: p.x, z: p.z };
        const key = this.key(p.x, p.z);
        const list = this.cells.get(key);
        if (list) list.push(entry);
        else this.cells.set(key, [entry]);
      }),
    );
  }

  private key(x: number, z: number): string {
    return `${Math.floor(x / CELL_M)},${Math.floor(z / CELL_M)}`;
  }

  /** Stops within `radiusM` of `p`, nearest first. */
  near(p: LocalPoint, radiusM: number): Array<NetworkStop & { distanceM: number }> {
    const out: Array<NetworkStop & { distanceM: number }> = [];
    const r = Math.ceil(radiusM / CELL_M);
    const cx = Math.floor(p.x / CELL_M);
    const cz = Math.floor(p.z / CELL_M);
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++)
        for (const st of this.cells.get(`${cx + dx},${cz + dz}`) ?? []) {
          const d = Math.hypot(st.x - p.x, st.z - p.z);
          if (d <= radiusM) out.push({ ...st, distanceM: d });
        }
    return out.sort((a, b) => a.distanceM - b.distanceM);
  }
}

/** The loaded network: its routes (the Tungko route first) and a stop index. */
export interface Network {
  routes: NetworkRoute[];
  stops: StopIndex;
  source: string;
  /** Jeepney routes in the GTFS feed, of which these are the ones shown. */
  routesInFeed: number;
}

/**
 * Routes whose road path wanders between stops (OSRM routed round a stop on
 * the wrong road or carriageway) are left out rather than drawn wrong, and
 * so are routes whose path missed many of their stops.
 */
export const MAX_WANDER = 0.2;
export const MIN_STOPS_PLACED = 0.7;
/** For files written before the wander measure. */
export const MAX_DETOUR = 2.2;

/** Whether a route's path is good enough to show. */
export function trustworthy(m: NetworkRouteFile): boolean {
  const shape = m.wander !== undefined ? m.wander <= MAX_WANDER : m.detour <= MAX_DETOUR;
  return (
    shape &&
    m.stops.length >= 2 &&
    m.stops.length >= MIN_STOPS_PLACED * (m.stopsTotal ?? m.stops.length)
  );
}

/** The file's routes to show. */
export const shownRoutes = (file: NetworkFile) =>
  file.routes.filter((m) => !m.hidden && trustworthy(m));

export function buildNetwork(file: NetworkFile, projection: Projection, first?: Route): Network {
  return networkOf(
    file,
    shownRoutes(file).map((meta) => ({
      meta,
      route: networkRoute(meta, projection, !file.spursRemoved),
    })),
    first,
  );
}

/** The network of `routes`, each built from `file` (the app builds them a few at a time). */
export function networkOf(file: NetworkFile, routes: NetworkRoute[], first?: Route): Network {
  if (first) {
    routes.unshift({
      route: first,
      meta: {
        id: first.id,
        name: first.name,
        from: first.stops[0]?.name ?? '',
        to: first.stops.find((s, i) => i > 0 && s.terminal)?.name ?? '',
        length: Math.round(first.polyline.length),
        detour: 1,
        // One about every minute (a regular rider's field estimate; see FIELD_SCENARIO).
        headwayS: 60,
        path: '',
        stops: first.stops.map((s) => [s.name, s.s]),
        terminals: [
          0,
          Math.max(
            0,
            first.stops.findIndex((s, i) => i > 0 && s.terminal),
          ),
        ],
      },
    });
  }
  return {
    routes,
    stops: new StopIndex(routes.map((r) => r.route)),
    source: file.source,
    routesInFeed: file.routesInFeed ?? file.routes.length,
  };
}
