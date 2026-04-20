// Vitest config — only exercises the main-process pure modules under
// src/main/. The Electron renderer is covered by `vite build` smoke checks
// elsewhere; mocking Electron's full runtime in unit tests would be a lot
// of scaffolding for little gain.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/main/__tests__/**/*.test.js'],
    // Don't bail — we want to see every failure on CI
    bail: 0,
    globals: false,
  },
});
