/**
 * Colours of the modern jeepney, UV Express and bus: white bodies with a
 * livery band (a generic one, no operator's), tinted glass, an amber LED
 * route sign. One material per kind and slot, cached.
 */

import { MeshStandardMaterial, type BufferGeometry } from 'three';
import type { VehicleKind } from '@/core/vehicles/specs';
import { bakeColours, bakedColour } from '../jeepney/geometryKit';
import { bakedMaterial, PALETTE } from '../jeepney/materials';
import type { Slot, VehicleParts } from './bodyKit';

export const LIVERY: Record<
  VehicleKind,
  { stripe: string; stripe2: string; seat: string; tint: string }
> = {
  bus: { stripe: '#1f4fb8', stripe2: '#d6453d', seat: '#34477a', tint: '#1d2a36' },
  modern: { stripe: '#138a72', stripe2: '#efbe2c', seat: '#5c636b', tint: '#22323e' },
  uv: { stripe: '#202327', stripe2: '#c8282c', seat: '#3b3f45', tint: '#161c22' },
};

const cache = new Map<string, MeshStandardMaterial>();

export function vehicleMaterial(kind: VehicleKind, slot: Slot): MeshStandardMaterial {
  const key = `${kind}:${slot}`;
  let m = cache.get(key);
  if (m) return m;
  const L = LIVERY[kind];
  switch (slot) {
    case 'glass':
      m = new MeshStandardMaterial({
        color: L.tint,
        roughness: 0.1,
        transparent: true,
        opacity: kind === 'uv' ? 0.72 : 0.5,
        depthWrite: false,
      });
      break;
    case 'lamp':
      m = new MeshStandardMaterial({
        color: PALETTE.lamp,
        emissive: '#fff1c4',
        emissiveIntensity: 0.55,
      });
      break;
    case 'tail':
      m = new MeshStandardMaterial({
        color: PALETTE.tail,
        emissive: '#b02a22',
        emissiveIntensity: 0.6,
      });
      break;
    case 'sign':
      // An amber LED route display.
      m = new MeshStandardMaterial({
        color: '#3a2400',
        emissive: '#ff9f1c',
        emissiveIntensity: 0.9,
      });
      break;
    case 'nosing':
      m = new MeshStandardMaterial({ color: '#efbe2c', roughness: 0.5 });
      break;
    default: {
      const colour: Record<Exclude<Slot, 'glass' | 'lamp' | 'tail' | 'sign' | 'nosing'>, string> = {
        paint: '#f4f4f2',
        stripe: L.stripe,
        stripe2: L.stripe2,
        trim: '#9aa0a6',
        dark: '#2a2d31',
        floor: '#5f646a',
        seat: L.seat,
        chrome: PALETTE.chrome,
        tire: PALETTE.tire,
        hub: PALETTE.hub,
        interior: '#e6e7e8',
      };
      m = new MeshStandardMaterial({
        color: colour[slot],
        roughness: slot === 'tire' ? 0.85 : slot === 'chrome' ? 0.3 : 0.5,
      });
    }
  }
  cache.set(key, m);
  return m;
}

/** A set of parts as drawn: all it can in one baked mesh, its glass (see-through) in another. */
export interface DrawnPart {
  /** 'body' or 'glass'. */
  slot: 'body' | 'glass';
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
}

const baked = new WeakMap<VehicleParts, DrawnPart[]>();

export function drawnParts(kind: VehicleKind, parts: VehicleParts): DrawnPart[] {
  let drawn = baked.get(parts);
  if (drawn) return drawn;
  const solid = (Object.entries(parts) as [Slot, BufferGeometry][]).filter(([s]) => s !== 'glass');
  drawn = [];
  if (solid.length > 0)
    drawn.push({
      slot: 'body',
      geometry: bakeColours(solid.map(([s, g]) => [g, bakedColour(vehicleMaterial(kind, s))])),
      material: bakedMaterial(),
    });
  if (parts.glass)
    drawn.push({
      slot: 'glass',
      geometry: parts.glass,
      material: vehicleMaterial(kind, 'glass'),
    });
  baked.set(parts, drawn);
  return drawn;
}
