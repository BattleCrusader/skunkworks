import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// S1: the Astro app is built in **middleware mode** and mounted into the Fastify
// process (SDS §2: "app (one Node 22 process)"; §16 S1: "Astro SSR shell mounted in
// Fastify (middleware mode) in ONE Node process"). Middleware mode is the only mode
// that exports a (req,res,next) handler instead of binding its own port — a
// standalone entry would publish a second listener and violate C-11.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  srcDir: './app/render',
  outDir: './build/astro',
  publicDir: './app/render/public',
  devToolbar: { enabled: false },
  server: { port: 0 },
  build: { format: 'file' },
  trailingSlash: 'ignore',
  compressHTML: false,
  vite: {
    ssr: {
      // The native SQLite driver is never bundled: the process loads it once.
      external: ['better-sqlite3'],
    },
  },
});
