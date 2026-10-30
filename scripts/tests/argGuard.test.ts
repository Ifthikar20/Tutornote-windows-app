import { test } from "node:test";
import assert from "node:assert/strict";
import { FORBIDDEN_SWITCHES, offendingSwitch } from "../../src/main/argGuard.ts";

/*
  The command-line switch guard (src/main/argGuard.ts): index.ts exits a packaged build when any
  of these is present (WHAT_TO_FIX.md WIN-03 / MAC-03).
*/

test("no forbidden switch: nothing offends", () => {
  assert.equal(offendingSwitch(() => false), null);
  const ordinary = new Set(["enable-logging", "lang", "no-sandbox-is-not-here"]);
  assert.equal(
    offendingSwitch((name) => ordinary.has(name)),
    null,
  );
});

test("a debugging or proxy switch is caught", () => {
  for (const name of ["remote-debugging-port", "inspect", "proxy-server", "ignore-certificate-errors", "gpu-launcher"]) {
    assert.equal(
      offendingSwitch((s) => s === name),
      name,
    );
  }
});

test("the first switch in the list order is reported", () => {
  const present = new Set(["proxy-server", "inspect"]);
  // inspect comes before proxy-server in FORBIDDEN_SWITCHES.
  assert.equal(
    offendingSwitch((name) => present.has(name)),
    "inspect",
  );
  assert.ok(FORBIDDEN_SWITCHES.includes("remote-debugging-pipe"));
});
