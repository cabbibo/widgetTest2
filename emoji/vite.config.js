import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  clearScreen: false,
  server: { port: 1421, strictPort: true },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main:     resolve(__dirname, 'index.html'),
        settings: resolve(__dirname, 'settings.html'),
        toolbar:  resolve(__dirname, 'toolbar.html'),
      },
    },
  },
});
