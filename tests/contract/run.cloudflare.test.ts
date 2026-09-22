import { describeContract } from "./suites.js";
import { buildCloudflareHarness } from "./cloudflare-harness.js";

describeContract(buildCloudflareHarness());
