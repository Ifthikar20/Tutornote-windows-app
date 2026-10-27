import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  adjacentTab,
  BOARD_COPY,
  BOARD_TAB_ID,
  boardBarInset,
  boardFileWith,
  boardMoveOf,
  boardPlaceFor,
  boardPrefsOf,
  coversReading,
  fullScreenFrame,
  leavesTab,
  mainCanHold,
  tabOrder,
  type MainLook,
  type Reading,
} from "../../src/main/boardHost.ts";

/*
  Where the board of a lesson over another app lives (src/main/boardHost.ts): a tab of Tutornote's
  window or a window of its own. Two displays side by side, each 1440 x 900: display 1 from x 0,
  display 2 from x 1440. The page read is a window on display 1 with its words from x 100 to 700.
*/

const DISPLAY = { x: 0, y: 0, width: 1440, height: 900 };
const READING: Reading = {
  words: { x: 100, y: 100, w: 600, h: 700 },
  frame: { x: 80, y: 60, w: 640, h: 800 },
  displayId: 1,
  full: false,
};

/** Tutornote's window, open and shown on display 1 at `x` (840 wide, the whole height). */
function main(x: number, over: Partial<MainLook> = {}): MainLook {
  return {
    open: true,
    shown: true,
    minimized: false,
    closing: false,
    signIn: false,
    fullScreen: false,
    focused: false,
    bounds: { x, y: 0, width: 840, height: 900 },
    displayId: 1,
    ...over,
  };
}

/** Right of the words with room to spare (from x 720: clear of them). */
const BESIDE = main(720);

test("fullScreenFrame: a window that fills its display, give or take 2 points", () => {
  assert.equal(fullScreenFrame({ x: 0, y: 0, w: 1440, h: 900 }, DISPLAY), true);
  assert.equal(fullScreenFrame({ x: 1, y: 0, w: 1440, h: 899 }, DISPLAY), true);
  assert.equal(fullScreenFrame({ x: 0, y: 25, w: 1440, h: 875 }, DISPLAY), false);
  assert.equal(fullScreenFrame({ x: 80, y: 60, w: 640, h: 800 }, DISPLAY), false);
});

test("coversReading: another display never covers", () => {
  assert.equal(coversReading(main(0, { displayId: 2, bounds: { x: 1440, y: 0, width: 1440, height: 900 } }), READING), false);
  assert.equal(coversReading(main(0, { displayId: 2, fullScreen: true }), READING), false);
  assert.equal(coversReading(main(0, { displayId: null }), READING), false);
  assert.equal(coversReading(main(0, { bounds: null }), READING), false);
});

test("coversReading: full screen on the same display covers, either window's", () => {
  assert.equal(coversReading(main(720, { fullScreen: true }), READING), true);
  assert.equal(coversReading(BESIDE, { ...READING, full: true }), true);
});

test("coversReading: beside the words is clear; over 10% of them is not", () => {
  assert.equal(coversReading(BESIDE, READING), false);
  // Edges that only touch the words do not overlap them.
  assert.equal(coversReading(main(700), READING), false);
  // 5% of the words' width (30 of 600 points, the whole height): still clear.
  assert.equal(coversReading(main(670), READING), false);
  // 15% (90 points): covers.
  assert.equal(coversReading(main(610), READING), true);
});

test("coversReading: with no words read, the read window is what counts", () => {
  const noWords: Reading = { ...READING, words: null };
  // Over 20 of the frame's 640 points (3%): clear. Over 100 (16%): covers.
  assert.equal(coversReading(main(700), noWords), false);
  assert.equal(coversReading(main(620), noWords), true);
});

test("mainCanHold: open, shown, not minimized, not closing, not signing in", () => {
  assert.equal(mainCanHold(BESIDE), true);
  assert.equal(mainCanHold(main(720, { open: false, bounds: null })), false);
  assert.equal(mainCanHold(main(720, { shown: false })), false);
  assert.equal(mainCanHold(main(720, { minimized: true })), false);
  assert.equal(mainCanHold(main(720, { closing: true })), false);
  assert.equal(mainCanHold(main(720, { signIn: true })), false);
});

test("boardPlaceFor: the tab only when every rule says so", () => {
  const at = (over: Partial<Parameters<typeof boardPlaceFor>[0]>) =>
    boardPlaceFor({ pref: "tab", pageKnowsPlace: true, main: BESIDE, reading: READING, ...over }).where;
  assert.equal(at({}), "tab");
  assert.equal(at({ pref: "window" }), "float");
  assert.equal(at({ pageKnowsPlace: false }), "float");
  assert.equal(at({ main: main(720, { open: false, shown: false, bounds: null, displayId: null }) }), "float");
  assert.equal(at({ main: main(720, { shown: false }) }), "float");
  assert.equal(at({ main: main(720, { minimized: true }) }), "float");
  assert.equal(at({ main: main(720, { closing: true }) }), "float");
  assert.equal(at({ main: main(720, { signIn: true }) }), "float");
  assert.equal(at({ main: main(0) }), "float");
  assert.equal(at({ main: main(0, { displayId: 2, bounds: { x: 1440, y: 0, width: 1440, height: 900 } }) }), "tab");
  // Each answer says why, for the log.
  assert.match(boardPlaceFor({ pref: "window", pageKnowsPlace: true, main: BESIDE, reading: READING }).why, /chose/);
  assert.match(boardPlaceFor({ pref: "tab", pageKnowsPlace: true, main: main(0), reading: READING }).why, /covers/);
});

test("leavesTab: the board leaves only a tab nobody can see", () => {
  assert.equal(leavesTab({ main: main(0), reading: READING, otherOwnFocused: true }), false);
  assert.equal(leavesTab({ main: main(720, { minimized: true }), reading: READING, otherOwnFocused: false }), true);
  assert.equal(leavesTab({ main: main(720, { shown: false }), reading: READING, otherOwnFocused: false }), true);
  assert.equal(leavesTab({ main: BESIDE, reading: READING, otherOwnFocused: false }), false);
  assert.equal(leavesTab({ main: main(0), reading: READING, otherOwnFocused: false }), true);
  // The window has the keys back by the time the blur is judged: the student is still there.
  assert.equal(leavesTab({ main: main(0, { focused: true }), reading: READING, otherOwnFocused: false }), false);
});

test("tabOrder: Home, the Board, then the notes", () => {
  assert.deepEqual(tabOrder(1, true, [4, 7]), [1, BOARD_TAB_ID, 4, 7]);
  assert.deepEqual(tabOrder(1, false, [4, 7]), [1, 4, 7]);
  assert.deepEqual(tabOrder(null, true, [4]), [BOARD_TAB_ID, 4]);
  assert.deepEqual(tabOrder(null, false, []), []);
});

test("adjacentTab: wraps both ways, and waits for a second tab", () => {
  const order = [1, BOARD_TAB_ID, 4, 7];
  assert.equal(adjacentTab(order, 1, 1), BOARD_TAB_ID);
  assert.equal(adjacentTab(order, BOARD_TAB_ID, 1), 4);
  assert.equal(adjacentTab(order, 7, 1), 1);
  assert.equal(adjacentTab(order, 1, -1), 7);
  assert.equal(adjacentTab(order, 4, -1), BOARD_TAB_ID);
  assert.equal(adjacentTab([1, 4], 1, 1), 4);
  assert.equal(adjacentTab([1], 1, 1), null);
  assert.equal(adjacentTab([], 0, 1), null);
  // An active id not in the order (none shown yet): forward to the first, back to the last.
  assert.equal(adjacentTab(order, 0, 1), 1);
  assert.equal(adjacentTab(order, 0, -1), 7);
});

test("boardBarInset keeps the first tab where it was", () => {
  assert.equal(boardBarInset(260, 84), 268);
  assert.equal(boardBarInset(0, 84), 84);
  assert.equal(boardBarInset(0, 0), 8);
});

test("boardPrefsOf: the defaults, and only what is valid", () => {
  assert.deepEqual(boardPrefsOf({}), { place: "tab", zoom: 0 });
  assert.deepEqual(boardPrefsOf({ place: "window", zoom: -1 }), { place: "window", zoom: -1 });
  assert.deepEqual(boardPrefsOf({ place: "floating" }), { place: "tab", zoom: 0 });
  assert.equal(boardPrefsOf({ zoom: 9 }).zoom, 3);
  assert.equal(boardPrefsOf({ zoom: -9 }).zoom, -3);
  assert.equal(boardPrefsOf({ zoom: 0.3 }).zoom, 0.5);
  assert.equal(boardPrefsOf({ zoom: "2" }).zoom, 0);
  assert.equal(boardPrefsOf({ zoom: Number.NaN }).zoom, 0);
  assert.deepEqual(boardPrefsOf(null), { place: "tab", zoom: 0 });
  assert.deepEqual(boardPrefsOf("window"), { place: "tab", zoom: 0 });
  assert.deepEqual(boardPrefsOf([1, 2]), { place: "tab", zoom: 0 });
});

test("boardFileWith keeps the other fields and drops anything unknown", () => {
  const bounds = { x: 900, y: 120, width: 620, height: 640 };
  // Saving the choice or the size keeps the floating window's place.
  assert.deepEqual(boardFileWith(bounds, { place: "window" }), { ...bounds, place: "window" });
  assert.deepEqual(boardFileWith({ ...bounds, place: "window" }, { zoom: 1 }), { ...bounds, place: "window", zoom: 1 });
  // Saving the place keeps the choice and the size.
  assert.deepEqual(boardFileWith({ x: 1, y: 2, width: 3, height: 4, place: "window", zoom: -0.5 }, { bounds }), {
    ...bounds,
    place: "window",
    zoom: -0.5,
  });
  // Unknown keys and broken values go.
  assert.deepEqual(boardFileWith({ x: 1, y: "2", place: "app", zoom: "1", extra: true }, {}), { x: 1 });
  assert.deepEqual(boardFileWith(null, { zoom: 12 }), { zoom: 3 });
  assert.deepEqual(boardFileWith("garbage", { place: "tab" }), { place: "tab" });
});

test("boardMoveOf: tab or float, nothing else", () => {
  assert.equal(boardMoveOf("tab"), "tab");
  assert.equal(boardMoveOf("float"), "float");
  assert.equal(boardMoveOf("app"), null);
  assert.equal(boardMoveOf("window"), null);
  assert.equal(boardMoveOf(1), null);
  assert.equal(boardMoveOf(null), null);
  assert.equal(boardMoveOf(undefined), null);
});

test("no em or en dash in the board's words or in the tab bar", () => {
  const dash = /[–—]/;
  for (const value of Object.values(BOARD_COPY)) {
    const text = typeof value === "function" ? value("photosynthesis") : value;
    assert.doesNotMatch(text, dash, text);
    assert.doesNotMatch(text, / - /, text);
  }
  const toolbar = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "static", "toolbar.html"), "utf8");
  assert.doesNotMatch(toolbar, dash);
});
