import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Los tests comparten una base de datos real y algunos hacen DDL
    // (migraciones arriba y abajo). En paralelo se pisarían entre ellos.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['test/**/*.test.ts'],
  },
});
