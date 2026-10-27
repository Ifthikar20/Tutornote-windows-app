import { test } from "node:test";
import assert from "node:assert/strict";
import { boardStateOf, opaqueColor, placeBoard, textBox, type Box, type Rect } from "../../src/main/boardPlace.ts";

/*
  Where the board of a lesson over another app goes (src/main/boardPlace.ts). A 1440 x 900 display
  with the menu bar's 25 points taken off the top: the work area is 1440 x 875 from y 25. The page
  being read is a window in screen points, its words a box inside it, as the screen helper reads
  them.
*/

const WORK: Box = { x: 0, y: 25, width: 1440, height: 875 };
const bottom = (b: Box): number => b.y + b.height;
const right = (b: Box): number => b.x + b.width;

/** A window read whose words run from `x0` to `x1`, and from y 100 to 800. */
function page(x0: number, x1: number): { text: Rect; frame: Rect } {
  return { text: { x: x0, y: 100, w: x1 - x0, h: 700 }, frame: { x: x0 - 20, y: 60, w: x1 - x0 + 40, h: 800 } };
}

test("textBox is one box around every line, and null without lines", () => {
  assert.deepEqual(
    textBox([
      { x: 100, y: 200, w: 300, h: 20 },
      { x: 80, y: 230, w: 200, h: 20 },
      { x: 120, y: 260, w: 420, h: 18 },
    ]),
    { x: 80, y: 200, w: 460, h: 78 },
  );
  assert.equal(textBox([]), null);
  assert.equal(textBox([{ x: Number.NaN, y: 0, w: 10, h: 10 }]), null);
});

test("the board goes right of the words when the right has the room", () => {
  const b = placeBoard({ work: WORK, ...page(100, 700), saved: null });
  assert.deepEqual(b, { x: 724, y: 120, width: 620, height: 640 });
});

test("and left of them when the left has more", () => {
  const b = placeBoard({ work: WORK, ...page(800, 1340), saved: null });
  assert.equal(b.width, 620);
  assert.equal(b.x, 800 - 24 - 620);
});

test("room under its width narrows it to that room; under 360 it lies over the words' right edge", () => {
  const narrow = placeBoard({ work: WORK, ...page(300, 1000), saved: null });
  assert.equal(narrow.width, 1440 - 1000 - 24);
  assert.equal(narrow.x, 1024);
  assert.ok(right(narrow) <= right(WORK));

  const over = placeBoard({ work: WORK, ...page(200, 1250), saved: null });
  assert.equal(over.width, 620);
  assert.equal(over.x, 1440 - 620 - 16);
  assert.ok(over.x < 1250, "it overlaps the words");
});

test("the bottom 140 points stay clear for the lesson's dock", () => {
  for (const words of [page(100, 700), page(800, 1340), page(200, 1250)]) {
    const b = placeBoard({ work: WORK, ...words, saved: null });
    assert.ok(bottom(WORK) - bottom(b) >= 140, `bottom ${bottom(b)}`);
    assert.ok(b.y >= WORK.y + 16);
  }
  // A window read low on the screen still leaves the dock its corner.
  const low = placeBoard({ work: WORK, text: { x: 100, y: 700, w: 500, h: 150 }, frame: { x: 80, y: 650, w: 560, h: 250 }, saved: null });
  assert.equal(bottom(low), 900 - 140);
});

test("sizes are kept to 360 x 260 at least, and to the work area", () => {
  const tiny = placeBoard({ work: WORK, ...page(100, 700), saved: { x: 900, y: 100, width: 100, height: 100 } });
  assert.equal(tiny.width, 360);
  assert.equal(tiny.height, 260);

  const huge = placeBoard({ work: WORK, ...page(200, 1250), saved: { x: -500, y: -500, width: 3000, height: 3000 } });
  assert.equal(huge.width, 1440 - 32);
  assert.equal(huge.height, 875 - 32 - 140);
  assert.ok(huge.x >= WORK.x && right(huge) <= right(WORK));

  const small: Box = { x: 0, y: 25, width: 800, height: 500 };
  const short = placeBoard({ work: small, ...page(100, 300), saved: null });
  assert.equal(short.height, 500 - 32 - 140);
});

test("the words read are the window's when none were read", () => {
  const b = placeBoard({ work: WORK, text: null, frame: { x: 100, y: 60, w: 600, h: 800 }, saved: null });
  assert.equal(b.x, 700 + 24);
});

test("the student's own place is kept while it is on the display and clear of the words", () => {
  const words = page(100, 700);
  const theirs: Box = { x: 760, y: 100, width: 600, height: 600 };
  assert.deepEqual(placeBoard({ work: WORK, ...words, saved: theirs }), theirs);
  // A quarter of it over the words is still theirs.
  const quarter: Box = { x: 550, y: 100, width: 600, height: 600 };
  assert.deepEqual(placeBoard({ work: WORK, ...words, saved: quarter }), quarter);
});

test("but not when it is off this display, or over more than a quarter of the words", () => {
  const words = page(100, 700);
  const offDisplay = placeBoard({ work: WORK, ...words, saved: { x: 2000, y: 100, width: 600, height: 600 } });
  assert.deepEqual(offDisplay, { x: 724, y: 160, width: 600, height: 600 });

  const overWords = placeBoard({ work: WORK, ...words, saved: { x: 200, y: 100, width: 600, height: 600 } });
  assert.equal(overWords.x, 724, "placed beside the words instead, at the student's size");
  assert.equal(overWords.width, 600);
  assert.equal(overWords.height, 600);
});

test("a place left hanging past the screen's edge, or down behind the Dock, is theirs, brought on whole", () => {
  // 30 points past the right edge.
  assert.deepEqual(placeBoard({ work: WORK, ...page(100, 700), saved: { x: 870, y: 100, width: 600, height: 600 } }), {
    x: 1440 - 600,
    y: 100,
    width: 600,
    height: 600,
  });
  // Past the left edge.
  assert.deepEqual(placeBoard({ work: WORK, ...page(800, 1340), saved: { x: -40, y: 100, width: 600, height: 600 } }), {
    x: 0,
    y: 100,
    width: 600,
    height: 600,
  });
  // Its bottom down behind the Dock, under the work area.
  assert.deepEqual(placeBoard({ work: WORK, ...page(100, 700), saved: { x: 760, y: 400, width: 600, height: 600 } }), {
    x: 760,
    y: 900 - 600,
    width: 600,
    height: 600,
  });
  // A head a little under a taller menu bar (a place kept from another Mac's display).
  assert.deepEqual(placeBoard({ work: WORK, ...page(100, 700), saved: { x: 760, y: 15, width: 600, height: 600 } }), {
    x: 760,
    y: 25,
    width: 600,
    height: 600,
  });
});

test("but not when most of it, or of its head, is off the work area, or it is brought over the words", () => {
  const words = page(100, 700);
  // 360 of its 600 points off the right edge.
  assert.deepEqual(placeBoard({ work: WORK, ...words, saved: { x: 1200, y: 100, width: 600, height: 600 } }), {
    x: 724,
    y: 160,
    width: 600,
    height: 600,
  });
  // Its head above the work area.
  assert.equal(placeBoard({ work: WORK, ...words, saved: { x: 760, y: -10, width: 600, height: 600 } }).y, 160);
  // A quarter of it over the words where it was left, but more where it is brought on to.
  const over = placeBoard({ work: WORK, ...page(200, 1250), saved: { x: 1110, y: 100, width: 600, height: 600 } });
  assert.deepEqual(over, { x: 1440 - 600 - 16, y: 160, width: 600, height: 600 }, "placed over the words' right edge instead");
});

test("boardStateOf takes the page's message only when every field is right", () => {
  assert.deepEqual(boardStateOf({ run: 3, show: true, full: false }), { run: 3, show: true, full: false });
  assert.deepEqual(boardStateOf({ run: 3, show: false, full: true, background: "rgb(9, 9, 11)" }), {
    run: 3,
    show: false,
    full: true,
    background: "rgb(9, 9, 11)",
  });
  assert.deepEqual(boardStateOf({ run: 3, show: true, full: false, background: "#fffdf8" })?.background, "#fffdf8");
  assert.deepEqual(boardStateOf({ run: 3, show: true, full: false, background: undefined }), { run: 3, show: true, full: false });

  assert.equal(boardStateOf(null), null);
  assert.equal(boardStateOf("show"), null);
  assert.equal(boardStateOf({ show: true, full: false }), null);
  assert.equal(boardStateOf({ run: Number.NaN, show: true, full: false }), null);
  assert.equal(boardStateOf({ run: "3", show: true, full: false }), null);
  assert.equal(boardStateOf({ run: 3, show: "yes", full: false }), null);
  assert.equal(boardStateOf({ run: 3, show: true }), null);
  assert.equal(boardStateOf({ run: 3, show: true, full: 1 }), null);
  assert.equal(boardStateOf({ run: 3, show: true, full: false, background: "url(https://example.com/x.png)" }), null);
  assert.equal(boardStateOf({ run: 3, show: true, full: false, background: "red" }), null);
  assert.equal(boardStateOf({ run: 3, show: true, full: false, background: 7 }), null);
  assert.equal(boardStateOf({ run: 3, show: true, full: false, background: `rgb(${"1, ".repeat(30)}1)` }), null);
});

test("boardStateOf takes the count of what has gone up on the board, when there is one", () => {
  assert.deepEqual(boardStateOf({ run: 3, show: true, full: false, drawn: 0 }), { run: 3, show: true, full: false, drawn: 0 });
  assert.deepEqual(boardStateOf({ run: 3, show: true, full: false, background: "#ffffff", drawn: 5 }), {
    run: 3,
    show: true,
    full: false,
    background: "#ffffff",
    drawn: 5,
  });
  // An older page sends none: there is none.
  assert.equal("drawn" in (boardStateOf({ run: 3, show: true, full: false }) ?? {}), false);
  for (const drawn of [-1, 1.5, "3", Number.NaN, 2e9, null, Number.POSITIVE_INFINITY]) {
    assert.equal(boardStateOf({ run: 3, show: true, full: false, drawn }), null, String(drawn));
  }
});

test("a see-through colour is never given to the window", () => {
  assert.equal(opaqueColor("#ffffff"), true);
  assert.equal(opaqueColor("rgb(255, 255, 255)"), true);
  assert.equal(opaqueColor("rgba(9, 9, 11, 1)"), true);
  assert.equal(opaqueColor("rgba(0, 0, 0, 0)"), false);
  assert.equal(opaqueColor("rgba(255, 255, 255, 0.92)"), false);
  assert.equal(opaqueColor("rgb(255 255 255 / 50%)"), false);
  assert.equal(opaqueColor("rgb(255 255 255 / 100%)"), true);
});
