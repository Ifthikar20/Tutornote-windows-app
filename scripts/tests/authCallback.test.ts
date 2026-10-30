import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCallback, consumesPending, type PendingSignIn } from "../../src/main/authCallback.ts";

/*
  The deep-link callback classifier (src/main/authCallback.ts). The key property: a link whose
  state is not the waiting sign-in's never consumes that sign-in and never pops the "expired"
  dialog, so a web page firing the scheme cannot cancel a sign-in in flight
  (WHAT_TO_FIX.md WIN-06 / MAC-07).
*/

const OPTS = { schemes: ["tutornote", "anothernotes"] as const, ttlMs: 10 * 60 * 1000, token: /^[A-Za-z0-9_-]{16,128}$/ };
const CODE = "abcdefghijklmnop"; // 16 chars, matches the token shape
const pending = (over: Partial<PendingSignIn> = {}): PendingSignIn => ({ state: "the-right-state", verifier: "the-verifier", startedAt: 1000, ...over });

test("a well-formed callback with the right state is accepted and consumes the sign-in", () => {
  const r = classifyCallback(`tutornote://auth/callback?code=${CODE}&state=the-right-state`, pending(), 1000 + 5000, OPTS);
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") {
    assert.equal(r.code, CODE);
    assert.equal(r.verifier, "the-verifier");
  }
  assert.equal(consumesPending(r), true);
});

test("the legacy scheme is accepted too", () => {
  const r = classifyCallback(`anothernotes://auth/callback?code=${CODE}&state=the-right-state`, pending(), 1000, OPTS);
  assert.equal(r.kind, "ok");
});

test("a wrong state is ignored and the sign-in is KEPT", () => {
  const r = classifyCallback(`tutornote://auth/callback?code=${CODE}&state=attacker`, pending(), 1000, OPTS);
  assert.equal(r.kind, "wrong-state");
  assert.equal(consumesPending(r), false);
});

test("an empty state from an attacker link is a wrong state, not a match", () => {
  const r = classifyCallback(`tutornote://auth/callback?code=${CODE}`, pending(), 1000, OPTS);
  assert.equal(r.kind, "wrong-state");
  assert.equal(consumesPending(r), false);
});

test("no pending sign-in: ignored, no dialog", () => {
  const r = classifyCallback(`tutornote://auth/callback?code=${CODE}&state=whatever`, null, 1000, OPTS);
  assert.equal(r.kind, "no-pending");
  assert.equal(consumesPending(r), false);
});

test("the right state but too late: expired, and the sign-in is consumed", () => {
  const r = classifyCallback(`tutornote://auth/callback?code=${CODE}&state=the-right-state`, pending({ startedAt: 0 }), 10 * 60 * 1000 + 1, OPTS);
  assert.equal(r.kind, "expired");
  assert.equal(consumesPending(r), true);
});

test("the right state, in time, but a malformed code: bad-code, consumed", () => {
  const r = classifyCallback("tutornote://auth/callback?code=%20&state=the-right-state", pending(), 1000, OPTS);
  assert.equal(r.kind, "bad-code");
  assert.equal(consumesPending(r), true);
});

test("a non-callback link is left alone and keeps the sign-in", () => {
  for (const raw of ["tutornote://open", "tutornote://auth/other", "https://example.test/", "not a url"]) {
    const r = classifyCallback(raw, pending(), 1000, OPTS);
    assert.equal(r.kind, "not-callback", raw);
    assert.equal(consumesPending(r), false);
  }
});
