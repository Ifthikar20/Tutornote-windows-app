import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, timeBody, TIMED } from "../../src/main/apiTiming.ts";

/*
  The [api] timing of the tutor's streamed answers (src/main/apiTiming.ts): the body reaches the
  page chunk by chunk, untouched and in order, as it arrives, and its end is logged with the first
  byte, the first words and the end, and never a word of it. A fake clock stands in for
  performance.now().
*/

test("chunks pass through one by one, and the done line has first byte, first words and end", async () => {
  let t = 0;
  const lines: string[] = [];
  let push!: (s: string) => void;
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      push = (s) => c.enqueue(new TextEncoder().encode(s));
      close = () => c.close();
    },
  });
  const out = timeBody(body, "POST /api/study-sessions/x/topics/-1/guide/ask", 0, (l) => lines.push(l), () => t)!;
  const reader = out.getReader();
  t = 120;
  push("event: target\ndata: {}\n\n");
  assert.equal(new TextDecoder().decode((await reader.read()).value), "event: target\ndata: {}\n\n");
  t = 1900;
  push('event: text\ndata: {"delta":"Osmosis is "}\n\n');
  assert.match(new TextDecoder().decode((await reader.read()).value), /Osmosis/);
  t = 4000;
  close();
  assert.equal((await reader.read()).done, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /guide\/ask done: first byte 120 ms, first words 1900 ms, end 4000 ms, \d+ B$/);
  assert.doesNotMatch(lines[0], /Osmosis/); // never the words themselves
});

test("tts has no first-words field", async () => {
  const lines: string[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([0xff, 0xfb, 0x90]));
      c.close();
    },
  });
  const out = timeBody(body, "POST /api/guide/tts", 0, (l) => lines.push(l), () => 600)!;
  for await (const _ of out) void _;
  assert.match(lines[0], /guide\/tts done: first byte 600 ms, end 600 ms, 3 B$/);
});

test("the bytes come out exactly as they went in, in order", async () => {
  const sent = [new Uint8Array([1, 2, 3]), new TextEncoder().encode("event: text\n"), new Uint8Array([0, 255])];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of sent) c.enqueue(chunk);
      c.close();
    },
  });
  const lines: string[] = [];
  const got: number[][] = [];
  for await (const chunk of timeBody(body, "POST /api/guide/explain", 0, (l) => lines.push(l), () => 5)!) got.push([...chunk]);
  assert.deepEqual(got, sent.map((c) => [...c]));
  assert.match(lines[0], /^\[api\] \d\d:\d\d:\d\d\.\d{3} POST \/api\/guide\/explain done: first byte 5 ms, first words 5 ms, end 5 ms, 17 B$/);
});

test("no body, nothing to time", () => {
  assert.equal(timeBody(null, "POST /api/guide/ask", 0, () => assert.fail("logged")), null);
});

test("which paths are timed, and the clock's shape", () => {
  assert.ok(TIMED.test("/api/study-sessions/a/topics/-1/guide/ask"));
  assert.ok(TIMED.test("/api/guide/tts"));
  assert.ok(!TIMED.test("/api/analytics/events"));
  assert.match(clock(new Date(2026, 9, 26, 22, 4, 11, 31)), /^22:04:11\.031$/);
});
