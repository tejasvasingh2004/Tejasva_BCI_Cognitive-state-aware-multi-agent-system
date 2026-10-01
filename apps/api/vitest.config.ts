import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Integration suites each run a full API + worker stack on the shared test Redis/queue;
    // running them concurrently would let one suite's worker pick up another suite's jobs.
    fileParallelism: false,
  },
});
