/**
 * Client configuration, read once from Vite env vars.
 *
 * Everything here ships to the browser. Firebase web config is public by
 * design (security comes from database rules). Secrets such as META_API_KEY
 * never appear here; they live in Vercel and are read only by /api.
 */

const env = import.meta.env;

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  appId: string;
}

function firebaseConfig(): FirebaseWebConfig | null {
  const cfg = {
    apiKey: env.VITE_FIREBASE_API_KEY || env.FIREBASE_API_KEY || '',
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || env.FIREBASE_AUTH_DOMAIN || '',
    databaseURL: env.VITE_FIREBASE_DATABASE_URL || env.FIREBASE_DATABASE_URL || '',
    projectId: env.VITE_FIREBASE_PROJECT_ID || env.FIREBASE_PROJECT_ID || '',
    appId: env.VITE_FIREBASE_APP_ID || env.FIREBASE_APP_ID || '',
  };
  // All or nothing: a half-configured Firebase fails in confusing ways.
  return Object.values(cfg).every(Boolean) ? cfg : null;
}

export const config = {
  firebase: firebaseConfig(),
  /** WebGPU is the default; WebGPURenderer falls back to WebGL2 by itself. */
  renderer: (env.VITE_RENDERER === 'webgl' ? 'webgl' : 'webgpu') as 'webgpu' | 'webgl',
  /**
   * TileJSON for the 3D map's vector tiles (OpenMapTiles schema). OpenFreeMap
   * is free, needs no key and allows browser use; any OpenMapTiles-compatible
   * server works. Set to "off" to run without a map.
   */
  mapTiles: env.VITE_MAP_TILEJSON ?? 'https://tiles.openfreemap.org/planet',
} as const;
