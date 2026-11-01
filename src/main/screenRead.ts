/*
  A read of another app's window (screen.ts ScreenRead) made fit to pass on: what the helper
  measured of the page's drawing besides its words kept only where it is well formed (readOf), and
  the whole read moved into the lesson window's own points (toLocal).

  An accurate read also says where the page's paper is, the rules drawn across it and a coarse grid
  of where else it is drawn on (helpers/screen/main.swift "What else the page draws"), so the lesson
  can write on a page in another app as it does on the web's own reader (the founder, 2026-10-28:
  "the part where we write on the PDF documents. That has to work in our Mac application"). Numbers
  only, never a pixel, in the same screen points as the read's lines, and never a glance's: one
  asked for fast, even one the helper read again accurately, or one read fast.

  What the helper sent badly is left out, never mended: a paper or a rule that is not four finite
  numbers with some width and height, an ink grid whose cell is not a finite size, whose columns or
  rows are not whole numbers from 1 to INK_CELLS_MOST, or whose bits are not the base64 of exactly
  its cells. Rules past RULES_MOST are left out too (the helper sends them top to bottom, that many
  at most). The page then does as it does with an older Mac app: it takes its paper from the window
  and writes nowhere a figure could be (web lib/write/pageSurface.ts).

  Numbers in, numbers out: no Electron and no other module at run time, so it is tested on its own
  (scripts/tests/screenRead.test.ts). Nothing here is logged: a read's lines are the screen's words.
  Its log line (turnReadLine, rereadLine, below) is made of its times and counts alone.
*/

import type { ScreenInk, ScreenRead, ScreenRect } from "./screen";

type Point = { x: number; y: number };

/** The most rules a read keeps (the helper's RULES_KEPT). */
export const RULES_MOST = 64;
/** The most columns, and the most rows, of an ink grid (the helper's INK_CELLS_MOST). */
export const INK_CELLS_MOST = 400;

/** What a read says of its page's drawing, each part left out where it was not well formed. */
export type ReadDrawing = Pick<ScreenRead, "paper" | "rules" | "ink">;

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A paper or a rule the helper sent: four finite numbers, with some width and height; or null. */
export function rectOf(value: unknown): ScreenRect | null {
  const r = record(value);
  if (!r || !finiteNumber(r.x) || !finiteNumber(r.y) || !finiteNumber(r.w) || !finiteNumber(r.h)) return null;
  return r.w > 0 && r.h > 0 ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
}

/** The rules the helper sent, the well formed ones, RULES_MOST at most in its order ([] for none
 *  found); null when it sent no list. */
export function rulesOf(value: unknown): ScreenRect[] | null {
  if (!Array.isArray(value)) return null;
  const rules: ScreenRect[] = [];
  for (const each of value) {
    const rule = rectOf(each);
    if (rule) rules.push(rule);
    if (rules.length === RULES_MOST) break;
  }
  return rules;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `bits` is the base64 of exactly `cells` bits, one a cell (the last byte's spare bits
 *  unused): its length and padding are those of that many bytes. */
function bitsFit(bits: string, cells: number): boolean {
  const bytes = Math.ceil(cells / 8);
  if (bits.length !== 4 * Math.ceil(bytes / 3) || !BASE64.test(bits)) return false;
  const pad = (3 - (bytes % 3)) % 3;
  return bits.length - bits.replace(/=+$/, "").length === pad;
}

/** The ink grid the helper sent: its corner finite, its cell a finite size, its columns and rows
 *  whole numbers from 1 to INK_CELLS_MOST, and its bits exactly its cells; or null. */
export function inkOf(value: unknown): ScreenInk | null {
  const g = record(value);
  if (!g || !finiteNumber(g.x) || !finiteNumber(g.y) || !finiteNumber(g.cell) || g.cell <= 0) return null;
  const whole = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= INK_CELLS_MOST;
  if (!whole(g.cols) || !whole(g.rows) || typeof g.bits !== "string" || !bitsFit(g.bits, g.cols * g.rows)) return null;
  return { x: g.x, y: g.y, cell: g.cell, cols: g.cols, rows: g.rows, bits: g.bits };
}

/** What `fields` say of the page's drawing, only the parts that are well formed. */
export function drawingOf(fields: { paper?: unknown; rules?: unknown; ink?: unknown }): ReadDrawing {
  const paper = rectOf(fields.paper);
  const rules = rulesOf(fields.rules);
  const ink = inkOf(fields.ink);
  return { ...(paper ? { paper } : {}), ...(rules ? { rules } : {}), ...(ink ? { ink } : {}) };
}

/** A read as the helper answered it (screen.ts readWindow, readWindowAt), its drawing kept only
 *  where well formed, and none at all for a glance (`fast`: asked for one; or one read fast). */
export function readOf(answer: Record<string, unknown>, fast: boolean): ScreenRead {
  const { paper, rules, ink, ...rest } = answer;
  const read = rest as unknown as ScreenRead;
  return fast || read.level === "fast" ? read : { ...read, ...drawingOf({ paper, rules, ink }) };
}

/** A read without its page's drawing: what a glance of a window passes on to the page (companion.ts
 *  sendGlance), even one from an accurate read (the lesson's own, a tap's careful one). The pointer
 *  and where a tap lands go by its lines alone; what is written on the page goes by a lesson's own
 *  reads, which carry it (a grid can be some 27 KB, every glance). The same read when it has none. */
export function withoutDrawing(read: ScreenRead): ScreenRead {
  if (read.paper === undefined && read.rules === undefined && read.ink === undefined) return read;
  const bare = { ...read };
  delete bare.paper;
  delete bare.rules;
  delete bare.ink;
  return bare;
}

/** A read in the lesson window's own coordinates: every box less its top left, the paper and the
 *  rules too, and the ink grid's corner (its cells keep their size). Only the fields it names go on
 *  (a page's drawing only where well formed, and never a glance's). */
export function toLocal(read: ScreenRead, origin: Point): ScreenRead {
  const shift = <T extends Point>(box: T): T => ({ ...box, x: box.x - origin.x, y: box.y - origin.y });
  const drawn: ReadDrawing = read.level === "fast" ? {} : drawingOf(read);
  return {
    app: read.app,
    bundle: read.bundle,
    title: read.title,
    window: read.window,
    pid: read.pid,
    frame: shift(read.frame),
    lines: read.lines.map((line) => (line.words ? { ...shift(line), words: line.words.map(shift) } : shift(line))),
    captureMs: read.captureMs,
    ocrMs: read.ocrMs,
    ...(typeof read.ground === "number" && Number.isFinite(read.ground) ? { ground: read.ground } : {}),
    ...(read.level ? { level: read.level } : {}),
    ...(drawn.paper ? { paper: shift(drawn.paper) } : {}),
    ...(drawn.rules ? { rules: drawn.rules.map(shift) } : {}),
    ...(drawn.ink ? { ink: shift(drawn.ink) } : {}),
  };
}

/*
  Each read a lesson asks for, one line in the app's log (screenTeach.ts: the read after a turn, and
  every read again the page asks for, quick or careful), so the time a turn or a reread takes can be
  told from the log, measured where it is spent (the founder, 2026-10-28: the tutor over another app
  "should be super responsive"; the [screen-teach] lines carry no clock, so a span is never worked
  out from two of them). The pass and the helper's own times (main.swift read: the picture with its
  thumbnail, the words, the wait for a tap being judged, the page's drawing), the turn's settle, the
  whole from the ask, and counts: never a title, an app's name, a word or a box, so a line is made
  here from those numbers alone, and a field the helper sent that is not a number is left out.

    [screen-teach] run 4 turn read: accurate, capture 41 ms, text 512 ms, drawing 13 ms, settle 340 ms, total 1012 ms, 38 lines
    [screen-teach] run 4 reread fast: fast, capture 18 ms, text 74 ms, total 95 ms, 38 lines
    [screen-teach] run 4 reread careful: accurate, capture 40 ms, text 498 ms, held 120 ms, drawing 12 ms, total 560 ms, 38 lines, 2 without word boxes, 3 words guessed
*/

/** A time or a count as a log line gives it: a whole number from 0, or null for anything else. */
const whole = (value: unknown): number | null => (finiteNumber(value) && value >= 0 ? Math.round(value) : null);

/** `label N ms`, or nothing for a time that is not one. */
const msPart = (label: string, value: unknown): string[] => {
  const n = whole(value);
  return n === null ? [] : [`${label} ${n} ms`];
};

/** `N label`, or nothing for a count that is none or is not one. */
const countPart = (value: unknown, label: (n: number) => string): string[] => {
  const n = whole(value);
  return n ? [`${n} ${label(n)}`] : [];
};

/** A read's log line (above): the pass and the helper's times, then `between` (a turn's settle),
 *  the whole from the ask, and the counts. */
function timingLine(what: string, run: number, read: ScreenRead, between: string[], totalMs: number): string {
  const lines = Array.isArray(read.lines) ? read.lines.length : 0;
  const parts = [
    read.level === "fast" ? "fast" : "accurate",
    ...msPart("capture", read.captureMs),
    ...msPart("text", read.ocrMs),
    ...msPart("held", read.heldMs),
    ...msPart("drawing", read.inkMs),
    ...between,
    ...msPart("total", totalMs),
    `${lines} ${lines === 1 ? "line" : "lines"}`,
    ...countPart(read.wordless, () => "without word boxes"),
    ...countPart(read.guessed, (n) => (n === 1 ? "word guessed" : "words guessed")),
  ];
  return `[screen-teach] run ${whole(run) ?? 0} ${what}: ${parts.join(", ")}`;
}

/** The log line for the read after a lesson's turn: `settleMs`, the move's wait for the window to
 *  settle (screen.ts ScreenTurned; for a page the student turns, the wait for them too); `totalMs`,
 *  the whole turn, from when it started in the lesson's queue (screenTeach.ts turn). */
export const turnReadLine = (run: number, read: ScreenRead, settleMs: number, totalMs: number): string =>
  timingLine("turn read", run, read, msPart("settle", settleMs), totalMs);

/** The log line for a read again the page asked for: `fast`, a quick check after a scroll, else a
 *  careful one; `totalMs`, from the page's ask (its wait behind the lesson's other work too). */
export const rereadLine = (run: number, read: ScreenRead, fast: boolean, totalMs: number): string =>
  timingLine(fast ? "reread fast" : "reread careful", run, read, [], totalMs);
