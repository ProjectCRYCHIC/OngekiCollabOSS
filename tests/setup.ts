import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";
import type { Env } from "../src/types";

type TestBindings = Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

beforeAll(async () => {
  const bindings = env as TestBindings;
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
