/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_DATABASE_URL?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly FIREBASE_API_KEY?: string;
  readonly FIREBASE_AUTH_DOMAIN?: string;
  readonly FIREBASE_DATABASE_URL?: string;
  readonly FIREBASE_PROJECT_ID?: string;
  readonly FIREBASE_APP_ID?: string;
  readonly VITE_RENDERER?: 'webgpu' | 'webgl';
  readonly VITE_MAP_TILEJSON?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
