import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: { port: 1423, strictPort: true },
  build: { outDir: 'dist' },
});
