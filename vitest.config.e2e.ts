import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Spec files share one database, and the background jobs (outbox, reconciler)
    // act on ALL due rows, not just one spec's. Run files one at a time.
    fileParallelism: false,
  },
});
