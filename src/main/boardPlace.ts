/*
  Where the board of a lesson over another app goes (screenTeach.ts), and what the lesson's page
  may say about it. Rectangles in, a rectangle out: nothing here touches Electron, so it is tested
  on its own (scripts/tests/boardPlace.test.ts).

  The board is a window of its own beside the app being read. It goes beside the words read, on
  the side with more room, as tall as the work area allows above the lesson's dock (bottom right,
  GuideDock in the web app); where neither side has room for it, over the right edge of the
  words. A place and size the student chose themselves (store.ts keeps the last one) is used again
  while it is still mostly on that display (brought on to it whole) and leaves the words mostly
  clear.

  Every rectangle is in screen points, Electron's own space: the read's boxes (`Rect`, as the
  screen helper sends them) and the windows' (`Box`, as Electron places them) alike.
*/

/** A box as the screen helper reads it: a line, the window that was read. */
export type Rect = { x: number; y: number; w: number; h: number };
/** A box as Electron places windows: a display's work area, a window's bounds. */
export type Box = { x: number; y: number; width: number; height: number };

/** What the lesson's page says about its board (screen-teach:board): whether this run has
 *  something on it, whether it is zoomed, the board's own colour (the window's, behind it), and a
 *  count of what has gone up on it (a new one is something new: the Board tab's dot). */
export interface BoardState {
  run: number;
  show: boolean;
  full: boolean;
  background?: string;
  drawn?: number;
}

/** The smallest the board is made, or kept: GuideBoard's footer and a picture still fit. */
export const BOARD_MIN = { width: 360, height: 260 } as const;
/** Its size when the student has not chosen one: about the floating board's in the web app. */
const DEFAULT_SIZE = { width: 620, height: 640 } as const;
/** From the work area's edges. */
const MARGIN = 16;
/** Between the words and the board beside them. */
const GAP = 24;
/** The bottom of the work area left to the lesson's dock and chip, which draw above the board. */
const DOCK_CLEAR = 140;
/** A place kept from before may lie over this much of the words (a share of its own area). */
const MAX_OVER_TEXT = 0.25;
/** The board's head: its title bar, with the traffic lights (GuideBoard's .guide-board-head). */
const HEAD = 38;
/** A place kept from before is still this display's while this share of it, and of its head, is
 *  on the work area. */
const MIN_ON_WORK = 0.5;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function overlap(a: Box, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The share of `a` that lies on `area`. */
const shareOn = (a: Box, area: Box): number =>
  a.width > 0 && a.height > 0 ? overlap(a, { x: area.x, y: area.y, w: area.width, h: area.height }) / (a.width * a.height) : 0;

/**
 * A place the student left the board at, brought whole on to the work area, or null when too
 * little of it is there to be this display's: under half of it, or of its head (where it is taken
 * hold of). macOS lets a window hang past the screen's left, right or bottom edge, or down behind
 * the Dock, and the work area stops short of all of them, so a place the student dragged there is
 * still theirs: kept as near it as the work area allows.
 */
function keptPlace(saved: Box, work: Box): Box | null {
  if (saved.width < BOARD_MIN.width || saved.height < BOARD_MIN.height) return null;
  const head: Box = { x: saved.x, y: saved.y, width: saved.width, height: Math.min(HEAD, saved.height) };
  if (shareOn(saved, work) < MIN_ON_WORK || shareOn(head, work) < MIN_ON_WORK) return null;
  const width = Math.min(saved.width, work.width);
  const height = Math.min(saved.height, work.height);
  return {
    x: clamp(saved.x, work.x, work.x + work.width - width),
    y: clamp(saved.y, work.y, work.y + work.height - height),
    width,
    height,
  };
}

const rounded = (b: Box): Box => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });

/** Where the words of a read are: one box around all its lines, or null when it has none. */
export function textBox(lines: ReadonlyArray<Rect>): Rect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const line of lines) {
    if (!finite(line.x) || !finite(line.y) || !finite(line.w) || !finite(line.h)) continue;
    left = Math.min(left, line.x);
    top = Math.min(top, line.y);
    right = Math.max(right, line.x + line.w);
    bottom = Math.max(bottom, line.y + line.h);
  }
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
}

/**
 * The board's bounds for a lesson. `work`: the work area of the display that holds the window
 * read; `text`: its words (textBox), or null when none were read; `frame`: that window;
 * `saved`: the place and size the student last left the board at, if any.
 */
export function placeBoard({ work, text, frame, saved }: { work: Box; text: Rect | null; frame: Rect; saved: Box | null }): Box {
  const words = text ?? frame;
  // Theirs, as they left it: mostly on this display (keptPlace brings the rest on), and, where it
  // is brought to, not over most of what is taught.
  const kept = saved ? keptPlace(saved, work) : null;
  if (kept && overlap(kept, words) <= MAX_OVER_TEXT * kept.width * kept.height) return rounded(kept);
  // Their size (or ours), as tall as the work area allows over the dock's corner.
  const fitWidth = Math.max(BOARD_MIN.width, work.width - 2 * MARGIN);
  const fitHeight = Math.max(BOARD_MIN.height, work.height - 2 * MARGIN - DOCK_CLEAR);
  let width = clamp(saved?.width ?? DEFAULT_SIZE.width, BOARD_MIN.width, fitWidth);
  const height = clamp(saved?.height ?? DEFAULT_SIZE.height, BOARD_MIN.height, fitHeight);
  // Beside the words, on the side with more room, narrowed to that room; over their right edge
  // when neither side has room for the smallest board.
  const workRight = work.x + work.width;
  const roomRight = workRight - (words.x + words.w) - GAP;
  const roomLeft = words.x - work.x - GAP;
  let x: number;
  if (Math.max(roomRight, roomLeft) >= BOARD_MIN.width) {
    if (roomRight >= roomLeft) {
      width = Math.min(width, roomRight);
      x = words.x + words.w + GAP;
    } else {
      width = Math.min(width, roomLeft);
      x = words.x - GAP - width;
    }
  } else {
    x = workRight - width - MARGIN;
  }
  x = clamp(x, work.x, workRight - width);
  // Level with the middle of the window read, clear of the menu bar's edge and of the dock.
  const top = work.y + MARGIN;
  const y = clamp(frame.y + frame.h / 2 - height / 2, top, Math.max(top, work.y + work.height - DOCK_CLEAR - height));
  return rounded({ x, y, width, height });
}

/** A colour as getComputedStyle gives one: #rrggbb, rgb() or rgba(). Never anything else. */
const COLOR = /^(#[0-9a-f]{6}|rgba?\([0-9.,\s%/]+\))$/i;

/** The page's message about its board, checked field by field, or null. */
export function boardStateOf(value: unknown): BoardState | null {
  const s = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (!finite(s.run) || typeof s.show !== "boolean" || typeof s.full !== "boolean") return null;
  // (a page older than the count sends none)
  if (s.drawn !== undefined && !(Number.isInteger(s.drawn) && (s.drawn as number) >= 0 && (s.drawn as number) <= 1e9)) return null;
  const drawn = s.drawn === undefined ? {} : { drawn: s.drawn as number };
  if (s.background === undefined || s.background === null) return { run: s.run, show: s.show, full: s.full, ...drawn };
  if (typeof s.background !== "string" || s.background.length > 64 || !COLOR.test(s.background)) return null;
  return { run: s.run, show: s.show, full: s.full, background: s.background, ...drawn };
}

/**
 * Whether a colour boardStateOf let through covers what is under it. The page reads the board's
 * colour from its document, which is see-through until its styles have come in (the lesson's
 * page is a see-through window): a window given that colour would show bare, so it keeps the one
 * it has.
 */
export function opaqueColor(color: string): boolean {
  const inner = /^rgba?\((.*)\)$/i.exec(color)?.[1];
  if (inner === undefined) return true;
  const slash = inner.split("/");
  const alpha = slash.length > 1 ? slash[1] : inner.split(",")[3];
  if (alpha === undefined) return true;
  const a = alpha.trim().endsWith("%") ? parseFloat(alpha) / 100 : parseFloat(alpha);
  return a >= 1;
}
