import { assertSupportedRuntime } from "./runtimeCheck.js";

assertSupportedRuntime();
await import("./index.js");
