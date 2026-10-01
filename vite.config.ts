/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  resolve: {
    alias: {
      // paper-full 在模块导入时即自动初始化视图（需要真实 Canvas）；
      // paper-core 提供同一套 API 但只在 PaperScope.setup 时才绑定，测试与多 scope 场景更安全。
      paper: 'paper/dist/paper-core.js',
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
