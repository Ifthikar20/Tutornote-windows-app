import { test } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_APPS, BROWSER_PREFIXES, isBrowserApp } from "../../src/main/companionPlace.ts";
import {
  anotherWindow,
  BODY_FOOT,
  BODY_TOP,
  bodyRows,
  BROWSER_BUNDLE_PREFIXES,
  BROWSER_BUNDLES,
  browserBars,
  docKeyOf,
  documentSized,
  firstBodyPoint,
  identVerdict,
  keyOf,
  SAME_LOOK_FOUND,
  SAME_LOOK_SHARE,
  sameDocument,
  sameLook,
  SHEET_CENTRE,
  SHEET_TOP,
  sheetOf,
  titleChange,
  titleSignature,
  type DocLine,
  type DocRead,
  type Frame,
  type IdentLook,
} from "../../src/main/docIdentity.ts";

/*
  The same document or another (src/main/docIdentity.ts). Every read here is made up: lines of
  made-up words shaped like the founder's tap recordings of 2026-10-27 (a Chrome window at
  (2, 44), 1800 x 1125 points, its tab strip, address row and PDF toolbar at 2 to 13% of its
  height, about 30 rows of a page below them), never words read from a screen.
*/

const FRAME: Frame = { x: 2, y: 44, w: 1800, h: 1125 };

/** A line at `share` of the window's height (its centre), 18 points tall. */
const at = (t: string, share: number, x = 300): DocLine => ({ t, x, y: FRAME.y + FRAME.h * share - 9, w: 600, h: 18 });

/** Chrome's own bars, the same in every read of the window. */
const BARS: DocLine[] = [
  at("Alpha tab title - Bravo tab title", 0.02, 40),
  at("file users student downloads sample", 0.06, 200),
  at("Sample document toolbar zoom", 0.1, 60),
  at("Fit to page rotate download print", 0.13, 900),
];

/** A page of `n` made-up rows from 18% of the height down, with words unique to `seed`. */
function page(seed: string, n = 28, from = 0.18): DocLine[] {
  const rows: DocLine[] = [];
  for (let i = 0; i < n; i++) rows.push(at(`${seed} row ${i} carries words ${seed}${i} lorem ipsum`, from + (i * (0.9 - from)) / n));
  return rows;
}

const read = (lines: DocLine[], over: Partial<DocRead> = {}): DocRead => ({
  app: "Google Chrome",
  bundle: "com.google.Chrome",
  title: "Sample.pdf",
  window: 3545,
  frame: FRAME,
  lines,
  ...over,
});

test("a title's signature leaves out counters, the app's name, an edit mark, where the reader is, and its digits", () => {
  assert.equal(titleSignature("(3) Inbox", "Mail"), "inbox");
  assert.equal(titleSignature("(99+) Inbox", "Mail"), "inbox");
  assert.equal(titleSignature("Lecture 3.pdf", "Google Chrome"), "lecture #.pdf");
  assert.equal(titleSignature("Notes  on   Cells - Google Chrome", "Google Chrome"), "notes on cells");
  assert.equal(titleSignature("Essay draft \u2014 Edited", "TextEdit"), "essay draft");
  assert.equal(titleSignature("Essay draft Edited", "Pages"), "essay draft");
  assert.equal(titleSignature("Deck.pdf (page 3 of 9)", "Preview"), "deck.pdf");
  assert.equal(titleSignature("Deck - Slide 4", "Keynote"), "deck");
  assert.equal(titleSignature("Deck, slide 4 of 9", "Keynote"), "deck");
  // (full width letters and digits, as NFKC reads them)
  assert.equal(titleSignature("\uff2c\uff45\uff43\uff54\uff55\uff52\uff45 \uff13", "Preview"), "lecture #");
});

test("a title that is only the app's name, or nothing, says nothing", () => {
  assert.equal(titleSignature("Kindle", "Kindle"), "");
  assert.equal(titleSignature("  ", "Preview"), "");
  assert.equal(titleSignature("", "Preview"), "");
  assert.equal(titleChange("Kindle", "Kindle", "Kindle"), "weak");
  assert.equal(titleChange("Kindle", "A book", "Kindle"), "weak");
  assert.equal(titleChange("Lecture 3.pdf", "", "Google Chrome"), "weak");
});

test("how a title changed: none, digits, letters", () => {
  assert.equal(titleChange("(3) Inbox", "(4) Inbox", "Mail"), "none");
  assert.equal(titleChange("Sample.pdf", "Sample.pdf - Google Chrome", "Google Chrome"), "none");
  assert.equal(titleChange("Lecture 3.pdf", "Lecture 4.pdf", "Google Chrome"), "digits");
  assert.equal(titleChange("9780000000017.pdf", "Week5_2026 (1).pdf", "Google Chrome"), "letters");
  assert.equal(titleChange("Week5_2026 (1).pdf", "9780000000017.pdf", "Google Chrome"), "letters");
  assert.equal(titleChange("Deck.pdf (page 3 of 9)", "Deck.pdf (page 4 of 9)", "Preview"), "none");
});

test("body rows: the band below the browser's bars and above a footer, four letters, each found once", () => {
  const lines = [
    ...BARS,
    at("12", 0.5),
    at("Repeated logo row", 0.3),
    at("Repeated logo row", 0.6),
    at("A body row here", 0.4),
    at("Footer line with words", 0.95),
  ];
  const rows = bodyRows(read(lines));
  assert.deepEqual(
    rows.map((r) => r.key),
    ["a body row here"],
  );
  // (the band's edges, as the shares say)
  assert.equal(bodyRows(read([at("Just inside the top", BODY_TOP + 0.001)])).length, 1);
  assert.equal(bodyRows(read([at("Just above the top", BODY_TOP - 0.001)])).length, 0);
  assert.equal(bodyRows(read([at("Just above the bottom", 1 - BODY_FOOT - 0.001)])).length, 1);
  assert.equal(bodyRows(read([at("Just below the bottom", 1 - BODY_FOOT + 0.001)])).length, 0);
  assert.equal(keyOf("  Hello, World!  "), "hello world");
});

test("Chrome's bars, identical in both reads, are no same look", () => {
  assert.equal(sameLook(read(BARS), read(BARS)), 0);
  assert.equal(sameLook(read([...BARS, ...page("alpha")]), read([...BARS, ...page("bravo")])), 0);
});

test("the same look read twice is the same; another document, a far part and the next slide are not", () => {
  const alpha = page("alpha");
  assert.equal(sameLook(read([...BARS, ...alpha]), read([...BARS, ...alpha])), 1);
  // A fast read of the same look: a quarter of its rows read a little differently.
  const fast = alpha.map((l, i) => (i % 4 === 0 ? { ...l, t: `${l.t}x` } : l));
  const share = sameLook(read([...BARS, ...alpha]), read([...BARS, ...fast]));
  assert.ok(share >= SAME_LOOK_SHARE && share < 1, `fast vs careful ${share}`);
  // Another document, and a far part of the same one (one row in thirty in common).
  assert.equal(sameLook(read([...BARS, ...alpha]), read([...BARS, ...page("bravo")])), 0);
  const far = page("charlie");
  far[10] = alpha[27];
  assert.ok(sameLook(read([...BARS, ...alpha]), read([...BARS, ...far])) < 0.1);
  // The next slide: its title row and a logo row come again, the rest is new.
  const slide = [at("Deck title row", 0.2), at("Logo row of the deck", 0.85), ...page("slide one", 10, 0.3)];
  const next = [at("Deck title row", 0.2), at("Logo row of the deck", 0.85), ...page("slide two", 10, 0.3)];
  assert.ok(sameLook(read(slide), read(next)) < SAME_LOOK_SHARE);
  // A read with no body rows matches nothing.
  assert.equal(sameLook(read(alpha), read([])), 0);
});

test("a document's key is its app, its window and its title's signature", () => {
  assert.equal(docKeyOf(read([])), "com.google.Chrome|3545|sample.pdf");
  assert.equal(docKeyOf(read([], { title: "Lecture 3.pdf" })), docKeyOf(read([], { title: "Lecture 4.pdf" })));
  assert.notEqual(docKeyOf(read([], { title: "Lecture 3.pdf" })), docKeyOf(read([], { title: "Lecture 3.pdf", window: 3546 })));
  assert.equal(docKeyOf(read([], { app: "Kindle", bundle: "com.amazon.Lassen", title: "Kindle", window: 7 })), "com.amazon.Lassen|7|");
});

test("a switched lesson begins at the first body row, else the topmost line under the bars, else the window's centre", () => {
  const p = firstBodyPoint(read([...BARS, at("Second body row", 0.5), at("First body row", 0.3)]));
  assert.deepEqual(p, { x: 600, y: FRAME.y + FRAME.h * 0.3 });
  // (a browser's bars alone: never a point on its tab strip, where a click would pick a tab)
  assert.deepEqual(firstBodyPoint(read(BARS)), { x: FRAME.x + FRAME.w / 2, y: FRAME.y + FRAME.h / 2 });
  assert.deepEqual(firstBodyPoint(read([...BARS, at("12", 0.6), at("7", 0.4)])), { x: 600, y: FRAME.y + FRAME.h * 0.4 });
  assert.deepEqual(firstBodyPoint(read([])), { x: FRAME.x + FRAME.w / 2, y: FRAME.y + FRAME.h / 2 });
});

test("the same document: enough rows of its own, most of them found in the lesson's last read or its latest look", () => {
  const alpha = page("alpha");
  assert.deepEqual(sameDocument([read([...BARS, ...alpha])], read([...BARS, ...alpha])), { same: true, share: 1, rows: 28 });
  assert.equal(sameDocument([read([...BARS, ...alpha])], read([...BARS, ...page("bravo")])).same, false);
  // (after a scroll the page followed with a quick read: the last accurate read is the look before it)
  const scrolled = page("alpha later");
  const seen = sameDocument([read([...BARS, ...alpha]), read([...BARS, ...scrolled])], read([...BARS, ...scrolled]));
  assert.equal(seen.same, true);
  assert.equal(seen.share, 1);
  // One row found again cannot tell: a short window's bookmarks row in the band, over a page with
  // no other row of its own yet. Two can (a sparse page whose title changed by itself).
  const bookmarks = at("Bookmarks folder reading list", 0.16, 40);
  assert.equal(sameDocument([read([...BARS, bookmarks, ...alpha])], read([...BARS, bookmarks])).same, false);
  assert.equal(sameDocument([read([...BARS, ...alpha])], read([...BARS, alpha[3], alpha[9]])).same, true);
  assert.equal(SAME_LOOK_FOUND, 2);
});

/*
  A browser's own bars in a window shorter than the founder's: they reach into the band there (the
  tap recordings: its bookmarks a line each at 99 to 102 points from its top, a PDF viewer's toolbar
  at 149 to 165), and are found by what they hold, as the web app's screenBlocks.ts markBars does.
*/

/** A line `top` points below the top of `frame`, 16 points tall. */
const line = (frame: Frame, t: string, top: number, x: number, w: number): DocLine => ({ t, x: frame.x + x, y: frame.y + top, w, h: 16 });

/** Chrome's tabs and address row, and its bookmarks a line each, spread across the window. */
function chromeBars(frame: Frame, bookmarks = true): DocLine[] {
  const names = ["Mailbox", "Videos", "Mapsite", "Newsdesk", "Shopfront", "Recipes", "Weather", "Library", "Calendar", "Folders"];
  return [
    line(frame, "Tabalpha", 13, 80, 120),
    line(frame, "Tabbravo", 13, 260, 120),
    line(frame, "example.org/sample/path", 47, 140, 500),
    ...(bookmarks ? names.map((n, i) => line(frame, n, 92, 20 + i * 110, 70)) : []),
  ];
}

/** `n` rows of made-up words unique to `seed`, from `from` points below the top, 24 apart. */
const rowsOf = (frame: Frame, seed: string, n: number, from = 130): DocLine[] =>
  Array.from({ length: n }, (_, i) => line(frame, `${seed} made up row ${String.fromCharCode(97 + i)} with several words`, from + i * 24, 120, 700));

const chrome = (frame: Frame, lines: DocLine[], title = "Sample page"): DocRead => ({ ...read(lines, { title, frame }), bundle: "com.google.Chrome" });

test("a short Chrome window: its bookmarks, a line each, are bars, not rows of the page", () => {
  const short: Frame = { x: 0, y: 25, w: 1200, h: 640 };
  // (the band alone would take them: they sit below BODY_TOP of this window)
  assert.ok(short.y + 92 + 8 > short.y + BODY_TOP * short.h);
  const old = chrome(short, [...chromeBars(short), ...rowsOf(short, "old", 18)], "Article one");
  assert.equal(bodyRows(old).length, 18);
  assert.equal(browserBars(old).size, 13);
  // A tab with none, or a few, rows of its own yet is no same look: the bookmarks are in both.
  for (const k of [0, 2, 4, 6]) {
    assert.equal(sameDocument([old], chrome(short, [...chromeBars(short), ...rowsOf(short, "new", k)], "Other page")).same, false, `${k} rows`);
  }
  // The same page read again is.
  assert.equal(sameDocument([old], chrome(short, [...chromeBars(short), ...rowsOf(short, "old", 18)])).same, true);
  // (and with no bookmarks shown, the first rows of the page just under the address row stay)
  const plain = chrome(short, [...chromeBars(short, false), ...rowsOf(short, "plain", 6, 92)]);
  assert.equal(bodyRows(plain).length, 6);
  // (another app's window keeps every line in its band: no browser, no bars)
  assert.equal(bodyRows({ ...old, bundle: "com.apple.Preview" }).length, 18 + 10);
});

test("Chrome's PDF toolbar, its file's name and counter under the bookmarks, is a bar in a 900 point window", () => {
  const mid: Frame = { x: 0, y: 25, w: 1200, h: 900 };
  const toolbar = [line(mid, "Lecture4.pdf", 142, 60, 160), line(mid, "3 / 37", 142, 560, 50), line(mid, "100%", 142, 690, 40)];
  const loading = chrome(mid, [...chromeBars(mid), ...toolbar], "Lecture4.pdf");
  // (the file's name lies in the band of this window, under BODY_TOP)
  assert.ok(mid.y + 142 + 8 > mid.y + BODY_TOP * mid.h);
  assert.equal(bodyRows(loading).length, 0);
  // A switched lesson never begins on it: no line of the page yet, the window's centre.
  assert.deepEqual(firstBodyPoint(loading), { x: 600, y: mid.y + 450 });
  const drawn = chrome(mid, [...chromeBars(mid), ...toolbar, ...rowsOf(mid, "drawn", 12, 190)], "Lecture4.pdf");
  assert.equal(bodyRows(drawn).length, 12);
  assert.deepEqual(firstBodyPoint(drawn), { x: 120 + 350, y: mid.y + 190 + 8 });
});

test("a table right under the address row is the page's, not a bar", () => {
  const short: Frame = { x: 0, y: 25, w: 1200, h: 640 };
  // A table's first rows, in columns that the row under each lines up with.
  const cells = (top: number, seed: string) => ["Name", "Grade", "Points", "Notes"].map((c, i) => line(short, `${c} ${seed} cell`, top, 40 + i * 290, 200));
  const table = chrome(short, [...chromeBars(short, false), ...cells(92, "first"), ...cells(117, "second"), ...cells(142, "third")]);
  assert.equal(browserBars(table).size, 3);
  assert.equal(bodyRows(table).length, 12);
});

test("Arc's sidebar, its address and the other tabs' titles, is its bars; the page beside it is not", () => {
  const frame: Frame = { x: 0, y: 25, w: 1400, h: 700 };
  const sidebar = [line(frame, "example.org/sample", 20, 20, 220), ...["Tab one title", "Tab two title", "Tab three title", "Tab four title"].map((t, i) => line(frame, t, 110 + i * 30, 30, 200))];
  const page = rowsOf(frame, "arc page", 8, 110).map((l) => ({ ...l, x: frame.x + 420 }));
  const arc: DocRead = { ...chrome(frame, [...sidebar, ...page]), bundle: "company.thebrowser.Browser" };
  assert.equal(browserBars(arc).size, 5);
  assert.deepEqual(
    bodyRows(arc).map((r) => r.x),
    page.map((l) => l.x),
  );
  // (in Chrome the same lines are no sidebar: its address row is over the page)
  assert.equal(bodyRows({ ...arc, bundle: "com.google.Chrome" }).length, 8 + 4);
});

test("the browsers are companionPlace.ts's own", () => {
  assert.deepEqual([...BROWSER_BUNDLES].sort(), [...BROWSER_APPS].sort());
  assert.deepEqual([...BROWSER_BUNDLE_PREFIXES], [...BROWSER_PREFIXES]);
  assert.equal(isBrowserApp("com.google.Chrome.canary"), true);
  assert.equal(browserBars({ frame: FRAME, lines: [at("example.org/sample", 0.03)], bundle: "com.google.Chrome.canary" }).size, 1);
});

/*
  The Mac app's switch rule on the helper's ident of the lesson's window.
*/

const LESSON = {
  window: 3545,
  app: "Google Chrome",
  title: "9780000000017.pdf",
  frame: FRAME,
  top: 3545,
  switching: null,
};
const ident = (over: Partial<IdentLook> = {}): IdentLook => ({
  window: 3545,
  title: "9780000000017.pdf",
  onScreen: true,
  top: 3545,
  topTitle: "9780000000017.pdf",
  topFrame: FRAME,
  ...over,
});

test("a tab switch in the lesson's window is another document; a counter or a page number is not", () => {
  assert.deepEqual(identVerdict(LESSON, ident({ title: "Week5_2026 (1).pdf", topTitle: "Week5_2026 (1).pdf" })), {
    act: "switch",
    why: "title",
    target: 3545,
  });
  assert.equal(identVerdict(LESSON, ident()), null);
  assert.equal(identVerdict({ ...LESSON, title: "(3) Inbox", app: "Mail" }, ident({ title: "(4) Inbox" })), null);
  assert.equal(identVerdict({ ...LESSON, title: "Kindle", app: "Kindle" }, ident({ title: "Kindle" })), null);
  // (its app behind: a title that changed out of sight waits for the student to come back)
  assert.equal(identVerdict(LESSON, ident({ title: "Week5_2026 (1).pdf", top: null, topTitle: "", topFrame: null })), null);
  // (nor with the lesson's window off the screen: minimised, another Space, its app in front)
  assert.equal(
    identVerdict(LESSON, ident({ title: "Week5_2026 (1).pdf", onScreen: false, top: 77, topTitle: "", topFrame: { x: 0, y: 0, w: 300, h: 200 } })),
    null,
  );
  // (another window's ident is nobody's here)
  assert.equal(identVerdict(LESSON, ident({ window: 1, title: "Other.pdf" })), null);
});

test("a title changed in its digits alone is looked at, never taken as it is", () => {
  assert.deepEqual(identVerdict({ ...LESSON, title: "Lecture 3.pdf" }, ident({ title: "Lecture 4.pdf" })), { act: "check" });
  assert.deepEqual(identVerdict({ ...LESSON, title: "Week5 (1).pdf" }, ident({ title: "Week5 (2).pdf" })), { act: "check" });
  assert.equal(identVerdict({ ...LESSON, title: "Lecture 3.pdf" }, ident({ title: "Lecture 4.pdf", onScreen: false })), null);
  assert.equal(identVerdict({ ...LESSON, title: "Lecture 3.pdf" }, ident({ title: "Lecture 4.pdf", top: null, topTitle: "", topFrame: null })), null);
});

test("a title the lesson's document has shown before is its own: a page flashing a notice is not two documents", () => {
  const flashing = { ...LESSON, title: "Course page", titles: ["Reminder from the course"] };
  assert.equal(identVerdict(flashing, ident({ title: "Reminder from the course" })), null);
  assert.equal(identVerdict({ ...flashing, title: "Reminder from the course", titles: ["Course page"] }, ident({ title: "Course page" })), null);
  assert.deepEqual(identVerdict(flashing, ident({ title: "Another page" })), { act: "switch", why: "title", target: 3545 });
  // (and, during a switch, a way back: the lesson goes on)
  const switching = { ...flashing, switching: { why: "title" as const, target: 3545 } };
  assert.deepEqual(identVerdict(switching, ident({ title: "Reminder from the course" })), { act: "cancel" });
});

test("another window of the lesson's app come to the front, as large as a document's, is another document", () => {
  const preview = { ...LESSON, app: "Preview", title: "Deck.pdf", window: 10, top: 10, frame: { x: 100, y: 60, w: 900, h: 1000 } };
  const second = { x: 140, y: 90, w: 880, h: 980 };
  assert.deepEqual(identVerdict(preview, ident({ window: 10, title: "Deck.pdf", top: 11, topTitle: "Notes.pdf", topFrame: second })), {
    act: "switch",
    why: "window",
    target: 11,
  });
  // (the lesson's window off the screen, a native tab in front)
  assert.deepEqual(
    identVerdict(preview, ident({ window: 10, title: "Deck.pdf", onScreen: false, top: 12, topTitle: "Notes.pdf", topFrame: preview.frame })),
    { act: "switch", why: "window", target: 12 },
  );
  // (a smaller document's window opened over it at the corner, as a new window is)
  const corner = { x: 122, y: 82, w: 600, h: 800 };
  assert.deepEqual(identVerdict(preview, ident({ window: 10, title: "Deck.pdf", top: 14, topTitle: "Notes.pdf", topFrame: corner })), {
    act: "switch",
    why: "window",
    target: 14,
  });
  // A Save sheet or a dialog in front of it is no document.
  const sheet = { x: 300, y: 120, w: 480, h: 260 };
  assert.equal(identVerdict(preview, ident({ window: 10, title: "Deck.pdf", top: 13, topTitle: "", topFrame: sheet })), null);
  assert.equal(documentSized({ x: 0, y: 0, w: 300, h: 900 }, preview.frame), false);
  assert.equal(documentSized(null, preview.frame), true);
});

test("a sheet, a popup or the window in front as the lesson began is no switch", () => {
  const big = { x: 0, y: 0, w: 1000, h: 800 };
  const lesson = { ...LESSON, app: "Preview", title: "Deck.pdf", window: 10, top: 10, frame: big };
  // The Print sheet: no title, large enough by size.
  const print = { x: 100, y: 52, w: 800, h: 560 };
  assert.equal(documentSized(print, big), true);
  assert.equal(identVerdict(lesson, ident({ window: 10, title: "Deck.pdf", top: 20, topTitle: "", topFrame: print })), null);
  // A sheet with a title all the same hangs from the window: centred, under its toolbar.
  assert.equal(sheetOf(print, big), true);
  assert.equal(identVerdict(lesson, ident({ window: 10, title: "Deck.pdf", top: 20, topTitle: "Print", topFrame: print })), null);
  assert.equal(sheetOf({ x: 22, y: 22, w: 600, h: 700 }, big), false);
  assert.equal(SHEET_TOP >= 40 && SHEET_CENTRE <= 4, true);
  // A browser's suggestions popup, as large as it is, has no title.
  const chrome = { ...LESSON, frame: { x: 0, y: 25, w: 1440, h: 900 } };
  assert.equal(identVerdict(chrome, ident({ top: 30, topTitle: "", topFrame: { x: 220, y: 90, w: 1000, h: 380 } })), null);
  // The student's other window left in front of the one they picked: the first ident is the
  // baseline; only a window that comes to the front afterwards is another document.
  const picked = { ...LESSON, top: undefined };
  const gmail = { x: 40, y: 60, w: 1400, h: 860 };
  assert.equal(identVerdict(picked, ident({ top: 40, topTitle: "Inbox", topFrame: gmail })), null);
  assert.equal(identVerdict({ ...LESSON, top: 40 }, ident({ top: 40, topTitle: "Inbox", topFrame: gmail })), null);
  assert.deepEqual(identVerdict({ ...LESSON, top: 3545 }, ident({ top: 40, topTitle: "Inbox", topFrame: gmail })), {
    act: "switch",
    why: "window",
    target: 40,
  });
  // (what moves that baseline: the lesson's own window or another document's, never a popup)
  assert.equal(anotherWindow(LESSON, ident({ top: 40, topTitle: "Inbox", topFrame: gmail })), true);
  assert.equal(anotherWindow(LESSON, ident({ top: 30, topTitle: "", topFrame: { x: 220, y: 90, w: 1000, h: 380 } })), false);
  assert.equal(anotherWindow(LESSON, ident()), false);
});

test("a switch is cancelled by the title back as it was, or the lesson's window back in front", () => {
  const switching = { ...LESSON, switching: { why: "title" as const, target: 3545 } };
  assert.deepEqual(identVerdict(switching, ident()), { act: "cancel" });
  assert.equal(identVerdict(switching, ident({ title: "Week5_2026 (1).pdf" })), null);
  // (another number is another document: no way back, nor a new start while one is going)
  assert.equal(identVerdict({ ...switching, title: "Lecture 3.pdf" }, ident({ title: "Lecture 4.pdf" })), null);
  const tap = { ...LESSON, switching: { why: "tap" as const, target: 3545 } };
  assert.deepEqual(identVerdict(tap, ident()), { act: "cancel" });
  const toWindow = { ...LESSON, switching: { why: "window" as const, target: 9 } };
  assert.equal(identVerdict(toWindow, ident({ top: 9, topTitle: "Other.pdf" })), null);
  assert.deepEqual(identVerdict(toWindow, ident()), { act: "cancel" });
  assert.equal(identVerdict(toWindow, ident({ onScreen: false })), null);
  // (one to another app is cancelled by that app going, not by an ident; and nothing starts twice)
  const toApp = { ...LESSON, switching: { why: "app" as const, target: 77 } };
  assert.equal(identVerdict(toApp, ident()), null);
  assert.equal(identVerdict(toApp, ident({ title: "Week5_2026 (1).pdf" })), null);
});

test("a switch left waiting reads again as the other window's title changes", () => {
  const waiting = { ...LESSON, switching: { why: "title" as const, target: 3545, waiting: "New Tab" } };
  assert.equal(identVerdict(waiting, ident({ title: "New Tab" })), null);
  assert.deepEqual(identVerdict(waiting, ident({ title: "Search results page" })), { act: "reread" });
  // (back to the lesson's own document: it goes on)
  assert.deepEqual(identVerdict(waiting, ident()), { act: "cancel" });
  // (out of sight: nothing until the student is back)
  assert.equal(identVerdict(waiting, ident({ title: "Search results page", onScreen: false })), null);
  const toWindow = { ...LESSON, switching: { why: "window" as const, target: 9, waiting: "New Tab" } };
  assert.deepEqual(identVerdict(toWindow, ident({ top: 9, topTitle: "Week5_2026 (1).pdf" })), { act: "reread" });
  assert.equal(identVerdict(toWindow, ident({ top: 9, topTitle: "New Tab" })), null);
  // (secure input: waits with no title, and a title says nothing of it)
  const secure = { ...LESSON, switching: { why: "title" as const, target: 3545, waiting: "" } };
  assert.equal(identVerdict(secure, ident({ title: "Week5_2026 (1).pdf" })), null);
});

test("a switch left waiting goes where the student goes on to in the lesson's app", () => {
  const third = { x: 100, y: 80, w: 1500, h: 1000 };
  // A new tab waiting for words, and the student on to another document's window of the app.
  const tab = { ...LESSON, switching: { why: "title" as const, target: 3545, waiting: "New Tab" } };
  assert.deepEqual(identVerdict(tab, ident({ title: "New Tab", top: 300, topTitle: "Bravo slides", topFrame: third })), {
    act: "retarget",
    why: "window",
    target: 300,
  });
  // A blank new window waiting for words, and the student on to a third one.
  const blank = { ...LESSON, top: 200, switching: { why: "window" as const, target: 200, waiting: "New Tab" } };
  assert.deepEqual(identVerdict(blank, ident({ top: 300, topTitle: "Bravo slides", topFrame: third })), {
    act: "retarget",
    why: "window",
    target: 300,
  });
  // ...or back to the lesson's own window, showing another tab now (its own: a flick, cancelled).
  assert.deepEqual(identVerdict(blank, ident({ title: "Charlie notes" })), { act: "retarget", why: "title", target: 3545 });
  assert.deepEqual(identVerdict(blank, ident()), { act: "cancel" });
  // (the window it waits on, still in front: as before, only another title there reads it again)
  assert.equal(identVerdict(blank, ident({ top: 200, topTitle: "New Tab", topFrame: third })), null);
  assert.deepEqual(identVerdict(blank, ident({ top: 200, topTitle: "Delta page", topFrame: third })), { act: "reread" });
  // Not while it is read (its run would start where the student is not), nor a popup in front, nor
  // one taken to another app (back in the lesson's app, that is the Mac app's to judge: onFront).
  assert.equal(identVerdict({ ...tab, switching: { why: "title" as const, target: 3545 } }, ident({ title: "New Tab", top: 300, topTitle: "Bravo slides", topFrame: third })), null);
  assert.equal(identVerdict(tab, ident({ title: "New Tab", top: 30, topTitle: "", topFrame: { x: 220, y: 90, w: 1000, h: 380 } })), null);
  const toApp = { ...LESSON, switching: { why: "app" as const, target: 77, waiting: "Deck.pdf" } };
  assert.equal(identVerdict(toApp, ident({ top: 300, topTitle: "Bravo slides", topFrame: third })), null);
});
