import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// The daemon's QA/observe/agentic tests are authored for Node's built-in test
// runner (`node:test`) and are executed via `node --test` in the daemon lane —
// they carry no vitest suite, so vitest's `**/*.test.mjs` glob would collect
// them and fail with "No test suite found". Exclude that node:test family here
// (they run green under `cd daemon && node --test …`, their intended runner).
const NODE_TEST_DAEMON = [
  '**/daemon/lib/__tests__/agentic-vqa-runner.test.mjs',
  '**/daemon/lib/__tests__/p3-qa-agentic-integration.test.mjs',
  '**/daemon/lib/__tests__/p3-qa-runner-observe.test.mjs',
  '**/daemon/lib/__tests__/browser-probe-observe.test.mjs',
  '**/daemon/lib/__tests__/p3-journey-source-observe.test.mjs',
];

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['**/*.test.{ts,tsx,mjs}'],
    exclude: [...configDefaults.exclude, ...NODE_TEST_DAEMON],
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}', 'functions/**/*.ts'],
      exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts', 'src/app/**/layout.tsx'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
