import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Evidence-index fixtures (2,000-file builds, per-test TypeScript
    // compiler programs, git repos, SQL.js) block the worker event loop for
    // seconds at a time. Unbounded thread workers starve Vitest's
    // onTaskUpdate heartbeat under parallel load and fail the run without
    // any assertion failing. Process isolation plus a bounded worker count
    // keeps heartbeats responsive; no timeout inflation, no retries.
    pool: "forks",
    maxWorkers: 4
  }
});
