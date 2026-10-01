import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// clipper2-wasm ships a .wasm side file; Vite handles ?init bundling automatically.
export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['clipper2-wasm']
  }
});
