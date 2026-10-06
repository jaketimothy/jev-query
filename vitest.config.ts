import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite data directories can only be opened by one process at a time
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
