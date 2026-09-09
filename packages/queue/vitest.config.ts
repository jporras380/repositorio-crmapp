import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Los tests del outbox hacen DDL sobre una base propia; en paralelo con
    // los del semáforo no hay conflicto, pero el orden determinista ayuda a
    // leer los fallos.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['test/**/*.test.ts'],
  },
});
