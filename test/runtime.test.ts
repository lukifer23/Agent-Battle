import test from "node:test";
import assert from "node:assert/strict";
import { runtimeSatisfies } from "../src/server/runtimeCheck.js";

test("the supported runtime is Node.js 22.13.0 or newer", () => {
  assert.equal(runtimeSatisfies("20.19.0"), false);
  assert.equal(runtimeSatisfies("22.12.9"), false);
  assert.equal(runtimeSatisfies("22.13.0"), true);
  assert.equal(runtimeSatisfies("22.13.1"), true);
  assert.equal(runtimeSatisfies("24.0.0"), true);
  assert.equal(runtimeSatisfies("v22.13.0"), false);
  assert.equal(runtimeSatisfies(process.versions.node), true);
});
