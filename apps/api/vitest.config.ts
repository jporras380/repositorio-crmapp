import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { target: 'es2022' },
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['test/**/*.test.ts'],
  },
});
