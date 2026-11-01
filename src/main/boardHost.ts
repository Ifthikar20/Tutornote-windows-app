/*
  Where the board of a lesson over another app lives (screenTeach.ts): in a tab of Tutornote's own
  window, or in a window of its own beside the words read. The rules, and what the tab bar and
  screen-board.json may hold about it. Nothing here touches Electron, so it is tested on its own
  (scripts/tests/boardHost.test.ts).

  The board is one page (the guest the lesson's page opened) that moves between two homes: the
  floating window, and a tab of the main window. It goes into the tab when Tutornote's window is
  there to hold it and lies clear of what is read; else it floats beside the words. A student who
  chose Pop out keeps it floating until they choose Open in Tutornote.

  And where the lesson's own see-through window goes, over the display of what is read
  (overlayArea), and when it must go elsewhere (displayChanged).

  Every rectangle is in screen points, Electron's own space, as in boardPlace.ts.
*/

import type { Box, Rect } from "./boardPlace";

/* The web app's half of the board's place (src/lib/guide/boardWindow.ts there), word for word,
   with `bounds` (boardPlaceMsg) added on this side first: a page that takes a place only with the
   keys it knows drops one that carries it, so the web's half must take it too. */
export type BoardWhere = "tab" | "float";
export interface BoardPlace { where: BoardWhere; canMove: boolean; covering: boolean; app?: string; bounds?: Rect }
export interface BoardStateMsg { run: number; show: boolean; full: boolean; background?: string; drawn?: number }

/** The Board tab's id in the tab bar: page ids start at 1 (windows.ts). */
export const BOARD_TAB_ID = -1;
/** The share of the words' box Tutornote's window may lie over and still hold the board. */
export const WORDS_COVER_MAX = 0.1;
/** What the student chose: "window" after Pop out, "tab" after Open in Tutornote. */
export type BoardPref = "tab" | "window";
/** What screen-board.json keeps besides the floating window's place: the choice, and the text size. */
export interface BoardPrefs { place: BoardPref; zoom: number }
/** The board's text size (View > Zoom In, Zoom Out), in Chromium's zoom levels. */
export const BOARD_ZOOM = { min: -3, max: 3, step: 0.5 } as const;

/** What screenTeach needs to know about Tutornote's window (windows.ts mainWindowLook). */
export interface MainLook {
  open: boolean;
  shown: boolean;
  minimized: boolean;
  closing: boolean;
  signIn: boolean;
  fullScreen: boolean;
  focused: boolean;
  bounds: Box | null;
  displayId: number | null;
}

/** What was read: the words' box (or null), the read window, its display, and whether it is in native full screen. */
export interface Reading {
  words: Rect | null;
  frame: Rect;
  displayId: number;
  full: boolean;
}

/** How much of `b` lies on `a`, in square points. */
function overlap(a: Box, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Tutornote's window can take the board: open, on screen, and not signing in. */
export const mainCanHold = (m: MainLook): boolean => m.open && m.shown && !m.minimized && !m.closing && !m.signIn && !!m.bounds;

/** How far below its display's top macOS keeps a window in native full screen on a Mac with a
 *  camera notch, in points: under the camera housing, the strip above it left black (the founder's
 *  Kindle in full screen: at (0, 36), 1512 x 946 on a 1512 x 982 display, helpers/screen/main.swift's
 *  selftest). Wide enough for the notch at the display's scaled sizes; a menu bar with no notch is
 *  24 or 25 points, so a window zoomed under one never counts. */
export const NOTCH_BAND = { min: 28, max: 50 } as const;

/** A window frame that fills its display's bounds (within 2 points each way), or all of it below
 *  a camera notch (NOTCH_BAND): native full screen. */
export function fullScreenFrame(frame: Rect, display: Box): boolean {
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2;
  const top = frame.y - display.y;
  return (
    near(frame.x, display.x) &&
    (near(top, 0) || (top >= NOTCH_BAND.min && top <= NOTCH_BAND.max)) &&
    near(frame.x + frame.w, display.x + display.width) &&
    near(frame.y + frame.h, display.y + display.height)
  );
}

/*
  The lesson's own see-through window (screenTeach.ts ensureWindow) over the display that holds
  most of the window read, chosen as each run starts. Over its work area, under the menu bar and
  clear of the Dock, which macOS draws above it (the lesson's dock and chip never sit under them);
  but over all of it when the window read is in native full screen (fullScreenFrame, below the
  camera notch on a Mac with one): its page reaches both edges there, the menu bar and the Dock
  hidden, and a work area would leave a strip
  at its top and at its foot where nothing of the lesson could be drawn (a PDF or a Kindle book
  read in full screen).
  Every point the lesson's page holds is in that window's own points, so a window read that has
  gone over another display, or into full screen or out of it, or whose display changed its bounds
  (its resolution, or the displays rearranged), needs the run started afresh there (screenTeach.ts
  rehome): displayChanged. Told by the display, its bounds and full screen, never by the work
  area's size, which the Dock and the menu bar change.
*/

/** A display, as Electron gives it: its id, all of it, and the part the menu bar and the Dock leave. */
export interface DisplayArea {
  id: number;
  bounds: Box;
  workArea: Box;
}

/** Where a run put the lesson's window: over which display, and over all of it (`full`). */
export interface OverlayHome {
  displayId: number;
  full: boolean;
  /** The display's bounds as its run began: a resolution changed, or the displays rearranged,
   *  changes them, and the lesson's window covers the wrong part of the screen then. */
  bounds: Box;
}

/** The home of the lesson's window over a window read at `frame`, on `display` (above). */
export const overlayHome = (display: Pick<DisplayArea, "id" | "bounds">, frame: Rect): OverlayHome => ({
  displayId: display.id,
  full: fullScreenFrame(frame, display.bounds),
  bounds: { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height },
});

/** What the lesson's window covers over a window read at `frame`, on `display` (above): all of the
 *  display for a window in native full screen, else its work area. */
export function overlayArea(display: Pick<DisplayArea, "bounds" | "workArea">, frame: Rect): Box {
  const area = fullScreenFrame(frame, display.bounds) ? display.bounds : display.workArea;
  return { x: area.x, y: area.y, width: area.width, height: area.height };
}

/** Whether the window read, now at `frame` on `display` (the one that holds most of it), wants the
 *  lesson's window elsewhere than `home`, where its run put it: over another display, its window
 *  gone into native full screen or out of it, or its display's bounds changed. */
export function displayChanged(home: OverlayHome, display: Pick<DisplayArea, "id" | "bounds">, frame: Rect): boolean {
  const now = overlayHome(display, frame);
  const a = home.bounds;
  const b = now.bounds;
  return now.displayId !== home.displayId || now.full !== home.full || a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
}

/**
 * Tutornote's window hides what is read: it is on the same display and is in native full screen,
 * or the read window is, or it lies over more than WORDS_COVER_MAX of the words' box (the whole
 * read window when no words were read). On another display it never does.
 */
export function coversReading(m: MainLook, r: Reading): boolean {
  if (!m.bounds || m.displayId !== r.displayId) return false;
  if (m.fullScreen || r.full) return true;
  const words = r.words ?? r.frame;
  return overlap(m.bounds, words) > WORDS_COVER_MAX * words.w * words.h;
}

/** Where a lesson run's board goes, decided at its first drawing, and why (for the log). */
export function boardPlaceFor(a: { pref: BoardPref; pageKnowsPlace: boolean; main: MainLook; reading: Reading }): {
  where: BoardWhere;
  why: string;
} {
  if (a.pref === "window") return { where: "float", why: "the student chose its own window" };
  if (!a.pageKnowsPlace) return { where: "float", why: "an older page" };
  if (!mainCanHold(a.main)) return { where: "float", why: "Tutornote's window is closed, hidden, minimized or signing in" };
  if (coversReading(a.main, a.reading)) return { where: "float", why: "Tutornote's window covers what is read" };
  return { where: "tab", why: "Tutornote's window is beside what is read" };
}

/**
 * The student left Tutornote's window (another app took the keys) with the board in its tab: it
 * moves to its own window when the tab can no longer be seen there. Not while another window of
 * Tutornote's has the keys (the lesson's own), nor once the main window has them back.
 */
export function leavesTab(a: { main: MainLook; reading: Reading; otherOwnFocused: boolean }): boolean {
  if (a.otherOwnFocused || a.main.focused) return false;
  if (!mainCanHold(a.main)) return true;
  return coversReading(a.main, a.reading);
}

/*
  What the page hears of its board (screen-teach:board-place). Where it is, whether it can be moved,
  whether Tutornote's window is covering what is read, the app's name for "Back to", and, while the
  board shows in a window of its own over the lesson window (the see-through one the page is in, on
  the display of what is read), that window's frame in the lesson window's own points (`bounds`),
  for the page to keep what it writes on the page being read (a margin note, an answer) clear of
  it, as it keeps its writing clear of a board drawn inside its own window (the founder,
  2026-10-28: the tutor over another app should "highlight things, create short notes"). None in
  its tab, hidden, or on another display.
*/

/** The board's place for the page. `floating`: its own window's bounds while it shows there, else
 *  null; `lesson`: the lesson window's bounds (the page's see-through window, not the window read), or
 *  null with none. */
export function boardPlaceMsg(a: {
  where: BoardWhere;
  canMove: boolean;
  covering: boolean;
  app: string;
  floating: Box | null;
  lesson: Box | null;
}): BoardPlace {
  const f = a.where === "float" ? a.floating : null;
  const l = a.lesson;
  const over = f && l && f.width > 0 && f.height > 0 && overlap(l, { x: f.x, y: f.y, w: f.width, h: f.height }) > 0;
  return {
    where: a.where,
    canMove: a.canMove,
    covering: a.covering,
    ...(a.app ? { app: a.app } : {}),
    ...(over ? { bounds: { x: f.x - l.x, y: f.y - l.y, w: f.width, h: f.height } } : {}),
  };
}

/** The tabs in the bar's order: Home, the Board, then the notes. */
export function tabOrder(homeId: number | null, board: boolean, noteIds: readonly number[]): number[] {
  return [...(homeId === null ? [] : [homeId]), ...(board ? [BOARD_TAB_ID] : []), ...noteIds];
}

/** The tab `step` places on from `active`, wrapping around; null with fewer than two tabs. An active
 *  tab not in the order steps from outside it: forward to the first, back to the last. */
export function adjacentTab(order: readonly number[], active: number, step: number): number | null {
  if (order.length < 2) return null;
  const i = order.indexOf(active);
  if (i < 0) return step > 0 ? order[0] : order[order.length - 1];
  const n = order.length;
  return order[(((i + step) % n) + n) % n];
}

/** The bar's inset on the Board tab: the bar spans the window there, and every tab stays where it
 *  was on the page shown before (whose bar started at `pageBarX`). */
export const boardBarInset = (pageBarX: number, lights: number): number => Math.max(lights, pageBarX + 8);

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A board text size kept within BOARD_ZOOM, in its steps. */
export function clampBoardZoom(level: number): number {
  if (!finite(level)) return 0;
  const clamped = Math.max(BOARD_ZOOM.min, Math.min(BOARD_ZOOM.max, level));
  return Math.round(clamped / BOARD_ZOOM.step) * BOARD_ZOOM.step;
}

const boardPrefOf = (v: unknown): BoardPref | null => (v === "tab" || v === "window" ? v : null);

/** The student's choices from screen-board.json, or the defaults (the tab, actual size). */
export function boardPrefsOf(raw: unknown): BoardPrefs {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return { place: boardPrefOf(r.place) ?? "tab", zoom: finite(r.zoom) ? clampBoardZoom(r.zoom) : 0 };
}

/** screen-board.json with `patch` applied: the floating window's place and size, the choice and the
 *  text size, each kept only when it is valid; nothing else. */
export function boardFileWith(raw: unknown, patch: { bounds?: Box; place?: BoardPref; zoom?: number }): Record<string, unknown> {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["x", "y", "width", "height"] as const) if (finite(r[key])) out[key] = r[key];
  const place = boardPrefOf(r.place);
  if (place) out.place = place;
  if (finite(r.zoom)) out.zoom = clampBoardZoom(r.zoom);
  if (patch.bounds) {
    out.x = patch.bounds.x;
    out.y = patch.bounds.y;
    out.width = patch.bounds.width;
    out.height = patch.bounds.height;
  }
  if (patch.place && boardPrefOf(patch.place)) out.place = patch.place;
  if (patch.zoom !== undefined && finite(patch.zoom)) out.zoom = clampBoardZoom(patch.zoom);
  return out;
}

/** The page's move of the board (screen-teach:board-move), or null. */
export const boardMoveOf = (v: unknown): BoardWhere | null => (v === "tab" || v === "float" ? v : null);

/** The menus' words for the board (the Window menu, the board's right-click menu). */
export const BOARD_COPY = {
  popOut: "Pop Out Board",
  showIn: "Show Board in Tutornote",
  close: "Close Board",
  copyPicture: "Copy Board as Picture",
  lookUp: (w: string) => `Look Up “${w}”`,
} as const;
