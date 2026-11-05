import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'frontend', plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, rollupOptions: { output: {
    chunkFileNames: chunk => chunk.name.startsWith('subset-') ? 'assets/[name].js' : 'assets/[name]-[hash].js'
  } } }
});
