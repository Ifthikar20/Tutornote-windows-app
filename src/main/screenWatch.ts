/*
  What the helper says unasked of the student's wheel and keys on the window being read (screen.ts
  watchEvents "scroll" and "keyed"), checked field by field, and the "observe" command the app sends
  it (helpers/screen/main.swift "Watching for a new look").

  The founder, 2026-10-28: the tutor over another app should be "very accurate in the way it points
  at things" and "super responsive". So a scroll carries its sideways part too (`dx`: a pan across a
  zoomed page) and a mouse wheel's own lines (`lines`, each taken as 40 points in `dy` until the read
  after the scroll says better, so the page can learn the app's own step); a key pressed in the
  lesson's app is said at once ("keyed": the window alone, never which key); and the observed
  windows that turn by the page (Kindle, Books, an app a key turned) are named to the helper
  ("page"), which then says a page a wheel or a swipe turned there as it says one a key turned.

  Numbers in, numbers out: no Electron and no other module at run time, so it is tested on its own
  (scripts/tests/screenWatch.test.ts). Nothing here is logged.
*/

import type { ScreenKeyed, ScreenScroll } from "./screen";

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The helper's "scroll" event as a ScreenScroll, or null without a finite `dy` and a window.
 *  `dx` and `lines` are 0 where a helper older than them leaves them out. */
export function scrollOf(msg: Record<string, unknown>): ScreenScroll | null {
  if (!finiteNumber(msg.dy) || typeof msg.window !== "number") return null;
  return {
    dy: msg.dy,
    dx: finiteNumber(msg.dx) ? msg.dx : 0,
    lines: finiteNumber(msg.lines) ? msg.lines : 0,
    momentum: msg.momentum === true,
    window: msg.window,
  };
}

/** The helper's "keyed" event as a ScreenKeyed, or null without a window. */
export function keyedOf(msg: Record<string, unknown>): ScreenKeyed | null {
  return typeof msg.window === "number" ? { window: msg.window } : null;
}

/** The "observe" command for `windows` (the helper watches two at most: the first two), with
 *  those of them in `paged` as its "page" list, left out when there are none (a helper older
 *  than it reads only the windows). */
export function observeCommandOf(windows: readonly number[], paged: readonly number[]): Record<string, unknown> {
  const watched = windows.slice(0, 2);
  const page = [...new Set(paged)].filter((id) => watched.includes(id));
  return { cmd: "observe", windows: watched, ...(page.length ? { page } : {}) };
}
