/**
 * Gas stations on the map: every one the same low-poly station, a forecourt
 * with a canopy over two lanes of pumps, a shop behind them and a sign by the
 * road, in its brand's colour. A station the route's vehicles can pull in to
 * stands on the kerb its way through runs along (fleetSim.ts drives its lanes,
 * between the pump islands); any other, at the side of the road nearest it,
 * facing that road, and smaller where the block is tight. Each finds where it
 * fits clear of the roads the map draws (core/map/streets.ts stationFit). All of
 * them are four instanced draw calls and a flat one, about 200 triangles each,
 * however many there are.
 *
 * Their names are labels (see TwinScene), which shrink to ⛽ when zoomed out so
 * every station stays findable on the whole map.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Vector3,
} from 'three';
import { useRuntimes } from '@/app/runtimeContext';
import { stationFits } from '@/app/streetWays';
import type { Route } from '@/core/geo/routes';
import type { StationFit } from '@/core/map/streets';
import {
  placeOnRoute,
  STATION_DEPTH_M,
  STATION_LENGTH_M,
  STATION_LANES_M,
  type FuelStation,
} from '@/core/fuel/stations';
import { flat, FLAT_ORDER, MAP_LAYER } from '../map/flatLayers';

/** Colours drivers recognise from the canopies (a key, not a logo). */
export const BRAND_COLOUR: Record<string, string> = {
  Petron: '#1f5fbf',
  Shell: '#e9b800',
  Caltex: '#d7262e',
  Phoenix: '#f07c1b',
  Seaoil: '#1497a8',
  'Flying V': '#b5172f',
  Unioil: '#2e9e48',
  PTT: '#2b59c3',
  Total: '#e8352b',
  Cleanfuel: '#3fae49',
  'Jade Blue': '#2f8fd8',
};
export const OTHER_COLOUR = '#6b7280';
export const brandColour = (brand: string) => BRAND_COLOUR[brand] ?? OTHER_COLOUR;

const CONCRETE = '#c9c6bf';
const WHITE = '#fbfaf6';
const STEEL = '#c4c7ca';
const GLASS = '#33404f';
const ISLAND = '#b9b5ab';
/** The stripe under a canopy's edge, as on the real ones. */
const STRIPE = '#f2c230';

/** Nowhere clear near it: no station at all beats one on a street (its label stays). */
const OVER_A_STREET_M = 1;
/** Two stations this close are one on the map (mapped twice, or a shop beside it). */
const SAME_PLACE_M = 34;
/** The canopy's height: a bus goes under it (metres). */
const CANOPY_M = 5.2;
/** Under the canopy, pumps along the island, and the shop behind. */
const CANOPY_LENGTH_M = 24;
const PUMPS_AT_M = [-7, 0, 7];
const SHOP_LENGTH_M = 16;
const SHOP_DEPTH_M = 7;

type Box = [
  length: number,
  height: number,
  depth: number,
  along: number,
  y: number,
  fromRoad: number,
  colour: string,
];

/** The island between the two lanes of pumps, and the canopy's middle. */
const MID_M = (STATION_LANES_M[0] + STATION_LANES_M[1]) / 2;
const CANOPY_DEPTH_M = STATION_LANES_M[1] - STATION_LANES_M[0] + 7;
/** From the back of the plot to the shop's middle. */
const SHOP_BACK_M = SHOP_DEPTH_M / 2 + 1.5;
/** A plot shallower than this, of the full-size lanes, has no room behind them for a shop. */
const SHOP_NEEDS_M = 24;
const SIGN_ALONG_M = STATION_LENGTH_M / 2 - 3;

/** What every station has, whatever its brand. Metres along the road, up, and in from it. */
const PLAIN: Box[] = [
  [20, 0.25, 1.1, 0, 0.12, MID_M, ISLAND],
  ...PUMPS_AT_M.map((x): Box => [0.86, 0.34, 0.6, x, 2.05, MID_M, WHITE]),
  ...[-1, 0, 1].map((k): Box => [
    0.5,
    CANOPY_M,
    0.5,
    (k * CANOPY_LENGTH_M) / 3,
    CANOPY_M / 2,
    MID_M,
    STEEL,
  ]),
  // The underside, and the stripe round the canopy's lower edge.
  [CANOPY_LENGTH_M + 0.6, 0.22, CANOPY_DEPTH_M + 0.6, 0, CANOPY_M, MID_M, STRIPE],
  [CANOPY_LENGTH_M, 0.06, CANOPY_DEPTH_M, 0, CANOPY_M - 0.13, MID_M, WHITE],
  [2.6, 2.9, 0.55, -SIGN_ALONG_M, 10.2, 2, WHITE],
];

/** The shop, on its own: it stands at the back of the plot, however deep that is. */
const SHOP: Box[] = [
  [SHOP_LENGTH_M, 3.4, SHOP_DEPTH_M, 0, 1.7, 0, WHITE],
  [SHOP_LENGTH_M - 3, 1.8, 0.12, 0, 1.6, -SHOP_DEPTH_M / 2, GLASS],
];
const SHOP_ROOF: Box[] = [[SHOP_LENGTH_M + 0.6, 0.6, SHOP_DEPTH_M + 0.6, 0, 3.7, 0, WHITE]];

/** What is painted in the brand's colour: its canopy, the shop's roof, sign, pole and pumps. */
const PAINTED: Box[] = [
  [CANOPY_LENGTH_M + 0.6, 1, CANOPY_DEPTH_M + 0.6, 0, CANOPY_M + 0.61, MID_M, WHITE],
  [0.55, 8.6, 0.55, -SIGN_ALONG_M, 4.3, 2, WHITE],
  [3.3, 3.7, 0.4, -SIGN_ALONG_M, 10.2, 2, WHITE],
  ...PUMPS_AT_M.map((x): Box => [0.8, 1.8, 0.55, x, 1.05, MID_M, WHITE]),
];

/** The boxes as one mesh, each face a colour of its own: one draw call. */
function model(boxes: readonly Box[]): BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const color: number[] = [];
  const c = new Color();
  for (const [length, height, depth, along, y, fromRoad, colour] of boxes) {
    const box = new BoxGeometry(length, height, depth).translate(along, y, fromRoad);
    const flatBox = box.toNonIndexed();
    position.push(...flatBox.getAttribute('position').array);
    normal.push(...flatBox.getAttribute('normal').array);
    c.set(colour);
    for (let i = 0; i < flatBox.getAttribute('position').count; i++) color.push(c.r, c.g, c.b);
    box.dispose();
    flatBox.dispose();
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normal), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(color), 3));
  return g;
}

interface Placed extends StationFit {
  brand: string;
}

/** Each forecourt, flat on the ground from the road's edge back. */
function forecourts(places: readonly Placed[]): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  const c = new Color(CONCRETE);
  for (const p of places) {
    const half = p.length / 2;
    const corner = (along: number, inM: number) => [
      p.x + p.ux * along + p.nx * inM,
      0,
      p.z + p.uz * along + p.nz * inM,
    ];
    const a = corner(-half, 0);
    const b = corner(half, 0);
    const d = corner(half, p.depth);
    const e = corner(-half, p.depth);
    for (const v of [a, b, d, a, d, e]) {
      position.push(...v);
      color.push(c.r, c.g, c.b);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(color), 3));
  g.computeBoundingSphere();
  return g;
}

/** Facing the road, and turned as a building turns: never mirrored inside out. `at`: in from it. */
function poseOf(p: Placed, out: Matrix4, at = 0): Matrix4 {
  const up = new Vector3(0, 1, 0);
  const n = new Vector3(p.nx, 0, p.nz);
  const u = new Vector3(p.ux, 0, p.uz);
  if (u.clone().cross(up).dot(n) < 0) u.negate();
  // A smaller station is a smaller plot: the same height, a bus still goes under it.
  u.multiplyScalar(p.length / STATION_LENGTH_M);
  const x = p.x + p.nx * at;
  const z = p.z + p.nz * at;
  n.multiplyScalar(p.lanes);
  return out.makeBasis(u, up, n).setPosition(x, 0, z);
}

export function FuelStations({
  route,
  stations,
}: {
  route: Route;
  stations: readonly FuelStation[];
}) {
  const { twin } = useRuntimes();
  // Where each fits among the map's roads, by route and station: a station a
  // route uses stands level with it. Null for one with no road near: asked
  // once, not drawn.
  const [fits, setFits] = useState<ReadonlyMap<string, StationFit | null>>(new Map());
  useEffect(() => {
    const origin = route.projection?.origin;
    const keyOf = (id: string) => `${route.id}:${id}`;
    const asked = stations.filter((st) => !fits.has(keyOf(st.id)));
    if (!origin || asked.length === 0) return;
    let live = true;
    void stationFits(
      asked.map((st) => {
        const on = placeOnRoute(route, st);
        return { at: st.at, ...(on && { on }) };
      }),
      STATION_LENGTH_M,
      STATION_DEPTH_M,
      origin,
    ).then((found) => {
      if (!live) return;
      setFits((known) => {
        const more = new Map(known);
        found.forEach((fit, i) => more.set(keyOf(asked[i]!.id), fit));
        return more;
      });
    });
    return () => {
      live = false;
    };
  }, [route, stations, fits]);

  const places = useMemo(() => {
    const out: Placed[] = [];
    const used = new Map<string, StationFit>();
    for (const st of stations) {
      const fit = fits.get(`${route.id}:${st.id}`);
      if (!fit) continue;
      const usedByVehicles = !!placeOnRoute(route, st);
      if (usedByVehicles) used.set(st.id, fit);
      else if (fit.over > OVER_A_STREET_M) continue;
      if (out.some((o) => Math.hypot(o.x - fit.x, o.z - fit.z) < SAME_PLACE_M)) continue;
      out.push({ ...fit, brand: st.brand });
    }
    // Vehicles drive through it where it stands.
    if (twin.route === route) twin.setStationFits(used);
    return out;
  }, [route, stations, fits, twin]);

  const ground = useMemo(() => forecourts(places), [places]);
  const groundMaterial = useMemo(
    () => flat(new MeshBasicMaterial({ vertexColors: true, side: DoubleSide })),
    [],
  );
  const plain = useMemo(() => model(PLAIN), []);
  const painted = useMemo(() => model(PAINTED), []);
  const shop = useMemo(() => model(SHOP), []);
  const shopRoof = useMemo(() => model(SHOP_ROOF), []);
  const material = useMemo(() => new MeshLambertMaterial({ vertexColors: true }), []);
  const paint = useMemo(() => new MeshLambertMaterial({ vertexColors: true }), []);
  useEffect(() => () => ground.dispose(), [ground]);
  useEffect(
    () => () => {
      groundMaterial.dispose();
      plain.dispose();
      painted.dispose();
      shop.dispose();
      shopRoof.dispose();
      material.dispose();
      paint.dispose();
    },
    [groundMaterial, plain, painted, shop, shopRoof, material, paint],
  );

  const buildings = useRef<InstancedMesh>(null);
  const brands = useRef<InstancedMesh>(null);
  const shops = useRef<InstancedMesh>(null);
  const roofs = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const a = buildings.current;
    const b = brands.current;
    const c = shops.current;
    const d = roofs.current;
    if (!a || !b || !c || !d) return;
    const matrix = new Matrix4();
    const colour = new Color();
    places.forEach((p, i) => {
      poseOf(p, matrix);
      a.setMatrixAt(i, matrix);
      b.setMatrixAt(i, matrix);
      const paint = colour.set(brandColour(p.brand));
      b.setColorAt(i, paint);
      d.setColorAt(i, paint);
      // At the back of the plot, when there is room behind the canopy for it.
      const room = p.lanes < 1 || p.depth >= SHOP_NEEDS_M;
      poseOf(p, matrix, p.depth - SHOP_BACK_M * p.lanes);
      if (!room) matrix.makeScale(0, 0, 0);
      c.setMatrixAt(i, matrix);
      d.setMatrixAt(i, matrix);
    });
    for (const mesh of [a, b, c, d]) {
      mesh.layers.set(MAP_LAYER);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    if (b.instanceColor) b.instanceColor.needsUpdate = true;
    if (d.instanceColor) d.instanceColor.needsUpdate = true;
  }, [places]);

  if (places.length === 0) return null;
  return (
    <>
      <mesh geometry={ground} material={groundMaterial} renderOrder={FLAT_ORDER.fuel} />
      <instancedMesh
        key={`a${places.length}`}
        ref={buildings}
        args={[plain, material, places.length]}
      />
      <instancedMesh
        key={`b${places.length}`}
        ref={brands}
        args={[painted, paint, places.length]}
      />
      <instancedMesh key={`c${places.length}`} ref={shops} args={[shop, material, places.length]} />
      <instancedMesh
        key={`d${places.length}`}
        ref={roofs}
        args={[shopRoof, paint, places.length]}
      />
    </>
  );
}
