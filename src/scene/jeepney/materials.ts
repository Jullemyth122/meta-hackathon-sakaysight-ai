/**
 * Jeepney colours and materials. One material per part slot, shared by every
 * jeepney: materials are expensive to create and to switch between.
 *
 * Livery accents vary per vehicle, so the accent slots use instance colours
 * (white base material, colour supplied per instance).
 */

import { Color, MeshStandardMaterial } from 'three';
import type { Livery } from '@/core/fleet/fleetSim';
import type { PartSlot } from './jeepneyGeometry';

export const PALETTE = {
  body: '#f3f3f1',
  trim: '#a7acb1',
  dark: '#44484e',
  interior: '#8b9095', // floor: ridged aluminium
  seat: '#8e949b', // glossy grey vinyl, as in most jeepneys
  chrome: '#d9dcdf',
  glass: '#b7c0c6',
  lamp: '#fffaf0',
  tail: '#d6453d',
  tire: '#2d3034',
  hub: '#e4e5e6',
} as const;

/** accent = main stripe & hood, accent2 = rails & roof trim, sign = signboard. */
export const LIVERIES: Record<Livery, { accent: string; accent2: string; sign: string }> = {
  red: { accent: '#d6453d', accent2: '#efbe2c', sign: '#efbe2c' },
  yellow: { accent: '#efbe2c', accent2: '#d6453d', sign: '#f6f6f4' },
  green: { accent: '#3a9d5d', accent2: '#efbe2c', sign: '#f6f6f4' },
};

/** Slots whose colour comes from the livery (per instance). */
export const LIVERY_SLOTS = new Set<PartSlot>(['accent', 'accent2', 'sign']);

const cache = new Map<string, MeshStandardMaterial>();

function make(key: string, build: () => MeshStandardMaterial): MeshStandardMaterial {
  let m = cache.get(key);
  if (!m) {
    m = build();
    cache.set(key, m);
  }
  return m;
}

export function slotMaterial(slot: PartSlot): MeshStandardMaterial {
  return make(slot, () => {
    if (LIVERY_SLOTS.has(slot))
      return new MeshStandardMaterial({ color: '#ffffff', roughness: 0.42 });
    switch (slot) {
      case 'glass':
        return new MeshStandardMaterial({
          color: PALETTE.glass,
          roughness: 0.15,
          transparent: true,
          opacity: 0.38,
          depthWrite: false,
        });
      case 'lamp':
        return new MeshStandardMaterial({
          color: PALETTE.lamp,
          emissive: '#fff1c4',
          emissiveIntensity: 0.55,
        });
      case 'tail':
        return new MeshStandardMaterial({
          color: PALETTE.tail,
          emissive: '#b02a22',
          emissiveIntensity: 0.55,
        });
      case 'chrome':
        // No metalness: with no environment map to reflect, metal renders
        // nearly black. A bright, smooth dielectric reads as polished steel.
        return new MeshStandardMaterial({ color: PALETTE.chrome, roughness: 0.3 });
      case 'seat':
        return new MeshStandardMaterial({ color: PALETTE.seat, roughness: 0.32 });
      case 'interior':
        return new MeshStandardMaterial({ color: PALETTE.interior, roughness: 0.85 });
      case 'trim':
        return new MeshStandardMaterial({ color: PALETTE.trim, roughness: 0.62 });
      default:
        return new MeshStandardMaterial({
          color: PALETTE[slot as keyof typeof PALETTE],
          roughness: 0.5,
        });
    }
  });
}

export function wheelMaterial(part: 'tire' | 'hub'): MeshStandardMaterial {
  return make(
    part,
    () =>
      new MeshStandardMaterial({ color: PALETTE[part], roughness: part === 'tire' ? 0.85 : 0.4 }),
  );
}

/** For parts with their colours baked in (geometryKit.bakeColours). */
export function bakedMaterial(): MeshStandardMaterial {
  return make('baked', () => new MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
}

const scratch = new Color();
export function liveryColor(livery: Livery, slot: PartSlot): Color {
  const key = slot as 'accent' | 'accent2' | 'sign';
  return scratch.set(LIVERIES[livery][key]);
}
