/*
  Is it the same document? The rule a lesson over another app's window (screenTeach.ts) uses to
  tell another document in that window, or in another window of its app, from another part of the
  one it is teaching. The web app keeps the same rule, with the same numbers, in its
  src/lib/screen/docIdentity.ts (its lesson page decides by it when the Mac app is older than this).

  The window's title decides: a Chrome tab switch keeps the window (its CGWindowID) and changes
  its title, and nothing in the words can tell another document from a far part of the same one
  (measured on the founder's tap recordings, 2026-10-27: the rows shared between two reads of
  the same document far apart were 0.02 of them, and between two different documents 0.0). The
  words only confirm a title that changed by itself (a counter, a page that renamed itself as it
  loaded): the same look again is the same document.

  - titleSignature: a title as the rule compares it. NFKC, lower case, its spaces collapsed; a
    leading counter "(3) " off, a trailing " - <app>", " - edited" or "Edited" off, "page 3 of
    9" and "slide 4" off, every run of digits "#". "" when nothing is left, or the title is only
    the app's name (Kindle's window is always called "Kindle"): such a title says nothing.
  - titleChange: "none" (the same title, but for a counter or the app's name), "digits" (only its
    numbers changed: "Lecture 3.pdf" to "Lecture 4.pdf"), "letters" (another title), "weak" (one of
    the two says nothing).
  - bodyRows: the rows of a read that are the page's own: their centre between BODY_TOP of the
    window's height from its top and BODY_FOOT from its foot (a browser's tab strip, address row
    and PDF toolbar sit at 2 to 13% of it; a reader's footer at its foot), with BODY_LETTERS
    letters at least, each found once in the read (keyOf, as the web app's screenBlocks.ts keys
    rows), and, in a browser's window (by its bundle), none of its own bars (browserBars: the web
    app's markBars, which its blocks mark as furniture). The band alone does not keep them out of a
    window shorter than the founder's: its bookmarks, a line each, stand at 99 to 102 points from
    its top and a PDF viewer's toolbar at 149 to 165 (the tap recordings), inside the band of a
    window under 1100 points tall.
  - sameLook: the share of the later read's body rows found in the earlier one. SAME_LOOK_SHARE
    or more is the same look (measured: 0.73 to 1.0 for the same look read twice, fast and
    careful; 0.0 for another document; 0.02 for a far part; 0.04 to 0.10 for the next slide).
  - docKeyOf: bundle | window | titleSignature, one document's key.

  Numbers and strings in, numbers and strings out: no Electron, no other module at run time, so it
  is tested on its own (scripts/tests/docIdentity.test.ts). Nothing here is logged: titles and
  rows are the screen's words.
*/

/** A box in screen points (or any points: only ratios of the frame are used). */
export type Frame = { x: number; y: number; w: number; h: number };
/** A line as the helper read it: its words and its box. */
export type DocLine = { t: string; x: number; y: number; w: number; h: number };
/** What the rule needs of a read (screen.ts ScreenRead, in any points, its lines in the same). */
export interface DocRead {
  app: string;
  bundle: string;
  title: string;
  window: number;
  frame: Frame;
  lines: ReadonlyArray<DocLine>;
}

/** The page's own rows lie below this share of the window's height from its top (under a browser's
 *  tabs, address row, bookmarks and a PDF viewer's toolbar: 2 to 13% of the founder's window), */
export const BODY_TOP = 0.15;
/** and above this share of it from its foot (over a reader's position line). */
export const BODY_FOOT = 0.08;
/** A body row has this many letters at least: a page number or a mark says nothing about a look. */
export const BODY_LETTERS = 4;
/** This share of a read's body rows found in another, or more: the same look. */
export const SAME_LOOK_SHARE = 0.6;

export type TitleChange = "none" | "digits" | "letters" | "weak";

/** A row's key, as the web app's screenBlocks.ts keyOf: lower case, letters and digits, single spaces. */
export const keyOf = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const letters = (key: string): number => key.match(/\p{L}/gu)?.length ?? 0;

/** One run of spaces, none at the ends; a title or an app's name NFKC, in lower case, so. */
const squeeze = (s: string): string => s.replace(/\s+/g, " ").trim();
const plain = (s: string): string => squeeze((s ?? "").normalize("NFKC").toLowerCase());
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A title with what changes in it by itself taken out, its digits as they are (the web app's
 *  titleWords, step for step): a leading counter ("(3) Inbox"); a trailing " - <app>", " - edited"
 *  or "Edited" (any dash, or a bar or a dot, before them), as often as they come; "page 3 of 9",
 *  "slide 4" and "slide 4 of 9" wherever they are, with the empty brackets or the separator they
 *  leave. "" when nothing is left, or the title is the app's own name. */
function plainTitle(title: string, app: string): string {
  let t = plain(title);
  const name = plain(app);
  t = t.replace(/^\(\d{1,4}\+?\)\s*/, "");
  for (let again = true; again; ) {
    const was = t;
    if (name) t = t.replace(new RegExp(`\\s*[-\u2013\u2014|\u00b7]\\s*${escape(name)}$`), "");
    t = t.replace(/\s*[-\u2013\u2014|\u00b7]\s*edited$/, "").replace(/\s+edited$/, "");
    t = t.trim();
    again = t !== was;
  }
  t = t.replace(/\bpage\s+\d+\s+of\s+\d+\b/g, " ").replace(/\bslide\s+\d+(?:\s+of\s+\d+)?\b/g, " ");
  // (what that leaves: an empty pair of brackets, a separator at an end or doubled)
  t = squeeze(t.replace(/\(\s*\)|\[\s*\]/g, " "))
    .replace(/^[-\u2013\u2014|\u00b7:,\s]+|[-\u2013\u2014|\u00b7:,\s]+$/g, "")
    .replace(/\s*([-\u2013\u2014|\u00b7])\s*(?:[-\u2013\u2014|\u00b7]\s*)+/g, " $1 ");
  t = squeeze(t);
  return t === name ? "" : t;
}

/** A title as the rule compares it (above): "" says nothing ("weak"). */
export function titleSignature(title: string, app: string): string {
  return plainTitle(title, app).replace(/\d+/g, "#");
}

/** How the title `now` differs from `was`, of a window of `app`. */
export function titleChange(was: string, now: string, app: string): TitleChange {
  const a = plainTitle(was, app);
  const b = plainTitle(now, app);
  if (!a || !b) return "weak";
  if (a === b) return "none";
  return a.replace(/\d+/g, "#") === b.replace(/\d+/g, "#") ? "digits" : "letters";
}

/*
  A browser's own bars (bodyRows), as the web app's screenBlocks.ts markBars finds them, step for
  step, on the read's lines (its rows are lines joined side by side; a bar is found by its pieces
  either way). Set at the interface's size, often the page's own, so by what they hold:
  - the address row: a web address or a local file's path (addressPiece), the first such line from
    the top;
  - a viewer's toolbar: a page counter (counterPiece) on a row of separate controls spread across
    the window (barRow: BAR_PIECES lines level with it at least, BAR_WORDS words each at most,
    over BAR_SPREAD of its width), under the address row;
  both in the window's top BAR_BAND. The bars end at the foot of the lowest toolbar, or, with an
  address row alone, at the foot of the rows of controls right under it (the bookmarks: barRow,
  each BAR_STEP of the last one's heights below it at most, never a table's or the page's
  columns: columned). Every line whose middle is above that is a bar. Never past a line set
  BAR_TALL times as tall as the one they end at (a heading of the page). Arc (ARC) keeps its tabs
  and its address down a sidebar instead: that strip is its bars (arcSidebar), and over the page
  beside it only a viewer's toolbar is.
*/

/** Browsers, by their bundle id: the list companionPlace.ts keeps (BROWSER_APPS, and Chrome and
 *  Edge in any of their channels by BROWSER_PREFIXES), kept here too so this module needs no other
 *  (scripts/tests/docIdentity.test.ts holds the two the same). */
export const BROWSER_BUNDLES: ReadonlySet<string> = new Set([
  "com.apple.Safari",
  "com.apple.SafariTechnologyPreview",
  "org.mozilla.firefox",
  "org.mozilla.firefoxdeveloperedition",
  "org.mozilla.nightly",
  "company.thebrowser.Browser",
  "com.brave.Browser",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
  "com.kagi.kagimacOS",
  "org.chromium.Chromium",
]);
export const BROWSER_BUNDLE_PREFIXES: readonly string[] = ["com.google.Chrome", "com.microsoft.edgemac"];
const isBrowser = (bundle: string | undefined): boolean =>
  Boolean(bundle && (BROWSER_BUNDLES.has(bundle) || BROWSER_BUNDLE_PREFIXES.some((prefix) => bundle.startsWith(prefix))));
const ARC = "company.thebrowser.Browser";

/** The web app's numbers (screenBlocks.ts), the same. */
const BAR_BAND = 0.3;
const BAR_TALL = 1.8;
const BAR_STEP = 2.5;
const BAR_PIECES = 3;
const BAR_SPREAD = 0.5;
const BAR_WORDS = 12;
const SIDEBAR = 0.3;
const SIDEBAR_LEFT = 0.05;
const SIDEBAR_STEP = 2;
const ADDRESS = /^(?:https?:\/\/)?(?:www\.)?[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:[/?#]\S*)?$/i;
const LOCAL_PATH = /^(?:file:\/\/\/?\S*|~?\/(?:users|volumes|private|home|tmp|library|applications)\/\S*|[a-z]:[\\/]\S*)$/i;
const DOMAIN_END =
  /\.(?:com|org|net|edu|gov|mil|int|io|ai|co|app|dev|me|info|biz|tv|ly|so|gg|xyz|site|online|tech|blog|news|page|cloud|us|uk|ca|au|nz|de|fr|es|it|nl|se|no|fi|dk|ch|at|be|ie|pt|pl|cz|ru|ua|in|jp|cn|kr|sg|hk|tw|br|mx|ar|za|ng|ke|eg|ae|sa|il|tr|gr|ro|hu|id|my|ph|th|vn|pk|bd|lk)(?::\d+)?(?:[/?#]\S*)?$/i;
const ADDRESS_RUN = 24;
const COUNTER = /^(?:page\s*)?(?:\d{1,5}\s*)?(?:\/|of)\s*\d{1,5}$/i;

/** A piece of an address row: a web address or a local path, alone or beside a word or two. */
function addressPiece(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return false;
  return words.some(
    (w) =>
      LOCAL_PATH.test(w) ||
      (ADDRESS.test(w) && /\p{L}/u.test(w) && (/^(?:https?:\/\/|www\.)/i.test(w) || DOMAIN_END.test(w))) ||
      (w.length >= ADDRESS_RUN && /\p{L}/u.test(w) && /[./]/.test(w)),
  );
}

/** A page counter as a viewer's toolbar shows it ("24 / 37", "Page 3 of 9"), its marks and zoom aside. */
const counterPiece = (text: string): boolean =>
  COUNTER.test(
    text
      .split(/\s+/)
      .filter((w) => w && !/^(?:[^\p{L}\p{N}/]+|\d{1,3}\s?%)$/u.test(w))
      .join(" "),
  );

type Box = { x: number; y: number; w: number; h: number };
const right = (b: Box): number => b.x + b.w;
const foot = (b: Box): number => b.y + b.h;
const midY = (b: Box): number => b.y + b.h / 2;
const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** Arc's sidebar: its address wholly inside the window's left SIDEBAR share, starting inside its
 *  SIDEBAR_LEFT, in its top BAR_BAND (the first such from the top), and every line that starts no
 *  further than SIDEBAR_STEP of the address's heights past its end, wholly inside that share (the
 *  other tabs' titles). Those lines, and where the page beside them starts; null for no sidebar. */
function arcSidebar(lines: ReadonlyArray<DocLine>, frame: Frame): { lines: DocLine[]; edge: number } | null {
  const strip = frame.x + SIDEBAR * frame.w;
  const address = [...lines]
    .filter((l) => foot(l) <= frame.y + BAR_BAND * frame.h)
    .sort((a, b) => a.y - b.y)
    .find((l) => addressPiece(l.t) && right(l) <= strip && l.x <= frame.x + SIDEBAR_LEFT * frame.w);
  if (!address) return null;
  const edge = right(address) + SIDEBAR_STEP * address.h;
  const side = lines.filter((l) => l.x < edge && right(l) <= strip);
  return side.some((l) => l.y > foot(address)) ? { lines: side, edge } : null;
}

/** The lines of a read that are its browser's own bars (above), for a read of a browser's window
 *  (its `bundle`); none for any other. */
export function browserBars(read: Look): Set<DocLine> {
  const bars = new Set<DocLine>();
  const frame = read.frame;
  if (!isBrowser(read.bundle) || !(frame.w > 0) || !(frame.h > 0)) return bars;
  const side = read.bundle === ARC ? arcSidebar(read.lines, frame) : null;
  for (const line of side?.lines ?? []) bars.add(line);
  const page = side ? read.lines.filter((l) => l.x >= side.edge) : read.lines;
  const top = page.filter((l) => foot(l) <= frame.y + BAR_BAND * frame.h).sort((a, b) => a.y - b.y);
  if (!top.length) return bars;
  // (the lines level with one: their middles inside its height, left to right)
  const level = (r: DocLine) => page.filter((p) => midY(p) >= r.y && midY(p) <= foot(r)).sort((a, b) => a.x - b.x);
  const barRow = (r: DocLine): boolean => {
    const own = level(r);
    if (own.length < BAR_PIECES || own.some((p) => wordCount(p.t) > BAR_WORDS)) return false;
    return Math.max(...own.map(right)) - own[0].x >= BAR_SPREAD * frame.w;
  };
  // (a table's rows or the page's columns: the line under `r` has BAR_PIECES lines at its pieces'
  // left edges, within half a row's height)
  const columned = (r: DocLine): boolean => {
    const after = page.filter((o) => o !== r && midY(o) > foot(r) && o.y <= foot(r) + BAR_STEP * r.h).sort((a, b) => a.y - b.y)[0];
    if (!after) return false;
    const near = Math.max(4, 0.5 * r.h);
    const lefts = level(after).map((p) => p.x);
    return level(r).filter((p) => lefts.some((x) => Math.abs(x - p.x) <= near)).length >= BAR_PIECES;
  };
  // (never past a heading of the page)
  const under = (end: DocLine) =>
    !top.some((r) => r.y < end.y && foot(r) <= end.y + 0.5 * end.h && (r.t.match(/\p{L}/gu)?.length ?? 0) >= 3 && r.h > BAR_TALL * end.h);
  const address = side ? null : (top.find((r) => addressPiece(r.t) && under(r)) ?? null);
  const toolbars = top.filter((r) => counterPiece(r.t) && barRow(r) && under(r) && (!address || r.y > address.y));
  let end: DocLine | null = toolbars.length ? toolbars.reduce((a, b) => (foot(b) > foot(a) ? b : a)) : address;
  if (!end) return bars;
  if (end === address) {
    // (the bookmarks under the address row, and a toolbar whose counter was not read)
    for (;;) {
      const last: DocLine = end;
      const next = top
        .filter((r) => r.y >= foot(last) - 0.25 * last.h && r.y <= foot(last) + BAR_STEP * last.h && midY(r) > foot(last))
        .sort((a, b) => a.y - b.y)[0];
      if (!next || !barRow(next) || !under(next) || columned(next)) break;
      end = next;
    }
  }
  const barsFoot = foot(end);
  for (const line of page) if (midY(line) <= barsFoot) bars.add(line);
  return bars;
}

/** A body row: its key and its box. */
export type BodyRow = { key: string; x: number; y: number; w: number; h: number };

/** What a look is told by: a read's lines and its window's frame, and its app's bundle (a
 *  browser's bars are no rows of its page: browserBars). */
export type Look = Pick<DocRead, "frame" | "lines"> & { bundle?: string };

/** The page's own rows of a read (above), top to bottom. */
export function bodyRows(read: Look): BodyRow[] {
  const f = read.frame;
  if (!(f.h > 0)) return [];
  const top = f.y + f.h * BODY_TOP;
  const bottom = f.y + f.h * (1 - BODY_FOOT);
  const bars = browserBars(read);
  const seen = new Map<string, BodyRow | null>();
  for (const line of read.lines) {
    const centre = line.y + line.h / 2;
    if (centre < top || centre > bottom || bars.has(line)) continue;
    const key = keyOf(line.t);
    if (letters(key) < BODY_LETTERS) continue;
    // (a row found twice in one read can be either of them in another: neither counts)
    seen.set(key, seen.has(key) ? null : { key, x: line.x, y: line.y, w: line.w, h: line.h });
  }
  const rows: BodyRow[] = [];
  for (const row of seen.values()) if (row) rows.push(row);
  return rows.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The share of `after`'s body rows found in `before` (0 to 1; 0 when `after` has none). */
export function sameLook(before: Look, after: Look): number {
  const later = bodyRows(after);
  if (!later.length) return 0;
  const earlier = new Set(bodyRows(before).map((row) => row.key));
  let found = 0;
  for (const row of later) if (earlier.has(row.key)) found++;
  return found / later.length;
}

/** One document's key: its app, its window and its title (signature). */
export const docKeyOf = (read: Pick<DocRead, "bundle" | "window" | "title" | "app">): string =>
  `${read.bundle}|${read.window}|${titleSignature(read.title, read.app)}`;

/** Where a lesson begins on a document it has just switched to: the centre of its first body row
 *  (on a slide, normally its title), else of its topmost line below BODY_TOP of the window (never
 *  one in the top band, nor one of a browser's bars: its tab strip or address row, where a click
 *  would be on a tab, or its toolbar's file name), else the window's centre. */
export function firstBodyPoint(read: Look): { x: number; y: number } {
  const below = read.frame.y + read.frame.h * BODY_TOP;
  const bars = browserBars(read);
  const first =
    bodyRows(read)[0] ?? [...read.lines].filter((line) => line.y + line.h / 2 >= below && !bars.has(line)).sort((a, b) => a.y - b.y)[0];
  if (first) return { x: first.x + first.w / 2, y: first.y + first.h / 2 };
  return { x: read.frame.x + read.frame.w / 2, y: read.frame.y + read.frame.h / 2 };
}

/*
  The Mac app's own part (the web app has none of it): what the helper's "ident" of the lesson's
  window says (main.swift, "The lesson's window: which document"; screen.ts ScreenIdent).

  - Its app in front (`top` is said only then) with another of its windows come to the front since
    the last one said (`IdentLesson.top`; the one in front as the lesson began is the baseline: a
    pick may leave the student's other window in front of the one picked, and that is no
    switch), as large as a document's (SWITCH_MIN_W by SWITCH_MIN_H points, and SWITCH_MIN_SHARE
    of the lesson's window at least), with a title of its own (a sheet, a panel, a browser's
    popup or an extension's has none) and not hanging from the lesson's window as a sheet does
    (sheetOf): another document, in that window ("window"). So is the lesson's window gone off the
    screen with another of its app's windows in front (native tabs, a window closed or minimised).
  - Its app in front, its window on the screen, and its title changed in its letters
    (titleChange): another document in the same window ("title"). Not while its app is behind or
    its window is off the screen: a title that changes out of sight is looked at when the student
    comes back to it. Changed in its digits alone ("Lecture 3.pdf" to "Lecture 4.pdf", or a page
    that numbers itself): its look decides ("check": screenTeach.ts reads it quickly, and only a
    look unlike the lesson's is another document). A title the lesson's document has shown before
    (`IdentLesson.titles`: one that changed by itself, the same look under it) is its own: a page
    whose title flashes a notice and back is not two documents.
  - A switch going on ("title" or "tap") whose window's title is back to the lesson's own (a
    flick: another tab and straight back; its digits alone are no way back: "Lecture 4.pdf" is
    another lecture), or one to another window ("window") with the lesson's window in front again,
    as it was: cancelled. One to another app ("app") is screenTeach.ts's to cancel, or to read
    again what it began on in the lesson's app (that app in front again). One left waiting with
    nothing to read yet (`waiting`: the other window's title then) reads again as that window's
    title changes ("reread": a new tab's page typed in), and goes where the student has gone on to
    in the lesson's app ("retarget"): another document's window in front that it is not reading
    ("window"), or the lesson's own window in front again showing another title than its own while
    it waited on another window ("title").
*/

/** The lesson's window as the helper last said it ("ident"). `topFrame`: where `top` is. */
export interface IdentLook {
  window: number;
  title: string;
  onScreen: boolean;
  top: number | null;
  topTitle: string;
  topFrame?: Frame | null;
}

export type SwitchWhy = "title" | "window" | "app" | "tap";

/** A window in front of the lesson's this small is no document of its own (a sheet, a dialog). */
export const SWITCH_MIN_W = 320;
export const SWITCH_MIN_H = 240;
export const SWITCH_MIN_SHARE = 0.25;

/** Whether a window at `top` is as large as a document's, beside the lesson's window at `lesson`
 *  (no frame said: taken to be). */
export function documentSized(top: Frame | null | undefined, lesson: Frame): boolean {
  if (!top) return true;
  if (top.w < SWITCH_MIN_W || top.h < SWITCH_MIN_H) return false;
  return top.w * top.h >= SWITCH_MIN_SHARE * Math.max(0, lesson.w) * Math.max(0, lesson.h);
}

/** A sheet hangs from its window: inside its frame and smaller than it each way, centred on it
 *  (SHEET_CENTRE points at most off), its top edge under the window's title bar and toolbar
 *  (SHEET_TOP points at most below the window's top). A document's own window opened over the
 *  lesson's is put at the corner, or where the student left it, not so; a native tab in front of
 *  it has its very frame. */
export const SHEET_CENTRE = 2;
export const SHEET_TOP = 100;

/** Whether a window at `top` hangs from the lesson's window at `lesson` as a sheet does (Print,
 *  Save, a document's settings: sheetOf above), whatever it is called. */
export function sheetOf(top: Frame | null | undefined, lesson: Frame): boolean {
  if (!top) return false;
  const inside =
    top.x >= lesson.x - 1 && top.y >= lesson.y - 1 && top.x + top.w <= lesson.x + lesson.w + 1 && top.y + top.h <= lesson.y + lesson.h + 1;
  const smaller = top.w < lesson.w - 2 && top.h < lesson.h - 2;
  return inside && smaller && Math.abs(top.x + top.w / 2 - (lesson.x + lesson.w / 2)) <= SHEET_CENTRE && top.y - lesson.y <= SHEET_TOP;
}

/** What identVerdict needs of a lesson: its window and app; its title and frame as of its latest
 *  read; `titles`, the others its document has shown (above); `top`, the last of its app's windows
 *  the helper said in front that was the lesson's own or another document's (anotherWindow: a
 *  popup or a sheet in between moves nothing; undefined: none said yet in this run, so the one
 *  said now is the baseline); and the switch going on, if any (`waiting`: left waiting with
 *  nothing to read yet, the other window's title then). */
export interface IdentLesson {
  window: number;
  app: string;
  title: string;
  titles?: ReadonlyArray<string>;
  frame: Frame;
  top?: number;
  switching: { why: SwitchWhy; target: number; waiting?: string } | null;
}

export type IdentVerdict =
  | { act: "switch"; why: "title" | "window"; target: number }
  | { act: "check" }
  | { act: "reread" }
  | { act: "retarget"; why: "title" | "window"; target: number }
  | { act: "cancel" }
  | null;

/** Whether the window the ident says in front of the lesson's app (`top`) is another document's:
 *  not the lesson's, with a title of its own, as large as a document's, and no sheet of the
 *  lesson's window. A popup or a sheet over the lesson's window leaves the student on that window. */
export function anotherWindow(lesson: Pick<IdentLesson, "window" | "app" | "frame">, i: IdentLook): boolean {
  return (
    i.top !== null &&
    i.top !== lesson.window &&
    titleSignature(i.topTitle, lesson.app) !== "" &&
    documentSized(i.topFrame, lesson.frame) &&
    !sheetOf(i.topFrame, lesson.frame)
  );
}

/** What an ident of the lesson's window comes to (above). */
export function identVerdict(lesson: IdentLesson, i: IdentLook): IdentVerdict {
  if (i.window !== lesson.window) return null;
  const front = i.top !== null;
  // (another document's window of its app in front of the lesson's, whether it was already or has
  // just come)
  const another = anotherWindow(lesson, i);
  const change = titleChange(lesson.title, i.title, lesson.app);
  const known = (lesson.titles ?? []).some((title) => titleChange(title, i.title, lesson.app) === "none");
  const own = change === "none" || known;
  const s = lesson.switching;
  if (s) {
    if ((s.why === "title" || s.why === "tap") && own && !another) return { act: "cancel" };
    if (s.why === "window" && i.top === lesson.window && i.onScreen && own) return { act: "cancel" };
    if (s.waiting !== undefined && front && s.why !== "app") {
      // (the student on to another document of the lesson's app while it waits: a third window, or
      // the lesson's own showing another tab, read there instead; only one switch is ever on)
      if (another && i.top !== null && i.top !== s.target) return { act: "retarget", why: "window", target: i.top };
      if (s.target !== lesson.window && i.top === lesson.window && i.onScreen && (change === "letters" || change === "digits")) {
        return { act: "retarget", why: "title", target: lesson.window };
      }
    }
    if (s.waiting !== undefined && front) {
      // (the other window's title now: the lesson's own window's for a tab, the front one's for
      // another window; another app's is not said here)
      const now = s.why === "window" ? (i.top === s.target ? i.topTitle : null) : s.why !== "app" && i.onScreen ? i.title : null;
      const moved = now === null ? "none" : titleChange(s.waiting, now, lesson.app);
      if (moved === "letters" || moved === "digits") return { act: "reread" };
    }
    return null;
  }
  if (another && i.top !== null && lesson.top !== undefined && i.top !== lesson.top) return { act: "switch", why: "window", target: i.top };
  if (!front || !i.onScreen || known) return null;
  if (change === "letters") return { act: "switch", why: "title", target: lesson.window };
  if (change === "digits") return { act: "check" };
  return null;
}

/** A look is told the same by this many of its rows found again at least (and SAME_LOOK_SHARE of
 *  them): one alone (a browser's bookmarks row caught in the band of a short window, over a page
 *  with no other row of its own yet) cannot tell it. */
export const SAME_LOOK_FOUND = 2;

/** Whether `after` shows the same document as the lesson's looks `before` (its latest accurate
 *  read, and its latest look, a quick read after a scroll included): SAME_LOOK_SHARE of its rows
 *  found in one of those, SAME_LOOK_FOUND rows at least. `share` (the best of them) and `rows` are
 *  for the log. */
export function sameDocument(before: ReadonlyArray<Look>, after: Look): { same: boolean; share: number; rows: number } {
  const rows = bodyRows(after).length;
  const share = before.reduce((best, look) => Math.max(best, sameLook(look, after)), 0);
  // (share * rows: the rows found, of the best of them)
  return { same: Math.round(share * rows) >= SAME_LOOK_FOUND && share >= SAME_LOOK_SHARE, share, rows };
}
