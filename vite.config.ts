import { defineConfig } from 'vite';

// The SPA lives in web/ and deploys to GitHub Pages at /agents-portal/.
export default defineConfig({
  root: 'web',
  // Agent-served at the domain root by default. The Pages workflow sets
  // VITE_BASE=/agents-portal/ for the github.io project site.
  base: process.env.VITE_BASE ?? '/',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
