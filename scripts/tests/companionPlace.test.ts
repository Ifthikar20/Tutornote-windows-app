import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOB_SIZE,
  blobPlaceFor,
  blobPlacesOf,
  blobUp,
  choiceOf,
  clampBlobPlace,
  defaultBlobPlace,
  isBrowserApp,
  isEditorApp,
  isPrivateApp,
  isReaderApp,
  LABEL_WIDTH,
  labelBounds,
  selectionKept,
  TAP_NEAR,
  TAP_WORDS,
  tapNumbers,
  tapOnWords,
  tapRoute,
  windowIdOf,
  type Box,
} from "../../src/main/companionPlace.ts";

/*
  The desktop companion's rules (src/main/companionPlace.ts). A 1440 x 900 display with the menu
  bar's 25 points taken off the top (the work area is 1440 x 875 from y 25), and a second display to
  its right, 1920 x 1080 with a 25 point menu bar and a 70 point Dock at its bottom.
*/

const WORK: Box = { x: 0, y: 25, width: 1440, height: 875 };
const SECOND: Box = { x: 1440, y: 25, width: 1920, height: 985 };
const inside = (p: { x: number; y: number }, w: Box): boolean =>
  p.x >= w.x && p.y >= w.y && p.x + BLOB_SIZE <= w.x + w.width && p.y + BLOB_SIZE <= w.y + w.height;

test("the blob first pops up at the bottom right of the work area, clear of its edges", () => {
  assert.deepEqual(defaultBlobPlace(WORK), { x: 1440 - 64 - 24, y: 25 + 875 - 64 - 24 });
  assert.deepEqual(defaultBlobPlace(SECOND), { x: 1440 + 1920 - 64 - 24, y: 25 + 985 - 64 - 24 });
  assert.ok(inside(defaultBlobPlace(WORK), WORK));
});

test("a place off the work area is brought whole on to it", () => {
  // Dragged half off the right edge, and up under the menu bar.
  assert.deepEqual(clampBlobPlace({ x: 1420, y: 5 }, WORK), { x: 1440 - 64, y: 25 });
  // Down behind the Dock, past the left edge.
  assert.deepEqual(clampBlobPlace({ x: -30, y: 899 }, WORK), { x: 0, y: 900 - 64 });
  // Already on it: kept as it is (rounded).
  assert.deepEqual(clampBlobPlace({ x: 300.4, y: 400.6 }, WORK), { x: 300, y: 401 });
});

test("the places kept on disk are read per display, and anything else is dropped", () => {
  const places = blobPlacesOf({
    places: { "1": { x: 10, y: 100 }, "69734208": { x: 2000, y: 500 }, bad: { x: 1, y: 2 }, "3": { x: "1", y: 2 }, "4": null },
    tipped: true,
  });
  assert.deepEqual(places, { "1": { x: 10, y: 100 }, "69734208": { x: 2000, y: 500 } });
  assert.deepEqual(blobPlacesOf(null), {});
  assert.deepEqual(blobPlacesOf({ places: "nope" }), {});
  assert.deepEqual(blobPlacesOf("not an object"), {});
});

test("each display gets the blob back where it was left there, else its own bottom right", () => {
  const places = { "1": { x: 10, y: 100 }, "2": { x: 2000, y: 500 } };
  assert.deepEqual(blobPlaceFor(places, 1, WORK), { x: 10, y: 100 });
  assert.deepEqual(blobPlaceFor(places, 2, SECOND), { x: 2000, y: 500 });
  // A display never dragged on: its own corner, not another display's place.
  assert.deepEqual(blobPlaceFor(places, 3, WORK), defaultBlobPlace(WORK));
  // The second display came back smaller (a lower resolution): the place is brought on to it.
  const smaller: Box = { x: 1440, y: 25, width: 1280, height: 695 };
  const back = blobPlaceFor({ "2": { x: 3300, y: 1000 } }, 2, smaller);
  assert.ok(inside(back, smaller), JSON.stringify(back));
  assert.deepEqual(back, { x: 1440 + 1280 - 64, y: 25 + 695 - 64 });
});

test("the label goes on the side with room, and the blob stays where it is", () => {
  const corner = defaultBlobPlace(WORK);
  const left = labelBounds(corner, WORK);
  assert.equal(left.side, "left");
  assert.deepEqual(left.bounds, { x: corner.x - LABEL_WIDTH, y: corner.y, width: BLOB_SIZE + LABEL_WIDTH, height: BLOB_SIZE });
  // The blob's own place inside the wider window: its right end.
  assert.equal(left.bounds.x + left.bounds.width - BLOB_SIZE, corner.x);

  const edge = { x: 20, y: 400 };
  const right = labelBounds(edge, WORK);
  assert.equal(right.side, "right");
  assert.deepEqual(right.bounds, { x: 20, y: 400, width: BLOB_SIZE + LABEL_WIDTH, height: BLOB_SIZE });
});

test("a window's CGWindowID comes out of its media source id", () => {
  assert.equal(windowIdOf("window:1324:0"), 1324);
  assert.equal(windowIdOf("window:88:1"), 88);
  assert.equal(windowIdOf("window:0:0"), null);
  assert.equal(windowIdOf("screen:1:0"), null);
  assert.equal(windowIdOf("window:abc:0"), null);
  assert.equal(windowIdOf(""), null);
});

test("password managers, Keychain Access and System Settings are never read", () => {
  for (const bundle of [
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.apple.systempreferences",
  ]) {
    assert.ok(isPrivateApp(bundle), bundle);
  }
  assert.equal(isPrivateApp("com.amazon.Lassen"), false);
  assert.equal(isPrivateApp("com.google.Chrome"), false);
  assert.equal(isPrivateApp(""), false);
  assert.equal(isPrivateApp(undefined), false);
});

test("a plain click is the editor's in Notes, TextEdit, Pages, Word, code editors and terminals", () => {
  for (const bundle of ["com.apple.Notes", "com.apple.TextEdit", "com.apple.iWork.Pages", "com.microsoft.Word", "com.microsoft.VSCode", "com.apple.dt.Xcode", "com.apple.Terminal", "com.googlecode.iterm2"]) {
    assert.ok(isEditorApp(bundle), bundle);
  }
  assert.equal(isEditorApp("com.amazon.Lassen"), false);
  assert.equal(isEditorApp(undefined), false);
});

test("Notion, Obsidian, Finder, office apps and more editors keep a plain click too, and every JetBrains IDE", () => {
  for (const bundle of [
    "notion.id",
    "md.obsidian",
    "com.apple.finder",
    "com.microsoft.Excel",
    "com.microsoft.Powerpoint",
    "com.apple.iWork.Numbers",
    "com.apple.iWork.Keynote",
    "com.sublimetext.4",
    "com.barebones.bbedit",
    "dev.zed.Zed",
    "com.todesktop.230313mzl4w4u92",
  ]) {
    assert.ok(isEditorApp(bundle), bundle);
  }
  // By the bundle's prefix: PyCharm, IntelliJ IDEA, WebStorm, whatever comes next.
  assert.ok(isEditorApp("com.jetbrains.pycharm"));
  assert.ok(isEditorApp("com.jetbrains.intellij.ce"));
  assert.ok(isEditorApp("com.jetbrains.WebStorm"));
  // (only at the start: a reader or a browser is never one)
  assert.equal(isEditorApp("org.example.com.jetbrains.viewer"), false);
  assert.equal(isEditorApp("com.jetbrains"), false);
  assert.equal(isEditorApp("com.google.Chrome"), false);
  assert.equal(isEditorApp("com.amazon.Kindle"), false);
  assert.equal(isEditorApp(""), false);
});

test("what a tap on another app's window comes to", () => {
  const plain = { onLesson: false, onPage: false, private: false, acted: false, editor: false, alt: false };
  assert.equal(tapRoute(plain), "card");
  assert.equal(tapRoute({ ...plain, onLesson: true }), "lesson");
  // The page's own card or dock took the click: never a tap on the window under it.
  assert.equal(tapRoute({ ...plain, onPage: true }), "page");
  assert.equal(tapRoute({ ...plain, private: true }), "private");
  // A link, a button, a page turn: the app's. An Option click is always the tutor's.
  assert.equal(tapRoute({ ...plain, acted: true }), "acted");
  assert.equal(tapRoute({ ...plain, acted: true, alt: true }), "card");
  assert.equal(tapRoute({ ...plain, acted: true, editor: true, alt: true }), "card");
  // (but never on a private window)
  assert.equal(tapRoute({ ...plain, private: true, acted: true, alt: true }), "private");
  // An editor keeps a plain click; an Option click there offers the card.
  assert.equal(tapRoute({ ...plain, editor: true }), "editor");
  assert.equal(tapRoute({ ...plain, editor: true, alt: true }), "card");
  // The lesson's own window wins over everything: it hears its taps itself.
  assert.equal(tapRoute({ onLesson: true, onPage: true, private: true, acted: true, editor: true, alt: true }), "lesson");
});

test("Kindle, Books and Preview are readers; browsers and editors are not", () => {
  for (const bundle of ["com.amazon.Lassen", "com.amazon.Kindle", "com.apple.iBooksX", "com.apple.Preview"]) {
    assert.ok(isReaderApp(bundle), bundle);
  }
  assert.equal(isReaderApp("com.google.Chrome"), false);
  assert.equal(isReaderApp("com.apple.Safari"), false);
  assert.equal(isReaderApp("com.apple.Notes"), false);
  assert.equal(isReaderApp(""), false);
  assert.equal(isReaderApp(undefined), false);
});

test("a tap is on the words within 24 points of a line, and a page's margin is not", () => {
  // Kindle full screen: two lines of the page's column, 520 points wide from x 500.
  const lines = [
    { x: 500, y: 300, w: 520, h: 18 },
    { x: 500, y: 326, w: 520, h: 18 },
  ];
  assert.equal(TAP_NEAR, 24);
  assert.ok(tapOnWords(lines, { x: 760, y: 309 }), "on a line");
  assert.ok(tapOnWords(lines, { x: 760, y: 321 }), "between two lines");
  assert.ok(tapOnWords(lines, { x: 500 + 520 + 24, y: 309 }), "just past a line's end");
  assert.ok(tapOnWords(lines, { x: 760, y: 300 - 24 }), "just above the first line");
  // The page turned by its side arrow, or its margin, far from any line.
  assert.equal(tapOnWords(lines, { x: 1490, y: 320 }), false);
  assert.equal(tapOnWords(lines, { x: 20, y: 320 }), false);
  assert.equal(tapOnWords(lines, { x: 760, y: 300 - 25 }), false);
  // (a window never read has no words)
  assert.equal(tapOnWords([], { x: 760, y: 309 }), false);
});

test("the blob shows while off, and hides while on only with a page that has its own dock", () => {
  for (const shown of [false, true]) {
    for (const on of [false, true]) {
      for (const pageDock of [false, true]) {
        assert.equal(blobUp({ shown, on, pageDock }), shown && !(on && pageDock), JSON.stringify({ shown, on, pageDock }));
      }
    }
  }
  // Off: the resting blob is the way back on.
  assert.equal(blobUp({ shown: true, on: false, pageDock: true }), true);
  // On with an older page: its ring is the only way off.
  assert.equal(blobUp({ shown: true, on: true, pageDock: false }), true);
  assert.equal(blobUp({ shown: true, on: true, pageDock: true }), false);
});

test("the numbers a tap was judged by read as the log has them", () => {
  assert.equal(tapNumbers({ line: 7.24, away: 6.9, wide: true, look: 0.43 }), " (line 7.2, away 6.9, wide, look 0.4 s)");
  assert.equal(tapNumbers({ line: 3, away: 0.2, wide: false, look: -1 }), " (line 3.0, away 0.2)");
  // (a helper older than them sends none)
  assert.equal(tapNumbers({}), "");
});

test("what the words at a tap said comes first in the log", () => {
  assert.equal(
    tapNumbers({ words: "kept", kept: 0.834, shift: -23.4, textMs: 21.2, line: 7.24, away: 6.9, wide: true }),
    " (words kept 0.83, shift -23 pt, text 21 ms, line 7.2, away 6.9, wide)",
  );
  assert.equal(tapNumbers({ words: "gone", kept: 0.17, shift: 0, textMs: 30, line: 9, away: 0.4 }), " (words gone 0.17, shift 0 pt, text 30 ms, line 9.0, away 0.4)");
  // Words that read nothing: no numbers of their own.
  assert.equal(tapNumbers({ words: "covered", line: 4.2, away: 1 }), " (words covered, line 4.2, away 1.0)");
  assert.equal(tapNumbers({ words: "select" }), " (words select)");
  assert.equal(tapNumbers({ words: "skipped", line: 0.3, away: 0.1, look: 0.4 }), " (words skipped, line 0.3, away 0.1, look 0.4 s)");
  // Every word the helper may send is known (screen.ts drops any other).
  for (const words of ["kept", "gone", "none", "covered", "title", "content", "caret", "select", "skipped", "pixels"]) {
    assert.ok(TAP_WORDS.has(words), words);
  }
  assert.equal(TAP_WORDS.has("acted"), false);
});

test("the card's two choices are taken, and Sum it up from an older page is Explain", () => {
  assert.equal(choiceOf("explain"), "explain");
  assert.equal(choiceOf("ask"), "ask");
  assert.equal(choiceOf("summarize"), "explain");
  assert.equal(choiceOf("x"), null);
  assert.equal(choiceOf("quiz"), null);
  assert.equal(choiceOf(""), null);
  assert.equal(choiceOf(undefined), null);
});

test("a double click's selection is the student's in a reader and on a PDF in a browser, the app's anywhere else", () => {
  // Kindle, Books, Preview: whatever the window's title.
  for (const bundle of ["com.amazon.Lassen", "com.amazon.Kindle", "com.apple.iBooksX", "com.apple.Preview"]) {
    assert.equal(selectionKept({ words: "select", bundle, title: "Campbell Biology" }), true, bundle);
  }
  // A PDF in a browser, by its window's title (any case, a stray space after it).
  assert.equal(selectionKept({ words: "select", bundle: "com.google.Chrome", title: "9780000000017.pdf" }), true);
  assert.equal(selectionKept({ words: "select", bundle: "com.google.Chrome", title: "Chapter 3.PDF " }), true);
  assert.equal(selectionKept({ words: "select", bundle: "com.apple.Safari", title: "notes.pdf" }), true);
  assert.equal(selectionKept({ words: "select", bundle: "com.microsoft.edgemac.Beta", title: "notes.pdf" }), true);
  // A web page in a browser, a PDF's name somewhere else in its title, or no title known: the app's.
  assert.equal(selectionKept({ words: "select", bundle: "com.google.Chrome", title: "Active transport - Wikipedia" }), false);
  assert.equal(selectionKept({ words: "select", bundle: "com.google.Chrome", title: "notes.pdf and 3 more pages" }), false);
  assert.equal(selectionKept({ words: "select", bundle: "com.google.Chrome" }), false);
  // An editor or any other app, with a .pdf title or not.
  assert.equal(selectionKept({ words: "select", bundle: "com.apple.Notes", title: "notes.pdf" }), false);
  assert.equal(selectionKept({ words: "select", bundle: "com.microsoft.VSCode", title: "paper.pdf" }), false);
  assert.equal(selectionKept({ words: "select", bundle: "com.adobe.Reader", title: "paper.pdf" }), false);
  assert.equal(selectionKept({ words: "select", bundle: undefined, title: "paper.pdf" }), false);
  // Only a selection: a click that did something else in a reader is still the app's.
  for (const words of ["gone", "content", "caret", "kept", "none", "pixels", undefined]) {
    assert.equal(selectionKept({ words, bundle: "com.apple.Preview", title: "a.pdf" }), false, String(words));
  }
});

test("a kept selection routes as a tap that did nothing in its app: the card, or the lesson's own", () => {
  const select = { onLesson: false, onPage: false, private: false, editor: false, alt: false };
  // (companion.ts onTap: acted only when the selection is not kept)
  const kept = selectionKept({ words: "select", bundle: "com.apple.Preview" });
  assert.equal(tapRoute({ ...select, acted: !kept }), "card");
  const notKept = selectionKept({ words: "select", bundle: "com.apple.Notes" });
  assert.equal(tapRoute({ ...select, acted: !notKept }), "acted");
  assert.equal(tapRoute({ ...select, onLesson: true, acted: !kept }), "lesson");
  // (a private window stays private)
  assert.equal(tapRoute({ ...select, private: true, acted: !kept }), "private");
});

test("browsers, for a PDF open in one: Chrome and Edge in every channel, Safari, Firefox, Arc and more", () => {
  for (const bundle of [
    "com.google.Chrome",
    "com.google.Chrome.canary",
    "com.microsoft.edgemac",
    "com.apple.Safari",
    "org.mozilla.firefox",
    "company.thebrowser.Browser",
    "com.brave.Browser",
  ]) {
    assert.ok(isBrowserApp(bundle), bundle);
  }
  assert.equal(isBrowserApp("com.apple.Preview"), false);
  assert.equal(isBrowserApp("com.apple.Notes"), false);
  assert.equal(isBrowserApp(""), false);
  assert.equal(isBrowserApp(undefined), false);
});
