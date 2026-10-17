import { defineConfig } from 'tsup';

// Workspace packages ship as TypeScript source and are bundled into the app. Every other bare
// import (third-party packages, node builtins) stays external and is installed in the image.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@neuroflow\//],
  external: [/^[^./@]/, /^@(?!neuroflow\/)/],
});
