import { beforeAll } from "vitest";
import { describeContract } from "./suites.js";
import { buildSelfhostHarness, ensureStarted } from "./selfhost-harness.js";

beforeAll(() => ensureStarted());
describeContract(buildSelfhostHarness());
