import { beforeAll } from "vitest";
import { describeContract } from "./suites.js";
import { createSelfhostHarness } from "./selfhost-harness.js";

const instance = createSelfhostHarness({ port: 8798, databaseBackend: "sqlite", realtimeBackend: "memory" });
beforeAll(() => instance.ensureStarted());
describeContract(instance.harness);
