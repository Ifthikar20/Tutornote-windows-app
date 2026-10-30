import { test } from "node:test";
import assert from "node:assert/strict";
import { devValue } from "../../src/main/env.ts";

/*
  The environment-override gate (src/main/env.ts): config.ts reads ANOTHERNOTES_URL and the rest
  through this, so a packaged app ignores them and only a development build honours them
  (WHAT_TO_FIX.md WIN-02 / MAC-02).
*/

test("a development build keeps the value", () => {
  assert.equal(devValue("https://example.test", false), "https://example.test");
  assert.equal(devValue("1", false), "1");
  assert.equal(devValue(undefined, false), undefined);
});

test("a packaged app drops every override", () => {
  assert.equal(devValue("https://evil.example", true), undefined);
  assert.equal(devValue("1", true), undefined);
  assert.equal(devValue("the team key", true), undefined);
});
