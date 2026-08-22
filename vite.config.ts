import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Stamps the built asset list and a build id into the service worker, so the
 * offline shell precaches the real hashed bundles at install rather than
 * hoping they were fetched once while online. Keeps us off workbox.
 */
function serviceWorkerAssets(): Plugin {
  return {
    name: 'sw-assets',
    apply: 'build',
    closeBundle() {
      const outDir = fileURLToPath(new URL('./dist', import.meta.url));
      const swPath = join(outDir, 'sw.js');

      let assets: string[] = [];
      try {
        assets = readdirSync(join(outDir, 'assets')).map((f) => `/assets/${f}`);
      } catch {
        /* no assets dir — nothing to precache beyond the shell */
      }

      let sw: string;
      try {
        sw = readFileSync(swPath, 'utf8');
      } catch {
        return; // public/sw.js absent; offline support is optional
      }

      /* The build id is a digest of what the shell actually consists of, not a
         timestamp. A timestamp changes on every build, and the browser treats
         any byte-difference in sw.js as a new worker — so a rebuild that
         produced identical output would still install a second copy of the
         same app and ask the reader to update to it. Hashed filenames already
         encode every change to the bundles; index.html is hashed alongside
         them because it is the one shell file whose name never changes.
         `sw` is in there for the same reason and is easy to forget: a release
         that only fixes the worker leaves the assets untouched, so without it
         the new worker would name its cache after the generation it is
         replacing — sharing a cache with the code it exists to supersede,
         and skipping it when it looks for one. */
      let indexHtml = '';
      try {
        indexHtml = readFileSync(join(outDir, 'index.html'), 'utf8');
      } catch {
        /* no shell — the digest is then just the asset list */
      }
      const build = createHash('sha256')
        .update(assets.join('\n'))
        .update(indexHtml)
        .update(sw)
        .digest('hex')
        .slice(0, 12);

      const stamped = sw
        .replace("'__BUILD__'", JSON.stringify(build))
        .replace("['__ASSETS__']", JSON.stringify(assets));

      writeFileSync(swPath, stamped);
      console.log(`sw.js: build ${build}, precaching ${assets.length} built assets`);
    },
  };
}

export default defineConfig({
  /* The moment this bundle was built, shown on the account screen.

     A PWA that never activates a new worker without being asked — which is
     deliberate, see public/sw.js — can sit several builds behind while
     every deploy looks successful from the outside. "Is this device
     running the code I just shipped?" then has no answer, and a client-side
     fix that has simply not arrived yet is indistinguishable from a fix
     that does not work. That cost several rounds on the edition lookup. */
  define: {
    __BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react(), serviceWorkerAssets()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    /* `vite dev` serves the app and nothing else — there is no Worker
       behind it, so without this it answers /api and /auth with the app's
       own index.html and a 200. That is worse than a 404: the client sees
       a successful response, tries to read JSON out of an HTML document,
       and every failure downstream looks like "the catalogue had nothing".
       It cost an evening on the edition lookup.

       Pointing at wrangler's default port means `npm run dev` in one
       terminal and `wrangler dev` in another behave like the deployed app.
       With nothing listening the proxy fails loudly, which is the correct
       answer to "the API is not running" and the one that was missing. */
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/auth': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
});
