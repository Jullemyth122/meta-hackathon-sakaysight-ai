/**
 * One Mapbox Vector Tile (OpenMapTiles schema) -> meshes in local metres.
 *
 * Runs in a Web Worker (src/map/tileWorker.ts): decoding and triangulating a
 * dense tile takes tens of milliseconds, which would otherwise stutter the 3D
 * view. Pure function of its inputs, so it is also testable in Node.
 */

import { classifyRings, VectorTile, type VectorTileLayer } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { createProjection, type LatLng, type LocalPoint } from '../geo/projection';
import { MeshBuilder, type MeshData } from './meshBuilder';
import { RoadClearance } from './roadClearance';
import {
  AREA_PRIORITY,
  areaColor,
  buildingColors,
  BUILDING_ROAD_CLEARANCE_M,
  CASING_EXTRA_M,
  DEFAULT_BUILDING_HEIGHT_M,
  LABEL_PLACES,
  RAIL,
  RAIL_CLASSES,
  ROAD_ORDER,
  landmarkKind,
  ROAD_LABELS,
  roadClass,
  roadWidth,
  LANE_DASH,
  LANE_LINE,
  laneLines,
  STREET_LINE,
  ROADS,
  ROUTE_ROAD_WIDTH_M,
  WATER,
  WATERWAY_WIDTH,
} from './style';
import { tileToLocal, type TileId } from './tiles';

const LANE_LINES_FROM_ZOOM = 14;
/** Named on a tile at most: the most important landmarks, and the longest side streets (main roads all). */
const LANDMARKS_PER_TILE = 40;
const STREETS_PER_TILE = 30;
/** A street shorter than this in a tile is not named there (metres). */
const LABELLED_STREET_M = 60;

/** Flat layers are drawn in this order, then buildings. */
export const FLAT_LAYERS = ['areas', 'water', 'roadCasing', 'roadFill', 'laneLines'] as const;
export type MapLayer = (typeof FLAT_LAYERS)[number] | 'buildings';

export interface MapLabel {
  text: string;
  kind: string;
  x: number;
  z: number;
}

export interface TileMeshes {
  tile: TileId;
  layers: Partial<Record<MapLayer, MeshData>>;
  labels: MapLabel[];
}

const enum GeomType {
  Point = 1,
  Line = 2,
  Polygon = 3,
}

type Rings = LocalPoint[][];

/** `line` moved `offset` metres to its right, keeping its shape. */
function offsetLine(line: readonly LocalPoint[], offset: number): LocalPoint[] {
  if (offset === 0) return [...line];
  return line.map((p, i) => {
    const a = line[Math.max(0, i - 1)]!;
    const b = line[Math.min(line.length - 1, i + 1)]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: p.x - (dz / len) * offset, z: p.z + (dx / len) * offset };
  });
}

/** `line` cut into dashes (LANE_DASH). */
function dashes(line: readonly LocalPoint[]): LocalPoint[][] {
  const out: LocalPoint[][] = [];
  const period = LANE_DASH.on + LANE_DASH.off;
  let walked = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len === 0) continue;
    // The first dash starting on or after this piece, then one a period.
    let at = (period - (walked % period)) % period;
    for (; at < len; at += period) {
      const end = Math.min(len, at + LANE_DASH.on);
      const point = (d: number) => ({
        x: a.x + ((b.x - a.x) * d) / len,
        z: a.z + ((b.z - a.z) * d) / len,
      });
      out.push([point(at), point(end)]);
    }
    walked += len;
  }
  return out;
}

export function buildTile(
  buffer: ArrayBuffer,
  tile: TileId,
  origin: LatLng,
  route: readonly LocalPoint[] = [],
  pedestrianAreas: readonly (readonly LocalPoint[])[] = [],
): TileMeshes {
  const vt = new VectorTile(new PbfReader(new Uint8Array(buffer)));
  const projection = createProjection(origin);
  const L = vt.layers;
  const extent = Object.values(L)[0]?.extent ?? 4096;
  const toLocal = tileToLocal(tile, extent, projection);
  const convert = (ring: Array<{ x: number; y: number }>) => ring.map((p) => toLocal(p.x, p.y));

  /** Every polygon of a layer (outer ring + holes), with its feature props. */
  function* polygons(layer: VectorTileLayer | undefined) {
    if (!layer) return;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== GeomType.Polygon) continue;
      for (const poly of classifyRings(f.loadGeometry())) yield { props: f.properties, poly };
    }
  }

  function* lines(layer: VectorTileLayer | undefined) {
    if (!layer) return;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== GeomType.Line) continue;
      for (const line of f.loadGeometry()) yield { props: f.properties, line: convert(line) };
    }
  }

  const layers: TileMeshes['layers'] = {};
  const mesh = new MeshBuilder();
  const clearance = new RoadClearance();
  clearance.add(route, ROUTE_ROAD_WIDTH_M + 2 * BUILDING_ROAD_CLEARANCE_M);
  for (const path of pedestrianAreas) clearance.add(path, 10);

  // Land use, parks, woods. One mesh; draw order within it = insertion order.
  for (const name of AREA_PRIORITY) {
    for (const { props, poly } of polygons(L[name])) {
      mesh.polygon(poly.map(convert), 0, areaColor(name, String(props.class ?? '')));
    }
  }
  layers.areas = mesh.build() ?? undefined;

  for (const { poly } of polygons(L.water)) mesh.polygon(poly.map(convert), 0, WATER);
  for (const { props, line } of lines(L.waterway)) {
    if (props.brunnel === 'tunnel') continue;
    mesh.ribbon(line, WATERWAY_WIDTH[String(props.class)] ?? 2, 0, WATER);
  }
  layers.water = mesh.build() ?? undefined;

  // Roads: all casings first, then all fills, minor classes under major ones,
  // so junctions read as one continuous surface.
  const byClass = new Map<string, Array<{ line: LocalPoint[]; width: number; oneway: boolean }>>();
  const rails: Rings = [];
  for (const { props, line } of lines(L.transportation)) {
    if (props.brunnel === 'tunnel') continue;
    const cls = roadClass(String(props.class ?? ''));
    const style = ROADS[cls];
    if (RAIL_CLASSES.has(cls)) rails.push(line);
    else if (style) {
      const oneway = props.oneway === 1 || props.oneway === -1;
      const width = roadWidth(style, oneway);
      clearance.add(line, width + CASING_EXTRA_M + 2 * BUILDING_ROAD_CLEARANCE_M);
      (byClass.get(cls) ?? byClass.set(cls, []).get(cls)!).push({ line, width, oneway });
    }
  }
  // Rails under the roads: where a line (an MRT viaduct) runs over a road, the
  // road covers it, so no vehicle seems to drive along the rails.
  for (const line of rails) mesh.ribbon(line, RAIL.width, 0, RAIL.color);
  for (const cls of ROAD_ORDER) {
    const { casing } = ROADS[cls]!;
    for (const r of byClass.get(cls) ?? [])
      mesh.ribbon(r.line, r.width + CASING_EXTRA_M, 0, casing);
  }
  layers.roadCasing = mesh.build() ?? undefined;
  for (const cls of ROAD_ORDER) {
    const { fill } = ROADS[cls]!;
    for (const r of byClass.get(cls) ?? []) mesh.ribbon(r.line, r.width, 0, fill);
  }
  layers.roadFill = mesh.build() ?? undefined;

  // Lane lines, on top of every road's surface: on detailed tiles only, and
  // a layer of their own, as they only matter close to the ground.
  if (tile.z >= LANE_LINES_FROM_ZOOM)
    for (const cls of ROAD_ORDER)
      for (const r of byClass.get(cls) ?? [])
        for (const { offset, solid } of laneLines(cls, r.oneway)) {
          const along = offsetLine(r.line, offset);
          const colour = cls === 'tertiary' ? STREET_LINE : LANE_LINE;
          for (const piece of solid ? [along] : dashes(along))
            mesh.ribbon(piece, LANE_DASH.width, 0, colour);
        }
  layers.laneLines = mesh.build() ?? undefined;

  // Buildings. Tiles overlap by a small buffer, so a building near an edge
  // is in two tiles; the tile that contains its centre owns it.
  for (const { props, poly } of polygons(L.building)) {
    const outer = poly[0]!;
    let cx = 0;
    let cy = 0;
    for (const p of outer) {
      cx += p.x;
      cy += p.y;
    }
    cx /= outer.length;
    cy /= outer.length;
    if (cx < 0 || cy < 0 || cx >= extent || cy >= extent) continue;

    const footprint = poly.map(convert);
    // Suppress conflicting footprints in this visualization rather than
    // moving real mapped buildings to invented locations.
    if (clearance.intersects(footprint)) continue;

    const top = Number(props.render_height) || DEFAULT_BUILDING_HEIGHT_M;
    const bottom = Math.min(Number(props.render_min_height) || 0, top - 0.5);
    const { wall, roof } = buildingColors(cx * 4099 + cy);
    mesh.extrusion(footprint, bottom, top, wall, roof);
  }
  layers.buildings = mesh.build() ?? undefined;

  const labels: MapLabel[] = [];
  const places = L.place;
  for (let i = 0; places && i < places.length; i++) {
    const f = places.feature(i);
    const kind = String(f.properties.class ?? '');
    const text = f.properties['name:latin'] ?? f.properties.name;
    if (!LABEL_PLACES.has(kind) || typeof text !== 'string') continue;
    const p = f.loadGeometry()[0]?.[0];
    if (!p || p.x < 0 || p.y < 0 || p.x >= extent || p.y >= extent) continue;
    labels.push({ text, kind, ...toLocal(p.x, p.y) });
  }

  // Landmarks people give directions by: the most important of each tile, and every station.
  const landmarks: Array<MapLabel & { rank: number }> = [];
  const pois = L.poi;
  for (let i = 0; pois && i < pois.length; i++) {
    const f = pois.feature(i);
    const text = f.properties['name:latin'] ?? f.properties.name;
    if (typeof text !== 'string') continue;
    const kind = landmarkKind(
      String(f.properties.class ?? ''),
      String(f.properties.subclass ?? ''),
      text,
    );
    if (!kind) continue;
    const p = f.loadGeometry()[0]?.[0];
    if (!p || p.x < 0 || p.y < 0 || p.x >= extent || p.y >= extent) continue;
    landmarks.push({ text, kind, ...toLocal(p.x, p.y), rank: Number(f.properties.rank ?? 99) });
  }
  landmarks.sort((a, b) => a.rank - b.rank);
  const named = new Set<string>();
  let shown = 0;
  for (const l of landmarks) {
    if (named.has(l.text)) continue;
    named.add(l.text);
    if (l.kind === 'landmark' && shown++ >= LANDMARKS_PER_TILE) continue;
    labels.push({ text: l.text, kind: l.kind, x: l.x, z: l.z });
  }

  // Street names: each once a tile, halfway along its longest stretch in it.
  const streets = new Map<string, { kind: string; length: number; at: LocalPoint }>();
  for (const { props, line } of lines(L.transportation_name)) {
    const text = props['name:latin'] ?? props.name;
    const kind = ROAD_LABELS[roadClass(String(props.class ?? ''))];
    if (!kind || typeof text !== 'string' || line.length < 2) continue;
    const length = line
      .slice(1)
      .reduce((m, q, k) => m + Math.hypot(q.x - line[k]!.x, q.z - line[k]!.z), 0);
    if (length < LABELLED_STREET_M || (streets.get(text)?.length ?? 0) >= length) continue;
    streets.set(text, { kind, length, at: halfway(line, length) });
  }
  let sideStreets = 0;
  for (const [text, s] of [...streets].sort((a, b) => b[1].length - a[1].length)) {
    if (s.kind === 'street' && sideStreets++ >= STREETS_PER_TILE) continue;
    labels.push({ text, kind: s.kind, x: s.at.x, z: s.at.z });
  }

  return { tile, layers, labels };
}

/** The point `length / 2` along `line` (`length` its whole length). */
function halfway(line: readonly LocalPoint[], length: number): LocalPoint {
  let left = length / 2;
  for (let k = 1; k < line.length; k++) {
    const [a, b] = [line[k - 1]!, line[k]!];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    if (d >= left && d > 0)
      return { x: a.x + ((b.x - a.x) * left) / d, z: a.z + ((b.z - a.z) * left) / d };
    left -= d;
  }
  return line[line.length - 1]!;
}

/** Typed arrays to hand over to the main thread without copying. */
export function transferables(t: TileMeshes): ArrayBuffer[] {
  return [
    ...Object.values(t.layers).flatMap((m) =>
      m ? [m.position.buffer, m.normal.buffer, m.color.buffer, m.index.buffer] : [],
    ),
  ] as ArrayBuffer[];
}
