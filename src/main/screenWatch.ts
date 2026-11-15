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

  The founder, 2026-11-14: the outer pointer should be "ridiculously precise", never marking a
  different section after a scroll, and a highlight or a selection should be picked up from where
  it is. So the helper also says when a watched window has stopped moving ("settled"), a new look
  a wheel explains ("changed" with `explained`), Ctrl on a wheel as a zoom, never a scroll ("zoom"),
  on Windows the content's true move measured from its pixels while it moves ("shift"), and a drag
  that is a selection rather than a ring ("lift" with `ring` false and where it was pressed). Each
  is additive: a helper older than it never sends it, and the page falls back as before.

  Numbers in, numbers out: no Electron and no other module at run time, so it is tested on its own
  (scripts/tests/screenWatch.test.ts). Nothing here is logged.
*/

import type { ScreenChanged, ScreenKeyed, ScreenLift, ScreenScroll, ScreenSettled, ScreenShift, ScreenZoom } from "./screen";

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

/** The helper's "settled" event as a ScreenSettled, or null without a finite window. `settleMs` is
 *  0 where it is left out or not a finite number of 0 or more. */
export function settledOf(msg: Record<string, unknown>): ScreenSettled | null {
  if (!finiteNumber(msg.window)) return null;
  return { window: msg.window, settleMs: finiteNumber(msg.settleMs) && msg.settleMs >= 0 ? msg.settleMs : 0 };
}

/** The helper's "changed" event as a ScreenChanged, or null without a finite window. `settleMs` as
 *  settledOf's; `explained` only when the helper says true (a helper older than it never does). */
export function changedOf(msg: Record<string, unknown>): ScreenChanged | null {
  if (!finiteNumber(msg.window)) return null;
  return {
    window: msg.window,
    settleMs: finiteNumber(msg.settleMs) && msg.settleMs >= 0 ? msg.settleMs : 0,
    ...(msg.explained === true ? { explained: true } : {}),
  };
}

/** The helper's "zoom" event (Ctrl on a wheel) as a ScreenZoom, or null without a finite window and
 *  a finite, nonzero `notches`. */
export function zoomOf(msg: Record<string, unknown>): ScreenZoom | null {
  if (!finiteNumber(msg.window) || !finiteNumber(msg.notches) || msg.notches === 0) return null;
  return { window: msg.window, notches: msg.notches };
}

/** The helper's "shift" event (Windows: the content's move measured from its pixels) as a
 *  ScreenShift, or null without a finite window and a finite `dy`. `dx` is 0 where it is left out;
 *  `settled` only when the helper says true; `lost` only when the helper says true (its match was
 *  refused: no more shifts for this motion, and nothing measured in this one). */
export function shiftOf(msg: Record<string, unknown>): ScreenShift | null {
  if (!finiteNumber(msg.window) || !finiteNumber(msg.dy)) return null;
  return {
    window: msg.window,
    dy: msg.dy,
    dx: finiteNumber(msg.dx) ? msg.dx : 0,
    settled: msg.settled === true,
    ...(msg.lost === true ? { lost: true as const } : {}),
  };
}

/** The most stroke points a lift keeps. */
export const LIFT_POINTS = 512;

/** The helper's "lift" event as a ScreenLift, or null without a finite `x`, `y` and a window. The
 *  stroke is its [x, y] pairs of finite numbers, LIFT_POINTS at most. `ring` is false only when
 *  the helper says so (a selection drag), true from a helper older than it, which sends rings
 *  alone; `fx`, `fy` (where the drag was pressed) only both finite. */
export function liftEventOf(msg: Record<string, unknown>): ScreenLift | null {
  if (!finiteNumber(msg.x) || !finiteNumber(msg.y) || typeof msg.window !== "number") return null;
  const points = Array.isArray(msg.points)
    ? (msg.points as unknown[]).flatMap((pt) => (Array.isArray(pt) && finiteNumber(pt[0]) && finiteNumber(pt[1]) ? [{ x: pt[0], y: pt[1] }] : []))
    : [];
  return {
    x: msg.x,
    y: msg.y,
    window: msg.window,
    points: points.slice(0, LIFT_POINTS),
    private: msg.private === true,
    ring: msg.ring !== false,
    ...(finiteNumber(msg.fx) && finiteNumber(msg.fy) ? { fx: msg.fx, fy: msg.fy } : {}),
  };
}

/** The "observe" command for `windows` (the helper watches two at most: the first two), with
 *  those of them in `paged` as its "page" list, left out when there are none (a helper older
 *  than it reads only the windows). */
export function observeCommandOf(windows: readonly number[], paged: readonly number[]): Record<string, unknown> {
  const watched = windows.slice(0, 2);
  const page = [...new Set(paged)].filter((id) => watched.includes(id));
  return { cmd: "observe", windows: watched, ...(page.length ? { page } : {}) };
}
