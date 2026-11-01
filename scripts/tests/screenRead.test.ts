import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScreenInk, ScreenRead } from "../../src/main/screen.ts";
import { drawingOf, INK_CELLS_MOST, inkOf, readOf, rectOf, rereadLine, RULES_MOST, rulesOf, toLocal, turnReadLine, withoutDrawing } from "../../src/main/screenRead.ts";

/*
  A read made fit to pass on (src/main/screenRead.ts): the page's drawing kept only where well
  formed and never with a glance, and the whole read moved into the lesson window's own points.
  Every read here is made up: a window at (300, 140) on a display whose overlay starts at (0, 25),
  two lines of made-up words, never words read from a screen.
*/

const ORIGIN = { x: 0, y: 25 };

/** `cols` x `rows` cells with the cells in `set` on, as the helper sends them (base64, row-major,
 *  cell i in bit i & 7 of byte i >> 3). */
function grid(cols: number, rows: number, set: number[] = [], at = { x: 320, y: 180 }): ScreenInk {
  const bytes = Buffer.alloc(Math.ceil((cols * rows) / 8));
  for (const i of set) bytes[i >> 3] |= 1 << (i & 7);
  return { x: at.x, y: at.y, cell: 8, cols, rows, bits: bytes.toString("base64") };
}

/** A read as today's helper answers a lesson: lines and words, and what an older read never had. */
function read(over: Record<string, unknown> = {}): ScreenRead {
  return {
    app: "Preview",
    bundle: "com.apple.Preview",
    title: "Sample title",
    window: 4242,
    pid: 77,
    frame: { x: 300, y: 140, w: 800, h: 1000 },
    lines: [
      {
        t: "alpha bravo",
        c: 0.98,
        x: 360,
        y: 220,
        w: 200,
        h: 20,
        words: [
          { t: "alpha", x: 360, y: 220, w: 90, h: 20 },
          { t: "bravo", x: 460, y: 220, w: 100, h: 20, wg: true },
        ],
      },
      { t: "charlie", c: 0.9, x: 360, y: 250, w: 120, h: 20 },
    ],
    captureMs: 120,
    ocrMs: 640,
    ground: 0.94,
    level: "accurate",
    ...over,
  } as ScreenRead;
}

const PAPER = { x: 320, y: 180, w: 612, h: 792 };
const RULES = [
  { x: 360, y: 300, w: 200, h: 1.5 },
  { x: 360, y: 340, w: 200, h: 2 },
];

test("an old read, with no drawing, comes out as it always did", () => {
  const old = read({ id: 9, ev: "read", wordless: 0, guessed: 1, heldMs: 300 });
  assert.deepEqual(toLocal(old, ORIGIN), {
    app: "Preview",
    bundle: "com.apple.Preview",
    title: "Sample title",
    window: 4242,
    pid: 77,
    frame: { x: 300, y: 115, w: 800, h: 1000 },
    lines: [
      {
        t: "alpha bravo",
        c: 0.98,
        x: 360,
        y: 195,
        w: 200,
        h: 20,
        words: [
          { t: "alpha", x: 360, y: 195, w: 90, h: 20 },
          { t: "bravo", x: 460, y: 195, w: 100, h: 20, wg: true },
        ],
      },
      { t: "charlie", c: 0.9, x: 360, y: 225, w: 120, h: 20 },
    ],
    captureMs: 120,
    ocrMs: 640,
    ground: 0.94,
    level: "accurate",
  });
  // (a read from a helper older than the level and the ground: neither is made up)
  const older = toLocal(read({ ground: undefined, level: undefined }), ORIGIN);
  assert.equal("ground" in older, false);
  assert.equal("level" in older, false);
  for (const key of ["paper", "rules", "ink"]) assert.equal(key in older, false, key);
});

test("the paper, every rule and the ink grid's corner move with the words; the grid's cells do not", () => {
  const ink = grid(10, 12, [0, 13, 119]);
  const before = read({ paper: PAPER, rules: RULES, ink });
  const copy = structuredClone(before);
  const local = toLocal(before, { x: 300, y: 25 });
  assert.deepEqual(local.paper, { x: 20, y: 155, w: 612, h: 792 });
  assert.deepEqual(local.rules, [
    { x: 60, y: 275, w: 200, h: 1.5 },
    { x: 60, y: 315, w: 200, h: 2 },
  ]);
  assert.deepEqual(local.ink, { x: 20, y: 155, cell: 8, cols: 10, rows: 12, bits: ink.bits });
  assert.equal(local.lines[0].x, 60);
  assert.equal(local.lines[0].words?.[1].y, 195);
  // (the read it was given is left as it was)
  assert.deepEqual(before, copy);
  // (no rules found, the geometry worked out: an empty list, kept)
  assert.deepEqual(toLocal(read({ ink, rules: [] }), ORIGIN).rules, []);
});

test("a glance never carries the page's drawing", () => {
  const drawn = { paper: PAPER, rules: RULES, ink: grid(4, 4) };
  const fast = toLocal(read({ ...drawn, level: "fast" }), ORIGIN);
  for (const key of ["paper", "rules", "ink"]) assert.equal(key in fast, false, key);
  assert.equal(fast.level, "fast");
  // (asked for fast and read again accurately by the helper: a glance all the same)
  const again = readOf({ id: 3, ev: "read", ...read(), ...drawn }, true);
  for (const key of ["paper", "rules", "ink"]) assert.equal(key in again, false, key);
  assert.equal(again.level, "accurate");
  const glanced = readOf({ ...read({ level: "fast" }), ...drawn }, false);
  for (const key of ["paper", "rules", "ink"]) assert.equal(key in glanced, false, key);
  // (a glance from an accurate read, the lesson's own or a tap's careful one, as the companion sends
  // it: its lines and the rest, not its drawing; the read it keeps is left as it was)
  const careful = toLocal(read(drawn), ORIGIN);
  const copy = structuredClone(careful);
  const bare = withoutDrawing(careful);
  for (const key of ["paper", "rules", "ink"]) assert.equal(key in bare, false, key);
  const { paper: _paper, rules: _rules, ink: _ink, ...rest } = careful;
  assert.deepEqual(bare, rest);
  assert.deepEqual(careful, copy);
  const none = toLocal(read(), ORIGIN);
  assert.equal(withoutDrawing(none), none);
});

test("an accurate read keeps its drawing as the helper sent it, the badly formed parts left out", () => {
  const ink = grid(3, 3, [4]);
  const kept = readOf({ id: 3, ev: "read", ...read(), paper: PAPER, rules: [RULES[0], { x: 1, y: 2 }, RULES[1]], ink, inkMs: 7 }, false);
  assert.deepEqual(kept.paper, PAPER);
  assert.deepEqual(kept.rules, RULES);
  assert.deepEqual(kept.ink, ink);
  assert.equal(kept.lines.length, 2);
  const bad = readOf({ ...read(), paper: { x: 1, y: 2, w: -3, h: 4 }, rules: "none", ink: { ...ink, cols: 0 } }, false);
  for (const key of ["paper", "rules", "ink"]) assert.equal(key in bad, false, key);
  // (as from a helper older than the drawing)
  const none = readOf({ ...read() }, false);
  for (const key of ["paper", "rules", "ink"]) assert.equal(key in none, false, key);
});

test("a paper or a rule is four finite numbers with some width and height", () => {
  assert.deepEqual(rectOf({ x: -4, y: 0, w: 1, h: 0.5, extra: true }), { x: -4, y: 0, w: 1, h: 0.5 });
  for (const bad of [
    null,
    undefined,
    7,
    "rect",
    [1, 2, 3, 4],
    { x: 1, y: 2, w: 3 },
    { x: 1, y: 2, w: 0, h: 4 },
    { x: 1, y: 2, w: 3, h: -1 },
    { x: Number.NaN, y: 2, w: 3, h: 4 },
    { x: 1, y: Number.POSITIVE_INFINITY, w: 3, h: 4 },
    { x: "1", y: 2, w: 3, h: 4 },
  ]) {
    assert.equal(rectOf(bad), null, JSON.stringify(bad) ?? String(bad));
  }
  const local = toLocal(read({ paper: { x: 1, y: 2, w: 0, h: 4 } }), ORIGIN);
  assert.equal("paper" in local, false);
});

test("rules: the well formed ones in order, RULES_MOST at most", () => {
  assert.equal(rulesOf(undefined), null);
  assert.equal(rulesOf({ x: 1, y: 2, w: 3, h: 1 }), null);
  assert.deepEqual(rulesOf([]), []);
  assert.deepEqual(rulesOf([null, RULES[1], "rule", { ...RULES[0], h: Number.NaN }, RULES[0]]), [RULES[1], RULES[0]]);
  const many = Array.from({ length: RULES_MOST + 10 }, (_, i) => ({ x: 10, y: 20 + i * 4, w: 100, h: 1 }));
  const kept = rulesOf(many);
  assert.equal(kept?.length, RULES_MOST);
  assert.deepEqual(kept?.[RULES_MOST - 1], many[RULES_MOST - 1]);
  assert.equal(toLocal(read({ rules: many }), ORIGIN).rules?.length, RULES_MOST);
});

test("the ink grid: whole columns and rows up to INK_CELLS_MOST, and bits that are exactly its cells", () => {
  // (1, 2 and 3 bytes of bits: one, two and no padding characters)
  for (const [cols, rows] of [
    [1, 1],
    [3, 4],
    [4, 5],
    [INK_CELLS_MOST, INK_CELLS_MOST],
  ]) {
    const ink = grid(cols, rows, [0, cols * rows - 1]);
    assert.deepEqual(inkOf(ink), ink, `${cols} x ${rows}`);
  }
  const ok = grid(10, 12, [5]);
  const bad: Array<[string, unknown]> = [
    ["no grid", undefined],
    ["a list", [ok]],
    ["no corner", { ...ok, x: undefined }],
    ["a corner not finite", { ...ok, y: Number.NaN }],
    ["no cell", { ...ok, cell: 0 }],
    ["a cell less than nothing", { ...ok, cell: -8 }],
    ["no columns", { ...ok, cols: 0 }],
    ["part of a column", { ...ok, cols: 9.5 }],
    ["columns as a string", { ...ok, cols: "10" }],
    ["too many columns", grid(INK_CELLS_MOST + 1, 2)],
    ["too many rows", grid(2, INK_CELLS_MOST + 1)],
    ["no bits", { ...ok, bits: undefined }],
    ["bits as numbers", { ...ok, bits: [1, 2, 3] }],
    ["bits for fewer cells", { ...ok, bits: grid(10, 11).bits }],
    ["bits for more cells", { ...ok, bits: grid(10, 13).bits }],
    ["bits not base64", { ...ok, bits: "*".repeat(ok.bits.length) }],
    ["bits padded wrongly", { ...grid(3, 4), bits: grid(3, 4).bits.replace(/=$/, "A") }],
    ["bits padded where they need none", { ...grid(4, 6), bits: `${grid(4, 6).bits.slice(0, -1)}=` }],
  ];
  for (const [why, value] of bad) assert.equal(inkOf(value), null, why);
  assert.equal("ink" in toLocal(read({ ink: { ...ok, rows: 401 } }), ORIGIN), false);
});

test("drawingOf keeps each part on its own: one badly formed part leaves the others", () => {
  const ink = grid(2, 2, [3]);
  assert.deepEqual(drawingOf({ paper: { x: 0, y: 0, w: 0, h: 0 }, rules: RULES, ink }), { rules: RULES, ink });
  assert.deepEqual(drawingOf({ paper: PAPER, rules: null, ink: { ...ink, bits: "" } }), { paper: PAPER });
  assert.deepEqual(drawingOf({}), {});
});

/* The log lines for a lesson's reads: its pass, times and counts, and nothing else of it. */

/** Whether `line` says nothing of the read but its pass and numbers: no title, app, bundle or word,
 *  only the line's own fixed words, and no field that was not a number. */
function numbersOnly(line: string): void {
  for (const said of ["Preview", "com.apple.Preview", "Sample title", "alpha", "bravo", "charlie", "4242", "NaN", "undefined", "null"]) {
    assert.equal(line.includes(said), false, `${said} in ${line}`);
  }
  const words = line
    .replace(/^\[screen-teach\] /, "")
    .split(/[^a-z]+/)
    .filter(Boolean);
  const fixed = new Set(["run", "turn", "read", "reread", "fast", "careful", "accurate", "capture", "text", "held", "drawing", "settle", "total", "ms"]);
  for (const w of ["line", "lines", "without", "word", "words", "boxes", "guessed"]) fixed.add(w);
  for (const word of words) assert.ok(fixed.has(word), `${word} in ${line}`);
}

test("a turn's read is logged as its pass, the helper's times, the settle, the whole turn and counts", () => {
  const helper = read({ id: 12, ev: "read", inkMs: 13.4, heldMs: 120, wordless: 2, guessed: 3, paper: PAPER, rules: RULES, ink: grid(4, 4) });
  const line = turnReadLine(4, helper, 340.2, 1012.7);
  assert.equal(
    line,
    "[screen-teach] run 4 turn read: accurate, capture 120 ms, text 640 ms, held 120 ms, drawing 13 ms, settle 340 ms, total 1013 ms, 2 lines, 2 without word boxes, 3 words guessed",
  );
  numbersOnly(line);
  // (a helper older than the counts and the drawing: only what it sent)
  assert.equal(
    turnReadLine(5, read({ level: undefined }), 0, 600),
    "[screen-teach] run 5 turn read: accurate, capture 120 ms, text 640 ms, settle 0 ms, total 600 ms, 2 lines",
  );
});

test("a read again is logged as asked, fast or careful, with the pass the helper used", () => {
  const fast = rereadLine(7, read({ level: "fast", captureMs: 18, ocrMs: 74, lines: [read().lines[0]], wordless: 0, guessed: 1 }), true, 95);
  assert.equal(fast, "[screen-teach] run 7 reread fast: fast, capture 18 ms, text 74 ms, total 95 ms, 1 line, 1 word guessed");
  numbersOnly(fast);
  // (asked for fast, and read again accurately by the helper: it says so)
  assert.match(rereadLine(7, read(), true, 700), /^\[screen-teach\] run 7 reread fast: accurate, /);
  const careful = rereadLine(7, read({ inkMs: 12 }), false, 560);
  assert.equal(careful, "[screen-teach] run 7 reread careful: accurate, capture 120 ms, text 640 ms, drawing 12 ms, total 560 ms, 2 lines");
  numbersOnly(careful);
});

test("a field the helper sent that is not a time or a count is left out of the line, never written", () => {
  const odd = read({ captureMs: "Sample title", ocrMs: Number.NaN, heldMs: -5, inkMs: { t: "alpha" }, wordless: "bravo", guessed: Infinity, level: "charlie" });
  const line = rereadLine(3, odd, false, Number.NaN);
  assert.equal(line, "[screen-teach] run 3 reread careful: accurate, 2 lines");
  numbersOnly(line);
  numbersOnly(turnReadLine(3, { ...odd, lines: "alpha" } as unknown as ScreenRead, Number.POSITIVE_INFINITY, -1));
});
