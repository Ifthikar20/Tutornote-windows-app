/*
  Where the board of a lesson over another app lives (screenTeach.ts): in a tab of Tutornote's own
  window, or in a window of its own beside the words read. The rules, and what the tab bar and
  screen-board.json may hold about it. Nothing here touches Electron, so it is tested on its own
  (scripts/tests/boardHost.test.ts).

  The board is one page (the guest the lesson's page opened) that moves between two homes: the
  floating window, and a tab of the main window. It goes into the tab when Tutornote's window is
  there to hold it and lies clear of what is read; else it floats beside the words. A student who
  chose Pop out keeps it floating until they choose Open in Tutornote.

  Every rectangle is in screen points, Electron's own space, as in boardPlace.ts.
*/

import type { Box, Rect } from "./boardPlace";

/* The web app's half of the board's place (src/lib/guide/boardWindow.ts there), word for word. */
export type BoardWhere = "tab" | "float";
export interface BoardPlace { where: BoardWhere; canMove: boolean; covering: boolean; app?: string }
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

/** A window frame that fills its display's bounds (within 2 points each way): native full screen. */
export function fullScreenFrame(frame: Rect, display: Box): boolean {
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2;
  return (
    near(frame.x, display.x) &&
    near(frame.y, display.y) &&
    near(frame.x + frame.w, display.x + display.width) &&
    near(frame.y + frame.h, display.y + display.height)
  );
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
