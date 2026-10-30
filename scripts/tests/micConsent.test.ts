import { test } from "node:test";
import assert from "node:assert/strict";
import { answerOf, createMicConsent, fileOf, type MicAnswer, type MicStore } from "../../src/main/micConsent.ts";

/*
  The app's own microphone question (src/main/micConsent.ts): asked once, the answer kept in a
  file, and honoured after that without asking; one question for requests that come together;
  a file that is not one of ours is no answer (WHAT_TO_FIX.md WIN-07 / MAC-08).
*/

const AT = new Date("2026-10-30T12:00:00.000Z");

function memory(text: string | null = null): MicStore & { text: string | null; writes: number } {
  const store = {
    text,
    writes: 0,
    read: () => store.text,
    write: (next: string) => {
      store.text = next;
      store.writes += 1;
    },
    now: () => AT,
  };
  return store;
}

/** A question that answers `answer`, counting how often it was put. */
function asker(answer: MicAnswer | null) {
  const ask = Object.assign(async () => {
    ask.times += 1;
    return answer;
  }, { times: 0 });
  return ask;
}

test("the file's text is read back as the answer it holds", () => {
  assert.equal(answerOf(fileOf("allow", AT)), "allow");
  assert.equal(answerOf(fileOf("deny", AT)), "deny");
  assert.deepEqual(JSON.parse(fileOf("deny", AT)), { microphone: "deny", answeredAt: "2026-10-30T12:00:00.000Z" });
});

test("no file, or a file that is not one of ours, is no answer", () => {
  for (const text of [null, "", "{", "null", "[]", '"allow"', '{"microphone":"yes"}', '{"microphone":true}', '{"mic":"allow"}']) {
    assert.equal(answerOf(text), null, String(text));
  }
});

test("with no answer kept, the student is asked once and the answer is kept", async () => {
  const store = memory();
  const consent = createMicConsent(store);
  const ask = asker("allow");
  assert.equal(consent.answer(), null);
  assert.equal(await consent.allowed(ask), true);
  assert.equal(ask.times, 1);
  assert.equal(consent.answer(), "allow");
  assert.equal(answerOf(store.text), "allow");
  // From then on the kept answer stands: no second question.
  assert.equal(await consent.allowed(ask), true);
  assert.equal(ask.times, 1);
});

test("a no is kept and refuses without asking again, in this run and the next", async () => {
  const store = memory();
  const first = createMicConsent(store);
  assert.equal(await first.allowed(asker("deny")), false);
  const ask = asker("allow");
  assert.equal(await first.allowed(ask), false);
  // The next launch reads the file.
  const next = createMicConsent(store);
  assert.equal(next.answer(), "deny");
  assert.equal(await next.allowed(ask), false);
  assert.equal(ask.times, 0);
});

test("requests that come together share one question", async () => {
  const consent = createMicConsent(memory());
  let answer: (value: MicAnswer) => void = () => undefined;
  let times = 0;
  const ask = () => {
    times += 1;
    return new Promise<MicAnswer>((resolve) => (answer = resolve));
  };
  const both = Promise.all([consent.allowed(ask), consent.allowed(ask), consent.allowed(ask)]);
  await Promise.resolve();
  answer("allow");
  assert.deepEqual(await both, [true, true, true]);
  assert.equal(times, 1);
});

test("a question closed with no answer refuses this time and is put again next time", async () => {
  const store = memory();
  const consent = createMicConsent(store);
  assert.equal(await consent.allowed(asker(null)), false);
  assert.equal(consent.answer(), null);
  assert.equal(store.writes, 0);
  const ask = asker("allow");
  assert.equal(await consent.allowed(ask), true);
  assert.equal(ask.times, 1);
});

test("a question that fails refuses, keeps nothing, and is put again next time", async () => {
  const consent = createMicConsent(memory());
  assert.equal(await consent.allowed(() => Promise.reject(new Error("no window"))), false);
  assert.equal(
    await consent.allowed(() => {
      throw new Error("no dialog");
    }),
    false,
  );
  assert.equal(consent.answer(), null);
  assert.equal(await consent.allowed(asker("allow")), true);
});

test("the menu's answer replaces the student's and is kept; every answer is told", async () => {
  const store = memory(fileOf("allow", AT));
  const told: MicAnswer[] = [];
  const consent = createMicConsent(store, (answer) => told.push(answer));
  assert.equal(consent.answer(), "allow");
  consent.set("deny");
  assert.equal(answerOf(store.text), "deny");
  assert.equal(await consent.allowed(asker("allow")), false);
  consent.set("allow");
  assert.equal(await consent.allowed(asker("deny")), true);
  assert.deepEqual(told, ["deny", "allow"]);
});

test("an answer that cannot be written still holds for this run", async () => {
  const store = memory();
  store.write = () => {
    throw new Error("read-only folder");
  };
  const consent = createMicConsent(store);
  assert.equal(await consent.allowed(asker("deny")), false);
  assert.equal(consent.answer(), "deny");
  assert.equal(await consent.allowed(asker("allow")), false);
});

test("a file that cannot be read is no answer: the student is asked", async () => {
  const store = memory();
  store.read = () => {
    throw new Error("unreadable");
  };
  const consent = createMicConsent(store);
  const ask = asker("allow");
  assert.equal(await consent.allowed(ask), true);
  assert.equal(ask.times, 1);
});
