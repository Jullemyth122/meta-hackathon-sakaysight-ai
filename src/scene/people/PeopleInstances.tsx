/**
 * Draws up to `capacity` articulated people (personRig.ts) with one
 * InstancedMesh per body part: 9 draw calls for the whole crowd.
 *
 * Whoever owns the poses drives it imperatively, inside their own useFrame,
 * so people can be posed with the same matrices as the vehicle they sit in:
 *
 *   people.begin();
 *   people.emit(rootMatrix, pose, seed);   // once per visible person
 *   people.end();
 *
 * A person's colours depend only on `seed`, and colours are re-uploaded only
 * for instance slots whose occupant changed.
 *
 * With `fading`, each person also has a visibility from 0 to 1 (people
 * arriving and leaving). It is drawn as a screen-door dither: a pixel is
 * kept only where its hash is below the visibility. No transparency, so no
 * sorting between overlapping body parts, and fully visible people cost
 * nothing extra.
 */

import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import {
  InstancedBufferAttribute,
  Matrix4,
  MeshStandardMaterial,
  type InstancedMesh,
  type Material,
} from 'three';
import { hash, instancedBufferAttribute, screenCoordinate } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  appearance,
  PAIRED_PARTS,
  PART_COLOR,
  RigWriter,
  rigGeometries,
  SINGLE_PARTS,
  type Appearance,
  type BodyPart,
  type PersonPose,
} from './personRig';

export interface PeopleHandle {
  begin(): void;
  /**
   * Add one person. `look` defaults to appearance(seed); pass one to dress
   * someone differently (the driver). `visibility` (0–1) only counts with
   * `fading`. Ignored once capacity is reached.
   */
  emit(
    root: Matrix4,
    pose: PersonPose,
    seed: number,
    look?: Appearance,
    visibility?: number,
    pregnant?: boolean,
  ): void;
  end(): void;
}

const PARTS: readonly BodyPart[] = [...SINGLE_PARTS, ...PAIRED_PARTS];
const isPaired = (p: BodyPart) => (PAIRED_PARTS as readonly string[]).includes(p);
const ROUGHNESS = 0.72;

let material: MeshStandardMaterial | null = null;

/** Per-part visibility buffers and the dithering materials that read them. */
function fadeMaterials(capacity: number) {
  const visibility = {} as Record<BodyPart, InstancedBufferAttribute>;
  const materials = {} as Record<BodyPart, Material>;
  for (const part of PARTS) {
    const attr = new InstancedBufferAttribute(
      new Float32Array(isPaired(part) ? capacity * 2 : capacity).fill(1),
      1,
    );
    const m = new MeshStandardNodeMaterial({ roughness: ROUGHNESS });
    const pixel = screenCoordinate.x.floor().add(screenCoordinate.y.floor().mul(4096));
    m.maskNode = instancedBufferAttribute<'float'>(attr, 'float').greaterThan(hash(pixel));
    visibility[part] = attr;
    materials[part] = m;
  }
  return { visibility, materials };
}

export function PeopleInstances({
  capacity,
  castShadow = true,
  fading = false,
  layer,
  ref,
}: {
  capacity: number;
  castShadow?: boolean;
  /** The layer to draw on, when not every camera should see them. */
  layer?: number;
  /** Draw each person's `visibility` (see emit). */
  fading?: boolean;
  ref: Ref<PeopleHandle>;
}) {
  const geometries = rigGeometries();
  material ??= new MeshStandardMaterial({ roughness: ROUGHNESS });
  const meshes = useRef<Partial<Record<BodyPart, InstancedMesh | null>>>({});
  const fade = useMemo(() => (fading ? fadeMaterials(capacity) : null), [fading, capacity]);
  useEffect(
    () => () => {
      if (fade) for (const part of PARTS) fade.materials[part].dispose();
    },
    [fade],
  );

  const state = useMemo(
    () => ({
      n: 0,
      writer: new RigWriter(),
      out: {
        torso: new Matrix4(),
        pelvis: new Matrix4(),
        head: new Matrix4(),
        hair: new Matrix4(),
        belly: new Matrix4(),
        thigh: [new Matrix4(), new Matrix4()],
        shin: [new Matrix4(), new Matrix4()],
        foot: [new Matrix4(), new Matrix4()],
        sleeve: [new Matrix4(), new Matrix4()],
        forearm: [new Matrix4(), new Matrix4()],
      } as Parameters<RigWriter['write']>[2],
      /** Seed currently shown in each slot, to skip unchanged colour uploads. */
      seeds: new Int32Array(capacity).fill(-1),
      coloursDirty: false,
    }),
    [capacity],
  );

  useImperativeHandle(
    ref,
    () => ({
      begin() {
        state.n = 0;
        state.coloursDirty = false;
      },
      emit(root, pose, seed, lookOverride, visibility = 1, pregnant = false) {
        const i = state.n;
        if (i >= capacity) return;
        state.n++;
        state.writer.write(root, pose, state.out, pregnant);
        const recolour = state.seeds[i] !== seed;
        const look = recolour ? (lookOverride ?? appearance(seed)) : null;
        if (recolour) {
          state.seeds[i] = seed;
          state.coloursDirty = true;
        }
        for (const part of PARTS) {
          const mesh = meshes.current[part];
          if (!mesh) continue;
          if (fade) {
            const v = fade.visibility[part].array as Float32Array;
            if (isPaired(part)) v[i * 2] = v[i * 2 + 1] = visibility;
            else v[i] = visibility;
          }
          if (isPaired(part)) {
            const [l, r] = state.out[part as (typeof PAIRED_PARTS)[number]];
            mesh.setMatrixAt(i * 2, l);
            mesh.setMatrixAt(i * 2 + 1, r);
            if (look) {
              mesh.setColorAt(i * 2, look[PART_COLOR[part]]);
              mesh.setColorAt(i * 2 + 1, look[PART_COLOR[part]]);
            }
          } else {
            mesh.setMatrixAt(i, state.out[part as (typeof SINGLE_PARTS)[number]]);
            if (look) mesh.setColorAt(i, look[PART_COLOR[part]]);
          }
        }
      },
      end() {
        for (const part of PARTS) {
          const mesh = meshes.current[part];
          if (!mesh) continue;
          mesh.count = isPaired(part) ? state.n * 2 : state.n;
          // Nobody to draw: not a draw call in every pass.
          mesh.visible = mesh.count > 0;
          if (mesh.count === 0) continue;
          // Upload only visible instances, not the capacity reserved for the
          // entire fleet. Both WebGPU and WebGL support these update ranges.
          mesh.instanceMatrix.clearUpdateRanges();
          mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
          mesh.instanceMatrix.needsUpdate = true;
          if (state.coloursDirty && mesh.instanceColor) {
            mesh.instanceColor.clearUpdateRanges();
            mesh.instanceColor.addUpdateRange(0, mesh.count * 3);
            mesh.instanceColor.needsUpdate = true;
          }
          if (fade) {
            fade.visibility[part].clearUpdateRanges();
            fade.visibility[part].addUpdateRange(0, mesh.count);
            fade.visibility[part].needsUpdate = true;
          }
        }
      },
    }),
    [capacity, state, fade],
  );

  return (
    <group>
      {PARTS.map((part) => (
        <instancedMesh
          key={`${part}-${capacity}-${fade ? 'fade' : 'solid'}`}
          ref={(m) => {
            meshes.current[part] = m;
            if (m && layer !== undefined) m.layers.set(layer);
            // A fresh mesh has no colours yet: force every slot to recolour.
            if (m) state.seeds.fill(-1);
          }}
          args={[
            geometries[part],
            fade ? fade.materials[part] : material!,
            isPaired(part) ? capacity * 2 : capacity,
          ]}
          castShadow={castShadow}
          receiveShadow
          frustumCulled={false}
        />
      ))}
    </group>
  );
}
