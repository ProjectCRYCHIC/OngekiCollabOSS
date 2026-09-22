import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        IDENTITY_HASH_SECRET: Buffer.alloc(32, 1).toString("base64"),
        KEY_ENCRYPTION_SECRET: Buffer.alloc(32, 2).toString("base64"),
        TICKET_SIGNING_SECRET: Buffer.alloc(32, 3).toString("base64"),
        ADMIN_RESET_SECRET: Buffer.alloc(32, 4).toString("base64"),
        ACCESS_TEAM_DOMAIN: "https://collab-test.cloudflareaccess.com",
        ACCESS_AUD: "test-admin-audience",
        TEST_MIGRATIONS: await readD1Migrations(path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations")),
      },
    },
  }))],
  test: {
    setupFiles: ["./tests/setup.ts"],
    // The Cloudflare runtime tests; the self-hosted contract run uses
    // vitest.selfhost.config.ts (plain Node).
    include: ["tests/integration.test.ts", "tests/room-engine.test.ts", "tests/contract/run.cloudflare.test.ts"],
  },
});
