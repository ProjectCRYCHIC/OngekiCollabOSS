import { defineConfig } from "vitest/config";

// Self-hosted contract tests: run the real server in-process against the
// MariaDB/Redis provided by docker-compose.test.yml (localhost:3307/6379).
export default defineConfig({
  test: {
    include: ["tests/contract/run.selfhost*.test.ts", "tests/selfhost-config.test.ts", "tests/selfhost-runtime.test.ts"],
    fileParallelism: false,
    testTimeout: 15000,
  },
});
