import {defineConfig} from 'vitest/config';
// Separate from upstream's service-heavy setup. Tests own a local fixture DB and
// inject a mock Resend transport; no credentials or real email sends are used.
export default defineConfig({
  test: {
    environment: 'node',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15000,
    include: ['apps/api/src/isla/__tests__/*.test.ts'],
  },
});
