/*
  How long the server takes to answer the tutor, for renderer.ts forward(). Pure (no
  Electron), so it is tested on its own (scripts/tests/apiTiming.test.ts).

  Every [api] line carries the local wall clock (to line up with the [speech] and [voice]
  lines, and with `/usr/bin/log show` for tutornote-speech, which prints local time) and how
  long the answer's headers took. Those come when the stream opens: for guide/ask before the
  router or the model has done anything, for guide/tts at Speechify's first byte. So the
  tutor's streamed answers (TIMED) get a second line as their body ends: the first byte, the
  first words (an SSE "event: text"; not for tts, which is audio) and the end, all from the
  request reaching forward(), and the size:

    [api] 22:04:11.231 POST /api/.../guide/ask -> 200 142 ms
    [api] 22:04:13.902 POST /api/.../guide/ask done: first byte 150 ms, first words 2671 ms, end 6120 ms, 4120 B
    [api] 22:04:14.010 POST /api/guide/tts -> 200 610 ms
    [api] 22:04:14.420 POST /api/guide/tts done: first byte 611 ms, end 1020 ms, 31877 B

  timeBody passes every chunk on as it comes (the page reads the answer as it streams, as
  before); it never logs any of the body's words. A body the page stops reading (it navigated,
  or its tab closed) gets no "done" line.
*/

export const TIMED = /\/guide\/(ask|script|tts|explain)$/;

export function clock(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const TEXT_EVENT = new TextEncoder().encode("event: text");

function includes(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export function timeBody(
  body: ReadableStream<Uint8Array> | null,
  label: string,
  t0: number,
  log: (line: string) => void = console.log,
  now: () => number = () => performance.now(),
): ReadableStream<Uint8Array> | null {
  if (!body) return body;
  const sse = !label.endsWith("/guide/tts");
  let first = -1;
  let words = -1;
  let bytes = 0;
  const done = (how: string) => {
    const at = (ms: number) => (ms < 0 ? "none" : `${Math.round(ms)} ms`);
    log(`[api] ${clock()} ${label} ${how}: first byte ${at(first)}${sse ? `, first words ${at(words)}` : ""}, end ${Math.round(now() - t0)} ms, ${bytes} B`);
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const t = now() - t0;
        if (first < 0) first = t;
        // (an "event: text" split across two chunks is missed: this is a diagnostic)
        if (sse && words < 0 && includes(chunk, TEXT_EVENT)) words = t;
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        done("done");
      },
    }),
  );
}
