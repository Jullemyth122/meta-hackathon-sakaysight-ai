/**
 * The 3D map: OpenStreetMap land use, water, roads and extruded buildings,
 * streamed as vector tiles around wherever the camera looks, anywhere in
 * Metro Manila, and built in Web Workers (map/tileStreamer.ts).
 *
 * Which tiles, and how far, depends on the view (core/map/tileView.ts): the
 * driver gets about their screen's horizon, the commuter their neighbourhood,
 * the operator as far as they zoom out, with coarse tiles (no buildings)
 * beyond the detailed ones. Tiles the view has left are dropped, farthest
 * first, once over budget, so a long pan never grows memory.
 *
 * Cost: ≤ 5 draw calls per tile, tiles off screen are frustum-culled, and
 * nothing changes per frame except twice a second, when the wanted set is
 * worked out.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Group, Mesh, MeshLambertMaterial, Sphere, Vector3, type Material } from 'three';
import { useApp } from '@/app/store';
import { config } from '@/config';
import { stationClearancePaths } from '@/core/fuel/stations';
import { stopClearancePaths } from '@/core/people/stopLayout';
import type { Route } from '@/core/geo/routes';
import { FLAT_LAYERS, type MapLabel, type TileMeshes } from '@/core/map/buildTile';
import { tileKey, tileToLngLat, type TileId } from '@/core/map/tiles';
import { NEAR_BUDGET, NEAR_ZOOM, wantedTiles, type MapView } from '@/core/map/tileView';
import { TileStreamer } from '@/map/tileStreamer';
import { FLAT_ORDER, flatMapMaterial, MAP_LAYER, toGeometry } from './flatLayers';

const REFRESH_S = 0.5;
/** Tiles kept beyond the wanted set before the farthest are dropped (no flicker panning back). */
const SLACK = 6;
/**
 * Coarse tiles paint over the ground (−100) but under every detailed layer
 * (−90 and up): their layers squeezed, in the same order, into −99…−96.
 */
const farOrder = (order: number) => FLAT_ORDER.ground + (order - FLAT_ORDER.ground) / 10;
/** The focused route's buildings clearance only matters this close to it (metres). */
const CLEARANCE_MARGIN_M = 300;
/** A detailed tile within this of the route is built again for it (metres, from its centre). */
const REBUILD_WITHIN_M = 1700;
/** The route looked at every this many metres, for that. */
const REBUILD_SAMPLE_M = 250;
/** Metres round the Earth, and how far a tile's contents reach from its centre, in tile widths. */
const EARTH_M = 40_075_000;
const TILE_REACH = 0.85;
/** Lane lines show from this high down (metres): above it they are thinner than a pixel. */
const LANE_LINES_BELOW_M = 700;

interface Loaded {
  meshes: Mesh[];
  /** Its lane lines, shown only close to the ground. */
  lanes: Mesh | null;
  labels: MapLabel[];
  near: boolean;
  /** Built for another route: shown until its new one replaces it. */
  stale?: boolean;
  /** Tile centre in scene metres, for dropping the farthest first. */
  x: number;
  z: number;
}

export function MapTiles({
  route,
  onLabels,
}: {
  route: Route;
  onLabels: (labels: MapLabel[]) => void;
}) {
  const setMap = useApp((s) => s.setMap);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: Vector3 } | null;
  const group = useMemo(() => new Group(), []);
  const materials = useMemo(
    () =>
      ({
        ...Object.fromEntries(FLAT_LAYERS.map((l) => [l, flatMapMaterial()])),
        // Coarse tiles have their own flat materials: render order is per mesh,
        // but sharing would let a detailed layer's state leak into them.
        ...Object.fromEntries(FLAT_LAYERS.map((l) => [`far-${l}`, flatMapMaterial()])),
        buildings: new MeshLambertMaterial({ vertexColors: true }),
      }) as Record<string, Material>,
    [],
  );
  const loaded = useRef(new Map<string, Loaded>());
  const streamer = useRef<TileStreamer | null>(null);
  const since = useRef(Infinity);
  const labelsDirty = useRef(false);
  const failures = useRef(0);
  const projection = route.projection;
  const originKey = projection ? `${projection.origin.lat},${projection.origin.lng}` : '';

  useEffect(() => () => Object.values(materials).forEach((m) => m.dispose()), [materials]);
  useEffect(() => {
    camera.layers.enable(MAP_LAYER);
  }, [camera]);

  const remove = (key: string) => {
    const entry = loaded.current.get(key);
    if (!entry) return;
    for (const m of entry.meshes) {
      m.geometry.dispose();
      group.remove(m);
    }
    loaded.current.delete(key);
    labelsDirty.current = true;
  };

  // The streamer lives as long as the scene origin (the same for every route
  // of the network, so focusing another route keeps the map).
  useEffect(() => {
    if (!projection || config.mapTiles === 'off') {
      setMap({ state: 'off', loaded: 0, total: 0 });
      return;
    }
    const all = loaded.current;
    const s = new TileStreamer(
      projection.origin,
      (key, t: TileMeshes) => {
        const near = t.tile.z === NEAR_ZOOM;
        remove(key); // the one it replaces, if any
        const c = projection.toLocal(tileToLngLat(t.tile.x + 0.5, t.tile.y + 0.5, t.tile.z));
        const meshes: Mesh[] = [];
        let lanes: Mesh | null = null;
        for (const [layer, data] of Object.entries(t.layers)) {
          if (!data || (!near && layer === 'buildings')) continue;
          const material = materials[near || layer === 'buildings' ? layer : `far-${layer}`]!;
          const reach = (EARTH_M / 2 ** t.tile.z) * TILE_REACH;
          const mesh = new Mesh(
            toGeometry(data, new Sphere(new Vector3(c.x, 0, c.z), reach)),
            material,
          );
          mesh.matrixAutoUpdate = false; // static: never re-derive its matrix
          mesh.layers.set(MAP_LAYER);
          // Buildings neither cast nor take shadows: the sun's 160 m box would
          // draw the whole city again for them, and shadows that end at its edge.
          if (layer !== 'buildings') {
            const order = FLAT_ORDER[layer as keyof typeof FLAT_ORDER];
            mesh.renderOrder = near ? order : farOrder(order);
            mesh.receiveShadow = near;
          }
          if (layer === 'laneLines') {
            lanes = mesh;
            mesh.visible = camera.position.y < LANE_LINES_BELOW_M;
          }
          group.add(mesh);
          meshes.push(mesh);
        }
        all.set(key, { meshes, lanes, labels: t.labels, near, x: c.x, z: c.z });
        labelsDirty.current = true;
      },
      (key, error) => {
        failures.current++;
        console.warn('Map tile failed:', key, error);
      },
    );
    streamer.current = s;
    since.current = Infinity;
    return () => {
      s.dispose();
      streamer.current = null;
      for (const key of [...all.keys()]) remove(key);
      onLabels([]);
    };
    // Keyed on the origin's value, not the object (each route has its own copy).
  }, [originKey, group, materials, setMap, onLabels]);

  // A newly focused route needs its stop areas cleared of buildings: the
  // detailed tiles near it are rebuilt, each shown until its new one arrives.
  const bounds = useMemo(() => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of route.polyline.points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const m = CLEARANCE_MARGIN_M;
    return { minX: minX - m, maxX: maxX + m, minZ: minZ - m, maxZ: maxZ + m };
  }, [route]);
  const clearance = useMemo(
    () => [...stopClearancePaths(route), ...stationClearancePaths(route)],
    [route],
  );
  useEffect(() => {
    const line = route.polyline;
    const along = Array.from({ length: Math.ceil(line.length / REBUILD_SAMPLE_M) }, (_, i) =>
      line.pointAt(i * REBUILD_SAMPLE_M),
    );
    for (const entry of loaded.current.values())
      if (
        entry.near &&
        along.some((p) => Math.hypot(p.x - entry.x, p.z - entry.z) < REBUILD_WITHIN_M)
      )
        entry.stale = true;
    since.current = Infinity;
    // Only when the route changes.
  }, [route]);

  useFrame((_, dt) => {
    since.current += dt;
    if (since.current < REFRESH_S) return;
    since.current = 0;
    const low = camera.position.y < LANE_LINES_BELOW_M;
    for (const tile of loaded.current.values()) if (tile.lanes) tile.lanes.visible = low;
    const s = streamer.current;
    if (!s || !projection) return;
    const view = useApp.getState().view;
    const mapView: MapView =
      view === 'driver' ? 'driver' : view === 'commuter' ? 'commuter' : 'twin';
    const target = controls?.target ?? new Vector3();
    const { near, far } = wantedTiles(
      projection.toGeo({ x: target.x, z: target.z }),
      mapView,
      Math.max(1, camera.position.y),
    );

    // Drop what the view has left, farthest first, once over budget (+ slack).
    const wanted = new Set([...near, ...far].map(tileKey));
    const stale = [...loaded.current]
      .filter(([key]) => !wanted.has(key))
      .sort(
        (a, b) =>
          Math.hypot(b[1].x - target.x, b[1].z - target.z) -
          Math.hypot(a[1].x - target.x, a[1].z - target.z),
      );
    const nearCount = [...loaded.current.values()].filter((e) => e.near).length;
    let excess = Math.max(0, nearCount - NEAR_BUDGET - SLACK);
    for (const [key, entry] of stale) {
      if (entry.near && excess > 0) {
        remove(key);
        excess--;
      } else if (!entry.near && far.length === 0) remove(key); // zoomed back in: no coarse map
    }

    const job = (tile: TileId) => {
      const c = projection.toLocal(tileToLngLat(tile.x + 0.5, tile.y + 0.5, tile.z));
      const touches =
        tile.z === NEAR_ZOOM &&
        c.x > bounds.minX - 1300 &&
        c.x < bounds.maxX + 1300 &&
        c.z > bounds.minZ - 1300 &&
        c.z < bounds.maxZ + 1300;
      return {
        tile,
        route: touches ? route.polyline.points : [],
        pedestrianAreas: touches ? clearance : [],
      };
    };
    s.want(
      [...near, ...far]
        .filter((t) => {
          const have = loaded.current.get(tileKey(t));
          return !have || have.stale;
        })
        .map(job),
    );

    if (labelsDirty.current) {
      labelsDirty.current = false;
      onLabels([...loaded.current.values()].flatMap((e) => e.labels));
    }
    const have = [...wanted].filter((k) => loaded.current.has(k)).length;
    const state =
      have === wanted.size ? 'ready' : have === 0 && failures.current > 0 ? 'error' : 'loading';
    const status = useApp.getState().map;
    if (status.state !== state || status.loaded !== have || status.total !== wanted.size)
      setMap({ state, loaded: have, total: wanted.size });
  });

  return <primitive object={group} />;
}
