import { defineConfig } from 'vite';

// The SPA lives in web/ and deploys to GitHub Pages at /agents-portal/.
export default defineConfig({
  root: 'web',
  // GitHub Pages serves the project site under /<repo>/. Override with
  // VITE_BASE=/ for local `tailscale serve` hosting at the domain root.
  base: process.env.VITE_BASE ?? '/agents-portal/',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
