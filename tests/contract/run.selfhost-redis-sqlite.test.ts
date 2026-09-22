import { beforeAll } from "vitest";
import { describeContract } from "./suites.js";
import { createSelfhostHarness } from "./selfhost-harness.js";

const instance = createSelfhostHarness({ port: 8797, databaseBackend: "sqlite", realtimeBackend: "redis", redisDatabase: 1 });
beforeAll(() => instance.ensureStarted());
describeContract(instance.harness);
