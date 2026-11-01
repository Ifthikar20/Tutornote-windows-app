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
  boardPlaceMsg,
  boardPrefsOf,
  coversReading,
  displayChanged,
  fullScreenFrame,
  leavesTab,
  mainCanHold,
  NOTCH_BAND,
  overlayArea,
  overlayHome,
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

/*
  A MacBook with a camera notch, 1512 x 982 points, its menu bar 38 points tall over a 70 point
  Dock. macOS keeps a window in native full screen under the camera housing: the founder's Kindle
  in full screen was a window at (0, 36), 1512 x 946 (helpers/screen/main.swift's selftest).
*/
const NOTCHED = { id: 3, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 874 } };
const KINDLE_FULL = { x: 0, y: 36, w: 1512, h: 946 };

test("fullScreenFrame: a window in full screen under a camera notch, not one zoomed under a plain menu bar", () => {
  assert.equal(fullScreenFrame(KINDLE_FULL, NOTCHED.bounds), true);
  // (the notch's band, at either end; the left, right and bottom edges still the display's)
  assert.equal(fullScreenFrame({ x: 0, y: NOTCH_BAND.min, w: 1512, h: 982 - NOTCH_BAND.min }, NOTCHED.bounds), true);
  assert.equal(fullScreenFrame({ x: 0, y: NOTCH_BAND.max, w: 1512, h: 982 - NOTCH_BAND.max }, NOTCHED.bounds), true);
  assert.equal(fullScreenFrame({ x: 0, y: NOTCH_BAND.max + 10, w: 1512, h: 982 - NOTCH_BAND.max - 10 }, NOTCHED.bounds), false);
  assert.equal(fullScreenFrame({ x: 0, y: 36, w: 1512, h: 876 }, NOTCHED.bounds), false);
  assert.equal(fullScreenFrame({ x: 40, y: 36, w: 1472, h: 946 }, NOTCHED.bounds), false);
  // (a plain menu bar's 24 or 25 points is no notch: a window zoomed under it is no full screen)
  assert.equal(fullScreenFrame({ x: 0, y: 24, w: 1440, h: 876 }, DISPLAY), false);
  // (a notched display placed below another: its band counts from its own top)
  assert.equal(fullScreenFrame({ x: 0, y: 936, w: 1512, h: 946 }, { x: 0, y: 900, width: 1512, height: 982 }), true);
});

/*
  The lesson's own window: over display 1's work area (under a 25 point menu bar, over a 70 point
  Dock), or all of display 1 for a window there in native full screen.
*/
const ONE = { id: 1, bounds: DISPLAY, workArea: { x: 0, y: 25, width: 1440, height: 805 } };
const TWO = { id: 2, bounds: { x: 1440, y: 0, width: 1440, height: 900 }, workArea: { x: 1440, y: 25, width: 1440, height: 875 } };
const FULL = { x: 0, y: 0, w: 1440, h: 900 };

test("overlayArea: the work area, but all of the display for a window in native full screen", () => {
  assert.deepEqual(overlayArea(ONE, READING.frame), ONE.workArea);
  assert.deepEqual(overlayArea(ONE, FULL), DISPLAY);
  assert.deepEqual(overlayArea(TWO, { x: 1440, y: 0, w: 1440, h: 900 }), TWO.bounds);
  assert.deepEqual(overlayArea(TWO, { x: 1500, y: 60, w: 900, h: 700 }), TWO.workArea);
  // (a copy: Electron's own rectangle is never handed on)
  assert.notEqual(overlayArea(ONE, READING.frame), ONE.workArea);
  // (a window as tall as the work area is no full screen: the menu bar is above it)
  assert.deepEqual(overlayArea(ONE, { x: 0, y: 25, w: 1440, h: 805 }), ONE.workArea);
  // (the founder's Kindle in full screen under the notch: all of the display, not the work area)
  assert.deepEqual(overlayArea(NOTCHED, KINDLE_FULL), NOTCHED.bounds);
  assert.deepEqual(overlayArea(NOTCHED, { x: 100, y: 60, w: 900, h: 700 }), NOTCHED.workArea);
});

test("displayChanged: another display, or full screen in or out; a move on the same display is none", () => {
  const home = overlayHome(ONE, READING.frame);
  assert.deepEqual(home, { displayId: 1, full: false, bounds: DISPLAY });
  // (a copy: Electron's own rectangle is never kept)
  assert.notEqual(home.bounds, ONE.bounds);
  assert.equal(displayChanged(home, ONE, { ...READING.frame, x: 400, y: 90 }), false);
  assert.equal(displayChanged(home, TWO, { ...READING.frame, x: 1600 }), true);
  assert.equal(displayChanged(home, ONE, FULL), true);
  const full = overlayHome(ONE, FULL);
  assert.deepEqual(full, { displayId: 1, full: true, bounds: DISPLAY });
  assert.equal(displayChanged(full, ONE, FULL), false);
  assert.equal(displayChanged(full, ONE, READING.frame), true);
  // (the work area alone is never asked: the Dock or the menu bar changing moves nothing)
  assert.equal(displayChanged(home, { ...ONE, workArea: { x: 0, y: 25, width: 1440, height: 875 } }, READING.frame), false);
  // (into full screen under a camera notch, and out of it)
  const windowed = overlayHome(NOTCHED, { x: 100, y: 60, w: 900, h: 700 });
  assert.equal(displayChanged(windowed, NOTCHED, KINDLE_FULL), true);
  assert.equal(displayChanged(overlayHome(NOTCHED, KINDLE_FULL), NOTCHED, { x: 100, y: 60, w: 900, h: 700 }), true);
  assert.equal(displayChanged(overlayHome(NOTCHED, KINDLE_FULL), NOTCHED, KINDLE_FULL), false);
});

test("displayChanged: the same display at another resolution, or put elsewhere among the displays", () => {
  const home = overlayHome(ONE, READING.frame);
  // ("More Space": the same display, the same window, more points)
  assert.equal(displayChanged(home, { ...ONE, bounds: { x: 0, y: 0, width: 1800, height: 1169 } }, READING.frame), true);
  // (display 2 moved to the left of display 1: the window read there with it)
  const two = overlayHome(TWO, { x: 1600, y: 60, w: 900, h: 700 });
  assert.equal(displayChanged(two, { ...TWO, bounds: { x: -1440, y: 0, width: 1440, height: 900 } }, { x: -1280, y: 60, w: 900, h: 700 }), true);
  // (a window in full screen refilling its display at the new size: the display changed all the same)
  assert.equal(displayChanged(overlayHome(ONE, FULL), { ...ONE, bounds: { x: 0, y: 0, width: 1800, height: 1169 } }, { x: 0, y: 0, w: 1800, h: 1169 }), true);
});

/*
  The page's message about its board: its own window's frame in the lesson window's points, while it
  shows over that window (the lesson's window over display 1's work area, from y 25).
*/
const LESSON = ONE.workArea;
const PLACE = { where: "float" as const, canMove: true, covering: false, app: "Preview" };

test("boardPlaceMsg: a board in its own window over the lesson's says where, in the lesson's points", () => {
  const msg = boardPlaceMsg({ ...PLACE, floating: { x: 760, y: 120, width: 620, height: 640 }, lesson: LESSON });
  assert.deepEqual(msg, { where: "float", canMove: true, covering: false, app: "Preview", bounds: { x: 760, y: 95, w: 620, h: 640 } });
  // (hanging over the lesson window's edge, partly off it: all of its frame, as it is)
  assert.deepEqual(boardPlaceMsg({ ...PLACE, floating: { x: 1100, y: 10, width: 620, height: 640 }, lesson: LESSON }).bounds, {
    x: 1100,
    y: -15,
    w: 620,
    h: 640,
  });
  // (the lesson's window over all of display 2, in native full screen there)
  assert.deepEqual(boardPlaceMsg({ ...PLACE, floating: { x: 1500, y: 40, width: 400, height: 300 }, lesson: TWO.bounds }).bounds, {
    x: 60,
    y: 40,
    w: 400,
    h: 300,
  });
});

test("boardPlaceMsg: no bounds in its tab, hidden, on another display, or with no lesson window", () => {
  const away = { x: 1500, y: 120, width: 620, height: 640 };
  const none: Array<[string, Parameters<typeof boardPlaceMsg>[0]]> = [
    ["in its tab", { ...PLACE, where: "tab", floating: { x: 760, y: 120, width: 620, height: 640 }, lesson: LESSON }],
    ["hidden", { ...PLACE, floating: null, lesson: LESSON }],
    ["on display 2", { ...PLACE, floating: away, lesson: LESSON }],
    ["only touching the lesson window's edge", { ...PLACE, floating: { x: 1440, y: 120, width: 620, height: 640 }, lesson: LESSON }],
    ["no lesson window", { ...PLACE, floating: { x: 760, y: 120, width: 620, height: 640 }, lesson: null }],
  ];
  for (const [why, a] of none) assert.equal("bounds" in boardPlaceMsg(a), false, why);
  // (the rest as it always was, and no app's name when there is none)
  assert.deepEqual(boardPlaceMsg({ ...PLACE, app: "", where: "tab", floating: null, lesson: LESSON }), { where: "tab", canMove: true, covering: false });
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
