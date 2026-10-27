import { test } from "node:test";
import assert from "node:assert/strict";
import { HINT_CHARS, HINTS_MAX, speechLine, speechOutputOf, speechStartOptions, stamp } from "../../src/main/speechLog.ts";

/*
  The speech helper's log lines and a page's start options (src/main/speechLog.ts). The times are
  local (new Date(y, m, d, ...)), as the log writes them, so the lines read the same in any time
  zone. Every line below is one of section 5.1 of the voice spec, as written there.
*/

const at = (h: number, m: number, s: number, ms: number): Date => new Date(2026, 9, 26, h, m, s, ms);

test("stamp is the local clock to the millisecond", () => {
  assert.equal(stamp(new Date(2026, 9, 26, 22, 4, 1, 9)), "22:04:01.009");
  assert.equal(stamp(new Date(2026, 0, 1, 0, 0, 0, 0)), "00:00:00.000");
  assert.equal(stamp(new Date(2026, 0, 1, 9, 30, 59, 999)), "09:30:59.999");
});

test("a pre roll: kept when recent, brought to 1500 ms back, dropped when stale, ahead or not a number", () => {
  const now = 1_761_512_640_000;
  assert.deepEqual(speechStartOptions({ preroll: now - 200 }, now), { preroll: now - 200 });
  assert.deepEqual(speechStartOptions({ preroll: now }, now), { preroll: now });
  assert.deepEqual(speechStartOptions({ preroll: now - 2000 }, now), { preroll: now - 1500 });
  assert.deepEqual(speechStartOptions({ preroll: now - 5000 }, now), { preroll: now - 1500 });
  assert.deepEqual(speechStartOptions({ preroll: now - 9000 }, now), {});
  assert.deepEqual(speechStartOptions({ preroll: now + 1 }, now), {});
  assert.deepEqual(speechStartOptions({ preroll: Number.NaN }, now), {});
  assert.deepEqual(speechStartOptions({ preroll: Infinity }, now), {});
  assert.deepEqual(speechStartOptions({ preroll: String(now) }, now), {});
});

test("hints: strings only, trimmed, no empty ones, each cut to 40 characters, at most 50", () => {
  const now = 1_000_000;
  const long = "photosynthesis and cellular respiration in plants";
  const out = speechStartOptions({ hints: [" osmosis ", "", "   ", 7, null, long, { x: 1 }] }, now);
  assert.deepEqual(out, { hints: ["osmosis", long.slice(0, 40)] });
  assert.equal(HINT_CHARS, 40);
  const sixty = Array.from({ length: 60 }, (_, i) => `word ${i}`);
  const many = speechStartOptions({ hints: sixty }, now).hints ?? [];
  assert.equal(many.length, HINTS_MAX);
  assert.equal(HINTS_MAX, 50);
  assert.deepEqual(many, sixty.slice(0, 50));
  assert.deepEqual(speechStartOptions({ hints: ["", " "] }, now), {});
  assert.deepEqual(speechStartOptions({ hints: "osmosis" }, now), {});
  // (characters, not UTF-16 units: an emoji is never split)
  assert.equal(speechStartOptions({ hints: ["🙂".repeat(45)] }, now).hints?.[0], "🙂".repeat(40));
});

test("anything but an object is no options", () => {
  for (const raw of [undefined, null, 5, "x", true]) assert.deepEqual(speechStartOptions(raw, 1000), {});
  assert.deepEqual(speechStartOptions({ preroll: 900, hints: ["a"], other: 1 }, 1000), { preroll: 900, hints: ["a"] });
});

test("each 5.1 line, exactly", () => {
  assert.equal(speechLine.helperStarted(at(22, 4, 0, 20), 21946), "[speech] 22:04:00.020 helper started (pid 21946)");
  assert.equal(speechLine.prepared(at(22, 4, 0, 140), "en-US", true, 112), "[speech] 22:04:00.140 prepared en-US on this Mac in 112 ms");
  assert.equal(speechLine.mic(at(22, 4, 0, 104), true, "warm"), "[speech] 22:04:00.104 mic on (warm)");
  assert.equal(speechLine.mic(at(22, 4, 0, 104), true, "session"), "[speech] 22:04:00.104 mic on (session)");
  assert.equal(speechLine.mic(at(22, 4, 0, 104), false, "session"), "[speech] 22:04:00.104 mic off");
  assert.equal(
    speechLine.route(at(22, 4, 0, 105), {
      input: "AirPods Pro",
      transport: "bluetooth",
      using: "MacBook Pro Microphone",
      usingTransport: "builtin",
      changed: false,
    }),
    "[speech] 22:04:00.105 input: AirPods Pro (bluetooth), using MacBook Pro Microphone (builtin)",
  );
  assert.equal(speechLine.start(at(22, 4, 0, 230), 7, true, 126), "[speech] 22:04:00.230 #7 start (continuous, preroll 126 ms asked)");
  assert.equal(speechLine.ready(at(22, 4, 0, 236), 7, true, "en-US", true, 0), "[speech] 22:04:00.236 #7 on this Mac (en-US), recogniser cached");
  assert.equal(
    speechLine.live(at(22, 4, 0, 237), 7, 7, true, 126),
    "[speech] 22:04:00.237 #7 live +7 ms (mic was on, 126 ms of audio from before the start)",
  );
  assert.equal(speechLine.firstWords(at(22, 4, 1, 890), 7, 1660), "[speech] 22:04:01.890 #7 first words +1660 ms");
  assert.equal(
    speechLine.phrase(at(22, 4, 6, 330), 7, 9, "quiet", 512),
    "[speech] 22:04:06.330 #7 phrase: 9 words, cut quiet, voice ended 512 ms before",
  );
  assert.equal(speechLine.end(at(22, 4, 6, 951), 7, { endedBy: "stop" }), "[speech] 22:04:06.951 #7 end after stop");
  assert.equal(speechLine.end(at(22, 4, 6, 951), 7, { endedBy: "abort", error: "aborted" }), "[speech] 22:04:06.951 #7 end after abort");
  assert.equal(speechLine.end(at(22, 4, 6, 951), 7, { error: "not-allowed" }), "[speech] 22:04:06.951 #7 end, error not-allowed");
  assert.equal(
    speechLine.route(at(22, 4, 31, 0), { input: "External Microphone", transport: "usb", using: "External Microphone", usingTransport: "usb", changed: true }),
    "[speech] 22:04:31.000 audio route changed: External Microphone (usb)",
  );
});

test("the other forms of the same lines", () => {
  const t = at(9, 0, 0, 0);
  assert.equal(speechLine.prepared(t, "fr-FR", false, 87.4), "[speech] 09:00:00.000 prepared fr-FR for Apple's server in 87 ms");
  assert.equal(
    speechLine.route(t, { input: "MacBook Pro Microphone", transport: "builtin", using: "MacBook Pro Microphone", usingTransport: "builtin", changed: false }),
    "[speech] 09:00:00.000 input: MacBook Pro Microphone (builtin)",
  );
  assert.equal(speechLine.start(t, 8, false), "[speech] 09:00:00.000 #8 start (one utterance)");
  assert.equal(speechLine.ready(t, 8, false, "en-GB", false, 112.6), "[speech] 09:00:00.000 #8 Apple's server (en-GB), recogniser made in 113 ms");
  assert.equal(speechLine.ready(t, 8, true, "en-US"), "[speech] 09:00:00.000 #8 on this Mac (en-US)");
  assert.equal(speechLine.live(t, 8, 310.2, false, 0), "[speech] 09:00:00.000 #8 live +310 ms (mic started)");
  assert.equal(speechLine.live(t, 8, 4, true, 0), "[speech] 09:00:00.000 #8 live +4 ms (mic was on)");
  assert.equal(speechLine.phrase(t, 8, 1, "text"), "[speech] 09:00:00.000 #8 phrase: 1 word, cut text");
  assert.equal(speechLine.end(t, 8), "[speech] 09:00:00.000 #8 end");
});

test("the output line: the device, its transport and data source, and whether the mic can hear it", () => {
  assert.equal(
    speechLine.output(at(22, 4, 0, 31), { name: "MacBook Pro Speakers", transport: "builtin", source: "ispk", speakers: true, changed: false }),
    "[speech] 22:04:00.031 output: MacBook Pro Speakers (builtin, ispk): speakers",
  );
  assert.equal(
    speechLine.output(at(22, 5, 12, 400), { name: "AirPods Pro", transport: "bluetooth", source: "", speakers: false, changed: true }),
    "[speech] 22:05:12.400 output changed: AirPods Pro (bluetooth): headphones",
  );
  assert.equal(
    speechLine.output(at(9, 0, 0, 0), { name: "MacBook Pro Speakers", transport: "builtin", source: "hdpn", speakers: false, changed: true }),
    "[speech] 09:00:00.000 output changed: MacBook Pro Speakers (builtin, hdpn): headphones",
  );
  assert.equal(
    speechLine.output(at(9, 0, 0, 0), { name: "", transport: "", source: "", speakers: true, changed: false }),
    "[speech] 09:00:00.000 output: unknown device (unknown): speakers",
  );
});

test("the helper's output event: strings cut to size, speakers a boolean, anything else dropped", () => {
  assert.deepEqual(
    speechOutputOf({ ev: "output", name: "MacBook Pro Speakers", transport: "builtin", source: "ispk", speakers: true, changed: false }),
    { name: "MacBook Pro Speakers", transport: "builtin", source: "ispk", speakers: true, changed: false },
  );
  assert.deepEqual(speechOutputOf({ name: " AirPods Pro ", transport: "bluetooth", speakers: false, changed: true }), {
    name: "AirPods Pro",
    transport: "bluetooth",
    source: "",
    speakers: false,
    changed: true,
  });
  // (no verdict: nothing this side can use; the page then keeps to speakers)
  assert.equal(speechOutputOf({ name: "AirPods Pro", transport: "bluetooth" }), null);
  assert.equal(speechOutputOf({ name: "AirPods Pro", speakers: "false" }), null);
  for (const raw of [undefined, null, 5, "output", true]) assert.equal(speechOutputOf(raw), null);
  // Not strings: empty; too long: cut (by characters).
  const odd = speechOutputOf({ name: 7, transport: { x: 1 }, source: "ispkispkispk", speakers: true, changed: "yes" });
  assert.deepEqual(odd, { name: "", transport: "", source: "ispkispk", speakers: true, changed: false });
  assert.equal(speechOutputOf({ name: "🎧".repeat(200), speakers: false })?.name, "🎧".repeat(128));
});
