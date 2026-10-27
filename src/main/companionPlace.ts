/*
  The desktop companion's rules that need no Electron (companion.ts): where its blob sits on a
  display, where the blob's label goes, when the blob shows at all, which apps it never reads,
  which apps keep a plain click for themselves, what a tap on another app's window comes to,
  whether it was on the words, whose a double click's selection is, and how a tap's verdict reads
  in the log. Numbers and strings in, numbers and strings out, so it is tested on its own
  (scripts/tests/companionPlace.test.ts).

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
 *  page too old to say so keeps the blob up while on, its ring the only way to turn it off. */
export function blobUp(s: { shown: boolean; on: boolean; pageDock: boolean }): boolean {
  return s.shown && !(s.on && s.pageDock);
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
  Readers: Kindle (both its bundle ids), Books and Preview. A plain click on their page can show or
  hide their own bars, so the helper judges a tap there against a look it has vetted first
  (main.swift judgeTap, "readers" with "companion").
*/
export const READER_APPS: ReadonlySet<string> = new Set(["com.amazon.Lassen", "com.amazon.Kindle", "com.apple.iBooksX", "com.apple.Preview"]);

/*
  Browsers, for a PDF open in one (selectionKept): Chrome and Edge in any of their channels (by
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

/**
 * Whether a tap whose only doing was selecting words (`words` "select": a double click, or the
 * single tap a double click followed, whose verdict says so too) was the student's, not its app's:
 * in a reader (READER_APPS: Kindle, Books, Preview) or in a browser's window showing a PDF (its
 * title, as the companion last read it, ends in ".pdf"). A student double clicks a word in a book
 * to point at it (9 of the founder's 20 recorded taps were second or third clicks), and the card
 * stays, or the lesson goes there. Anywhere else (an editor, a web page, any other app) selecting
 * is what the click did in its app, as before.
 */
export function selectionKept(t: { words?: string; bundle?: string; title?: string }): boolean {
  if (t.words !== "select") return false;
  if (isReaderApp(t.bundle)) return true;
  return isBrowserApp(t.bundle) && /\.pdf$/i.test((t.title ?? "").trim());
}

/**
 * What a tap on another app's window comes to, with the companion on. "lesson": it is on the
 * lesson's own window, which the lesson hears itself (screenTeach.ts onTap). "page": the click was
 * on the lesson page's own controls (the card, the dock), which took it. "private": a window it
 * never reads. "acted": a plain click did something in its app (a link, a button, a page turn);
 * an Option click is always the tutor's. "editor": a plain click in an editor, which is the
 * editor's. "card": the student may want help here, so the card is offered (and the window read
 * carefully meanwhile).
 */
export type TapRoute = "lesson" | "page" | "private" | "acted" | "editor" | "card";

export function tapRoute(t: {
  onLesson: boolean;
  onPage: boolean;
  private: boolean;
  acted: boolean;
  editor: boolean;
  alt: boolean;
}): TapRoute {
  if (t.onLesson) return "lesson";
  if (t.onPage) return "page";
  if (t.private) return "private";
  if (t.acted && !t.alt) return "acted";
  if (t.editor && !t.alt) return "editor";
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
