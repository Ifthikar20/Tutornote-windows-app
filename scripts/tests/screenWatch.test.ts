import { test } from "node:test";
import assert from "node:assert/strict";
import { keyedOf, observeCommandOf, scrollOf } from "../../src/main/screenWatch.ts";

/*
  What the helper says of the student's wheel and keys, checked field by field, and the "observe"
  command the app sends it (src/main/screenWatch.ts). Every event here is made up: window ids and
  distances only, as the helper sends them, never a key.
*/

test("a wheel's scroll keeps its sideways part and its lines", () => {
  assert.deepEqual(scrollOf({ ev: "scroll", dy: 120, dx: 0, lines: 3, momentum: false, window: 4242 }), {
    dy: 120,
    dx: 0,
    lines: 3,
    momentum: false,
    window: 4242,
  });
  // A trackpad's pan sideways: points, no lines, and no move up or down.
  assert.deepEqual(scrollOf({ ev: "scroll", dy: 0, dx: 30, lines: 0, momentum: true, window: 4242 }), {
    dy: 0,
    dx: 30,
    lines: 0,
    momentum: true,
    window: 4242,
  });
});

test("a scroll from a helper older than dx and lines has them as 0", () => {
  assert.deepEqual(scrollOf({ ev: "scroll", dy: -12.5, momentum: false, window: 7 }), { dy: -12.5, dx: 0, lines: 0, momentum: false, window: 7 });
  assert.deepEqual(scrollOf({ ev: "scroll", dy: 40, dx: "far", lines: Number.NaN, window: 7 }), { dy: 40, dx: 0, lines: 0, momentum: false, window: 7 });
});

test("a scroll without a finite dy or a window is no scroll", () => {
  assert.equal(scrollOf({ ev: "scroll", dx: 30, window: 7 }), null);
  assert.equal(scrollOf({ ev: "scroll", dy: Number.POSITIVE_INFINITY, window: 7 }), null);
  assert.equal(scrollOf({ ev: "scroll", dy: 10 }), null);
  assert.equal(scrollOf({ ev: "scroll", dy: 10, window: "4242" }), null);
});

test("a key is said by its window alone", () => {
  assert.deepEqual(keyedOf({ ev: "keyed", window: 4242 }), { window: 4242 });
  // (anything else the event might carry is never passed on)
  assert.deepEqual(keyedOf({ ev: "keyed", window: 4242, key: "a" }), { window: 4242 });
  assert.equal(keyedOf({ ev: "keyed" }), null);
  assert.equal(keyedOf({ ev: "keyed", window: null }), null);
});

test("observe names the windows that turn by the page among those watched", () => {
  assert.deepEqual(observeCommandOf([4242, 5151], [4242]), { cmd: "observe", windows: [4242, 5151], page: [4242] });
  // None paged: no "page", as a helper older than it is sent.
  assert.deepEqual(observeCommandOf([4242], []), { cmd: "observe", windows: [4242] });
  // A paged window not watched (the lesson's, before the companion asks for it) is left out.
  assert.deepEqual(observeCommandOf([5151], [4242]), { cmd: "observe", windows: [5151] });
  // [] stops, paged or not.
  assert.deepEqual(observeCommandOf([], [4242]), { cmd: "observe", windows: [] });
});

test("observe watches two windows at most, and names each paged one once", () => {
  assert.deepEqual(observeCommandOf([1, 2, 3], [3, 2, 2]), { cmd: "observe", windows: [1, 2], page: [2] });
});
