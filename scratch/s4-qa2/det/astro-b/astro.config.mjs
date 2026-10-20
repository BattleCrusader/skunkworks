import { defineConfig } from 'astro/config';

// A **static** build: the client's server runs no Node process (SDS §11.1, last row).
// `compressHTML: false` is not cosmetic — the hosted product serves its shell with the
// template's own whitespace, and the export gate asserts the built document is
// byte-identical to a live response.
export default defineConfig({
  output: 'static',
  srcDir: './src',
  publicDir: './public',
  outDir: './dist',
  build: { format: 'directory' },
  trailingSlash: 'ignore',
  compressHTML: false,
  devToolbar: { enabled: false },
});
