/*
  The desktop companion's rules that need no Electron (companion.ts): where its blob sits on a
  display, where the blob's label goes, when the blob shows at all, what dropping it comes to,
  which apps it never reads,
  which apps keep a plain click for themselves, what a tap on another app's window comes to,
  whether it was on the words, whose a double click's selection is, how a tap's verdict reads in
  the log, which windows and boxes the page may read and picture for a circle, and which windows
  it may start a lesson over. Numbers and strings in, numbers and strings out, so it is tested on
  its own (scripts/tests/companionPlace.test.ts).

  Every point and box is in screen points, Electron's own space, as boardPlace.ts's are.
*/

/** A box as Electron places windows: a display's work area, a window's bounds. */
export type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

/** The blob's size, in points: a 64 point circle with the tutor curled inside. */
export const BLOB_SIZE = 64;
/** From the work area's right and bottom edges, where the blob first pops up. */
const BLOB_EDGE = 24;
/** The label beside the blob ("Click to turn me on"): its room, and the gap to the blob. */
export const LABEL_WIDTH = 228;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/** Where the blob first pops up on a display: its bottom right corner, clear of the edges. */
export function defaultBlobPlace(work: Box): Point {
  return {
    x: Math.round(work.x + work.width - BLOB_SIZE - BLOB_EDGE),
    y: Math.round(work.y + work.height - BLOB_SIZE - BLOB_EDGE),
  };
}

/** A place for the blob (its top left), brought whole on to the work area: never under the menu
 *  bar or the Dock, never half off the screen. */
export function clampBlobPlace(p: Point, work: Box): Point {
  return {
    x: Math.round(clamp(p.x, work.x, work.x + work.width - BLOB_SIZE)),
    y: Math.round(clamp(p.y, work.y, work.y + work.height - BLOB_SIZE)),
  };
}

/** The places the student left the blob at, by display id, as kept in companion-blob.json: only
 *  the entries that are points. */
export function blobPlacesOf(value: unknown): Record<string, Point> {
  const raw = (typeof value === "object" && value !== null ? (value as { places?: unknown }).places : null) ?? {};
  const places: Record<string, Point> = {};
  if (typeof raw !== "object" || raw === null) return places;
  for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
    const point = (p ?? {}) as Record<string, unknown>;
    if (/^-?\d+$/.test(id) && finite(point.x) && finite(point.y)) places[id] = { x: point.x, y: point.y };
  }
  return places;
}

/** Where the blob goes on the display `displayId`: where the student last left it there, brought
 *  into its work area, else its bottom right corner. */
export function blobPlaceFor(places: Record<string, Point>, displayId: number, work: Box): Point {
  const kept = places[String(displayId)];
  return kept ? clampBlobPlace(kept, work) : defaultBlobPlace(work);
}

/** The blob's window with its label beside it: on the side with more room, the blob staying
 *  where it is. `side` is where the label is. */
export function labelBounds(blob: Point, work: Box): { bounds: Box; side: "left" | "right" } {
  const roomLeft = blob.x - work.x;
  const roomRight = work.x + work.width - (blob.x + BLOB_SIZE);
  const side = roomLeft >= LABEL_WIDTH || roomLeft >= roomRight ? "left" : "right";
  const x = side === "left" ? blob.x - LABEL_WIDTH : blob.x;
  return { bounds: { x: Math.round(x), y: Math.round(blob.y), width: BLOB_SIZE + LABEL_WIDTH, height: BLOB_SIZE }, side };
}

/** Moved less than this (points) between press and release: a click on the blob, not a drag. */
export const CLICK_TRAVEL = 4;

/** Whether the blob's window is up: shown (the tab bar's button, ⌃⌥E), but not while the tutor is
 *  on with a lesson page that has a dock of its own (its pause and × are the controls then). A
 *  page too old to say so keeps the blob up while on, its ring the only way to turn it off.
 *  `attention`: the blob has something to say while on (the screen helper keeps stopping, and is
 *  being started again): it is up whatever the page's dock, showing so. */
export function blobUp(s: { shown: boolean; on: boolean; pageDock: boolean; attention?: boolean }): boolean {
  return s.shown && (!(s.on && s.pageDock) || s.attention === true);
}

/*
  Dropping the blob (companion.ts endDrag): a press and release that hardly moved it is a click (it
  turns the tutor on or off); a short drag only moves it. A drag let go of at the edge of the screen
  parks it there, as before (where the student keeps it). Let go of anywhere else, over another
  app's window, the tutor reads that window and explains from the point it was dropped at, and the
  blob flies back home ("read"): whether that window may be read is companion.ts's to say then.
*/

/** A drag shorter than this (points) only moves the blob, wherever it is let go of. */
export const DROP_TRAVEL = 24;
/** Let go of this near (points, its centre) a work area's edge, the blob is parked there. */
export const PARK_EDGE = BLOB_SIZE + BLOB_EDGE;

export type BlobDrop = "click" | "place" | "read";

/** What the end of a drag of the blob comes to: `travel`, the furthest it went from where it was
 *  taken (points); `asClick`, the blob's page heard its button come up (not a drag given up);
 *  `at`, where it was let go of (the cursor), on the display whose work area is `work`. */
export function blobDrop(d: { travel: number; asClick: boolean; at: Point; work: Box }): BlobDrop {
  if (d.asClick && d.travel < CLICK_TRAVEL) return "click";
  if (!d.asClick || !(d.travel >= DROP_TRAVEL)) return "place";
  const w = d.work;
  const inside = d.at.x >= w.x && d.at.y >= w.y && d.at.x < w.x + w.width && d.at.y < w.y + w.height;
  if (!inside) return "place";
  const edge = Math.min(d.at.x - w.x, d.at.y - w.y, w.x + w.width - d.at.x, w.y + w.height - d.at.y);
  return edge < PARK_EDGE ? "place" : "read";
}

/** The CGWindowID in a BrowserWindow's getMediaSourceId() ("window:<id>:<other>"), or null. */
export function windowIdOf(mediaSourceId: string): number | null {
  const m = /^window:(\d+):/.exec(mediaSourceId);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/*
  Never read: password managers, Keychain Access, and System Settings. The tutor says so once
  for the window and reads nothing there, not even to draw the hover band.
*/
export const PRIVATE_APPS: ReadonlySet<string> = new Set([
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
  "com.apple.keychainaccess",
  "com.apple.Passwords",
  "com.apple.systempreferences",
]);

/*
  Apps where a plain click belongs to the app (it puts the caret somewhere, selects a cell, a file,
  a block): the companion offers its help there only for an Option click. Notes and writing apps,
  office apps, Finder, code editors and terminals; every JetBrains IDE by its bundle's prefix
  (EDITOR_PREFIXES). The web app's hover.ts keeps the same list (EDITOR_BUNDLES).
*/
export const EDITOR_APPS: ReadonlySet<string> = new Set([
  "com.apple.Notes",
  "com.apple.TextEdit",
  "com.apple.iWork.Pages",
  "com.microsoft.Word",
  "com.microsoft.VSCode",
  "com.apple.dt.Xcode",
  "com.apple.Terminal",
  "com.googlecode.iterm2",
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
  // Cursor
  "com.todesktop.230313mzl4w4u92",
]);
/** Bundle id prefixes that are editors whatever follows (PyCharm, IntelliJ IDEA, WebStorm...). */
export const EDITOR_PREFIXES: readonly string[] = ["com.jetbrains."];

/*
  The editors of passages, where a double tap on a sentence is the student pointing at it and its
  card asks whether to explain it (pointedInto; the founder, 2026-11-17: "when we double tap on any
  passage or sentence we should see the menu asking if want me to explain this"). A plain click
  there stays the editor's. Not Finder, terminals, spreadsheets, slides or code editors, where a
  double click opens a file, edits a cell or a shape, or picks a word to change.
*/
export const WRITING_APPS: ReadonlySet<string> = new Set([
  "com.apple.Notes",
  "com.apple.TextEdit",
  "com.apple.iWork.Pages",
  "com.microsoft.Word",
  "notion.id",
  "md.obsidian",
]);

/*
  Readers: Kindle (both its bundle ids), Books and Preview. A plain click on their page can show or
  hide their own bars, so the helper judges a tap there against a look it has vetted first
  (main.swift judgeTap, "readers" with "companion").
*/
export const READER_APPS: ReadonlySet<string> = new Set(["com.amazon.Lassen", "com.amazon.Kindle", "com.apple.iBooksX", "com.apple.Preview"]);

/*
  Browsers, where a double tap is the student's and its card asks whether to explain (selectionKept,
  doubleTapPoints), and a caret in a PDF too (caretKept): Chrome and Edge in any of their channels (by
  their bundle's prefix, BROWSER_PREFIXES), Safari, Firefox, Arc, Brave, Opera, Vivaldi, Orion.
*/
export const BROWSER_APPS: ReadonlySet<string> = new Set([
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
export const BROWSER_PREFIXES: readonly string[] = ["com.google.Chrome", "com.microsoft.edgemac"];

export const isPrivateApp = (bundle: string | undefined): boolean => Boolean(bundle && PRIVATE_APPS.has(bundle));
export const isEditorApp = (bundle: string | undefined): boolean =>
  Boolean(bundle && (EDITOR_APPS.has(bundle) || EDITOR_PREFIXES.some((prefix) => bundle.startsWith(prefix))));
export const isReaderApp = (bundle: string | undefined): boolean => Boolean(bundle && READER_APPS.has(bundle));
export const isBrowserApp = (bundle: string | undefined): boolean =>
  Boolean(bundle && (BROWSER_APPS.has(bundle) || BROWSER_PREFIXES.some((prefix) => bundle.startsWith(prefix))));

/** Whether a window of words is the student's to point into with a double tap: a browser's, a
 *  reader's (a PDF viewer's too: READER_APPS) or a writing app's (WRITING_APPS, since 2026-11-17;
 *  selectionKept, doubleTapPoints). A single click in a writing app stays the editor's (tapRoute). */
const pointedInto = (bundle: string | undefined): boolean =>
  isBrowserApp(bundle) || isReaderApp(bundle) || Boolean(bundle && WRITING_APPS.has(bundle));

/** A browser's window showing a PDF, as its title says (ending in ".pdf"). Edge shows a PDF's own
 *  title when it has one, so such a PDF is not told by this, and is a web page here. */
const browserPdf = (bundle: string | undefined, title: string | undefined): boolean =>
  isBrowserApp(bundle) && /\.pdf$/i.test((title ?? "").trim());

/**
 * Whether a tap whose only doing was selecting words (`words` "select": a double click, or the
 * single tap a double click followed, whose verdict says so too) was the student's, not its app's:
 * in a browser, a reader (READER_APPS: Kindle, Books, Preview; a browser's PDF too) or a writing app,
 * where a student double clicks a word to point at it (9 of the founder's 20 recorded taps were
 * second or third clicks; 2026-11-15: "whenever you tap on some PDF or web page, it should
 * understand it"; 2026-11-17, writing apps too: WRITING_APPS), and the card stays. Not under a pointing
 * hand (`hand`, as the release said: a link, a button, a video, which the double click opened),
 * and nowhere else: in any other app (mail, chat, music, a file dialog) a double click opens
 * something, as before. `title` is no longer needed, and kept for the callers that still say it.
 */
export function selectionKept(t: { words?: string; bundle?: string; title?: string; hand?: boolean }): boolean {
  return t.words === "select" && t.hand !== true && pointedInto(t.bundle);
}

/** Whether a click whose verdict says only that it put a caret (`words` "caret") was the student's:
 *  in a reader, or in a browser's PDF (its title ends in ".pdf"), where a click on a page's words
 *  shows a caret in its text layer and does nothing else. On a web page a caret is a field's or a
 *  web editor's (a Google Doc, a mail being written, a search box), as anywhere else: the app's. */
export function caretKept(t: { words?: string; bundle?: string; title?: string }): boolean {
  return t.words === "caret" && (isReaderApp(t.bundle) || browserPdf(t.bundle, t.title)) && !isEditorApp(t.bundle);
}

/** Whether a tap's verdict says its app used the click (`acted`), the selection and caret rules
 *  above taken into account: a selection or a caret the student made to point is not the app's. */
export function tapActed(t: { acted: boolean; words?: string; bundle?: string; title?: string; hand?: boolean }): boolean {
  return t.acted && !selectionKept(t) && !caretKept(t);
}

/** Whether a tap is a double tap pointing at words (`clicks` two or more, as its release said:
 *  never the first click's verdict, which a Mac helper also says "select" once the second has
 *  come) in a browser, a reader, a PDF viewer or a writing app (pointedInto), not under a pointing
 *  hand: its card comes up asking whether to explain (the founder, 2026-11-17: "when we double tap
 *  on any passage or sentence we should see the menu asking if want me to explain this"). Until
 *  then a double tap in a browser or a reader was explained at once, with no card, and one in an
 *  editor was the editor's. Whether it was on the words read there is the caller's to say
 *  (companion.ts onTap, tapOnWords). */
export function doubleTapPoints(t: { clicks?: number; bundle?: string; hand?: boolean }): boolean {
  return (t.clicks ?? 1) >= 2 && t.hand !== true && pointedInto(t.bundle);
}

/**
 * What a tap on another app's window comes to, with the companion on. "lesson": it is on the
 * lesson's own window, which the lesson hears itself (screenTeach.ts onTap). "page": the click was
 * on the lesson page's own controls (the card, the dock), which took it. "private": a window it
 * never reads. "acted": a plain click did something in its app (a link, a button, a page turn);
 * an Option click is always the tutor's. "editor": a plain click in an editor, which is the
 * editor's; a double tap there pointing at words (`pointing`: doubleTapPoints) is the card's.
 * "card": the student may want help here, so the card is offered (and the window read carefully
 * meanwhile).
 */
export type TapRoute = "lesson" | "page" | "private" | "acted" | "editor" | "card";

export function tapRoute(t: {
  onLesson: boolean;
  onPage: boolean;
  private: boolean;
  acted: boolean;
  editor: boolean;
  alt: boolean;
  pointing?: boolean;
}): TapRoute {
  if (t.onLesson) return "lesson";
  if (t.onPage) return "page";
  if (t.private) return "private";
  if (t.acted && !t.alt) return "acted";
  if (t.editor && !t.alt && !t.pointing) return "editor";
  return "card";
}

/** A tap further than this (points) from every line read is on no words. */
export const TAP_NEAR = 24;

/** Whether a tap at `at` is on the words of a window read as `lines` (all in screen points): within
 *  TAP_NEAR of a line. A reader's page turned by its side arrows or margin is not. */
export function tapOnWords(lines: ReadonlyArray<{ x: number; y: number; w: number; h: number }>, at: Point): boolean {
  return lines.some(
    (l) => Math.max(l.x - at.x, 0, at.x - (l.x + l.w)) <= TAP_NEAR && Math.max(l.y - at.y, 0, at.y - (l.y + l.h)) <= TAP_NEAR,
  );
}

/** What the helper's words said of a tap (main.swift companionTap): "kept" (the tapped words are
 *  still there, or on a margin the rows nearest it, so the tap was the tutor's whatever else
 *  redrew), "gone", "none" (no words at the tap or near it: the pixels decide), "covered"
 *  (another window is over it now), "title" (the window's title
 *  changed), "content" (the tapped label stayed, the content away from it changed), "caret" (the
 *  click put a caret there), "select" (a double click), "skipped" (the pixels saw nothing, so no
 *  words were read), "pixels" (the words could not be read in time: the pixels decide). */
export type TapWords = "kept" | "gone" | "none" | "covered" | "title" | "content" | "caret" | "select" | "skipped" | "pixels";

export const TAP_WORDS: ReadonlySet<string> = new Set<TapWords>([
  "kept",
  "gone",
  "none",
  "covered",
  "title",
  "content",
  "caret",
  "select",
  "skipped",
  "pixels",
]);

/** The numbers the helper judged a tap by (screen.ts ScreenTap), for the log, the words first:
 *  " (words kept 0.83, shift -23 pt, text 21 ms, line 7.2, away 6.9, wide, look 0.4 s)", or "" from
 *  a helper that sends none. */
export function tapNumbers(t: {
  words?: string;
  kept?: number;
  shift?: number;
  textMs?: number;
  line?: number;
  away?: number;
  wide?: boolean;
  look?: number;
}): string {
  const parts: string[] = [];
  if (t.words !== undefined) parts.push(`words ${t.words}${t.kept !== undefined ? ` ${t.kept.toFixed(2)}` : ""}`);
  else if (t.kept !== undefined) parts.push(`kept ${t.kept.toFixed(2)}`);
  if (t.shift !== undefined) parts.push(`shift ${Math.round(t.shift)} pt`);
  if (t.textMs !== undefined) parts.push(`text ${Math.round(t.textMs)} ms`);
  if (t.line !== undefined) parts.push(`line ${t.line.toFixed(1)}`);
  if (t.away !== undefined) parts.push(`away ${t.away.toFixed(1)}`);
  if (t.wide) parts.push("wide");
  if (t.look !== undefined && t.look >= 0) parts.push(`look ${t.look.toFixed(1)} s`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** What the student picked on the card: explain from there, or ask a question. */
export type ScreenChoice = "explain" | "ask";

/** A pick from the page, or null. "summarize" (Sum it up, on a page older than the card's two
 *  choices) is taken as "explain". */
export const choiceOf = (value: unknown): ScreenChoice | null =>
  value === "explain" || value === "summarize" ? "explain" : value === "ask" ? "ask" : null;

/*
  Circle to explain (companion.ts onLift, circleRead, circleCrop): the page asks for a careful read
  of the window a ring was drawn round, and for a picture of the ring's box. It may ask only for
  what the student really did: a drag the helper heard end (a lift) on that window, lately, and a
  picture inside that drag's stroke. Any other window id, a box elsewhere, or a drag long gone is
  refused, so a script in the page cannot read or picture a window the student never circled.
*/

/** A rectangle as the helper's reads and crops have them, in screen points. */
export type Rect = { x: number; y: number; w: number; h: number };
/** A drag the helper heard end: its window, when (Date.now()), and its stroke's box. */
export type Lift = { window: number; at: number; box: Rect };

/** How long after a drag the page may read and picture it: the careful read (the helper's 30 s at
 *  the most) and the picture asked for after it. */
export const CIRCLE_MS = 60_000;
/** How far past the stroke's box a picture may reach, in points: the page draws the ring from the
 *  cursor it was fed when that stroke has more points than the helper's (160 at the most). */
export const CIRCLE_PAD = 32;

/** A lift as kept: its window, `at`, and the box round its stroke and the point it ended at. */
export function liftOf(lift: Point & { window: number; points: readonly Point[] }, at: number): Lift {
  let x0 = lift.x;
  let y0 = lift.y;
  let x1 = lift.x;
  let y1 = lift.y;
  for (const p of lift.points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { window: lift.window, at, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

/** Whether the page's ask is for one of the student's latest drags (`lifts`): a read names only the
 *  window, a picture its box too (screen points). The drag's window, CIRCLE_MS ago at the most (a
 *  clock gone back is no drag), and the box inside its stroke's, CIRCLE_PAD over on each side. */
export function circleAsked(lifts: readonly Lift[], ask: { window: number; box?: Rect }, now: number): boolean {
  return lifts.some((l) => {
    if (l.window !== ask.window || now < l.at || now - l.at > CIRCLE_MS) return false;
    const b = ask.box;
    const o = l.box;
    return (
      !b ||
      (b.x >= o.x - CIRCLE_PAD && b.y >= o.y - CIRCLE_PAD && b.x + b.w <= o.x + o.w + CIRCLE_PAD && b.y + b.h <= o.y + o.h + CIRCLE_PAD)
    );
  });
}

/*
  A pick (companion.ts explainAt): the page asks for a lesson over a window, from a card's choice,
  the dock's mic or a ring's words. It may ask only for a window this side saw the student at, and
  the page's own reasons for each are here: the window of the release the card opened for
  (`tapped`), the one under the cursor (`hovered`), one of the few whose glances went to the page
  last (`glanced`: the dock's mic, with the cursor on the dock, asks for the page's latest), the
  window of the lesson's latest read (`lesson`: the page keeps the lesson's quick reads too, and
  those never come this way), or one a ring was just drawn round (`lifts`). Any other id is
  refused, so a script in the page cannot have a window the student left long ago read afresh.
*/

/** What this side saw the student at, for a pick (explainAt). */
export type PickSeen = {
  tapped: number | undefined;
  hovered: number | null | undefined;
  glanced: readonly number[];
  lesson: number | null;
  lifts: readonly Lift[];
};

/** Whether the page's pick of `window` is for one the student pointed at (PickSeen). */
export function pickAsked(window: number, seen: PickSeen, now: number): boolean {
  return (
    seen.tapped === window ||
    seen.hovered === window ||
    seen.glanced.includes(window) ||
    seen.lesson === window ||
    circleAsked(seen.lifts, { window }, now)
  );
}
