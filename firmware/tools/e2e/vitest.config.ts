import { resolve } from "node:path";

// Run from firmware/ via tools/run_e2e.sh. Root is the bridge so wrangler/vitest resolve there.
export default {
  root: resolve(__dirname, "../../../bridge"),
  test: {
    environment: "node",
    include: [resolve(__dirname, "*.e2e.test.ts")],
    testTimeout: 40_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
};
