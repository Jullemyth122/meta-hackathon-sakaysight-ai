import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * The serverless functions in api/ (assistant, voice, planner), served by the
 * dev server too, so `npm run dev` has everything `vercel dev` and the
 * deployment have. Each api/<name>.ts exports a handler per HTTP method
 * taking a web Request and returning a Response, as on Vercel.
 *
 * Their keys (META_API_KEY, ELEVENLABS_API_KEY, …) are read from .env into
 * this Node process only. Vite exposes just VITE_-prefixed variables to the
 * browser, so none of them reaches the page.
 */
function devApi(env: Record<string, string>): Plugin {
  return {
    name: 'sakaysightai-dev-api',
    apply: 'serve',
    configureServer(server) {
      for (const [key, value] of Object.entries(env)) process.env[key] ??= value;
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.originalUrl ?? req.url ?? '/', `http://${req.headers.host}`);
        if (!url.pathname.startsWith('/api/')) return next();
        // api/_lib holds shared code, not routes (as on Vercel).
        const name = /^\/api\/([a-z][a-z0-9-]*)$/.exec(url.pathname)?.[1];
        const file = name && resolve(import.meta.dirname, 'api', `${name}.ts`);
        if (!file || !existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        try {
          const handlers = (await server.ssrLoadModule(file)) as Record<string, unknown>;
          const handler = handlers[req.method ?? 'GET'];
          if (typeof handler !== 'function') {
            res.statusCode = 405;
            res.end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers))
            if (value !== undefined)
              headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
          const response = (await handler(
            new Request(url, {
              method: req.method,
              headers,
              body: hasBody ? new Uint8Array(Buffer.concat(chunks)) : undefined,
            }),
          )) as Response;
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          if (err instanceof Error) server.ssrFixStacktrace(err);
          next(err);
        }
      });
    },
  };
}

/**
 * Two entry points, on purpose:
 *   index.html  laptop dashboard (Three.js, heavy)
 *   track.html  phone tracker    (no Three.js, loads fast on mobile data)
 *
 * `npm run dev:phone` serves over self-signed HTTPS on the LAN, because
 * browsers only expose the Geolocation API on secure origins.
 */
export default defineConfig(({ mode }) => ({
  // FIREBASE_: the project's web settings, public by design (src/config.ts).
  envPrefix: ['VITE_', 'FIREBASE_'],
  plugins: [
    react(),
    mode === 'phone' && basicSsl(),
    // Not under Vitest: tests must never see real keys or call paid APIs.
    !process.env.VITEST && devApi(loadEnv(mode, import.meta.dirname, '')),
  ],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  build: {
    target: 'es2022',
    // three/webgpu alone is ~1.3 MB minified (≈400 kB gzip). It only loads on the
    // dashboard; the phone tracker never imports it.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        track: resolve(import.meta.dirname, 'track.html'),
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'api/**/*.test.ts'],
    environment: 'node',
  },
}));
