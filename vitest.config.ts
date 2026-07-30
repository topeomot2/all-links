import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  test: {
    include: ['packages/*/src/**/*.test.ts?(x)', 'infra/test/**/*.test.ts'],
    // CDK template synthesis is slower than a unit test but still well inside this.
    testTimeout: 30_000,
  },
});
