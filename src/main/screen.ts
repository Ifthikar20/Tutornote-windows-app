import { app, screen, type BaseWindow } from "electron";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { TAP_WORDS, type TapWords } from "./companionPlace";

/*
  The screen helper (helpers/screen/main.swift, built by scripts/build-screen-helper.sh):
  reads the words in another app's window, for "Explain on screen" (explain.ts) and the
  lesson over that window (screenTeach.ts), and turns that window's pages. For the desktop
  companion (companion.ts) it also says which window the cursor is over, hears presses, taps
  (a release at once, then the verdict) and scrolls on any window, and watches up to two windows
  for a new look. One helper for the app's life, started on first use. A read or a turn is a
  request with an id and one answer (a turn given up is cancelled by its id); a status or
  Accessibility check has no id and is answered in order.

  No helper (not macOS 14 or later, not built, not in the bundle): screenReadingAvailable()
  is false and the feature says so instead of starting.

  On Windows the helper is helpers/screen-win (C#, built by scripts/build-screen-helper.mjs): the
  same commands and events, with its points and boxes in physical screen pixels. They are turned
  into the app's own points here, display by display (pixelsIn, pixelsOut), so nothing past this
  file knows the difference.
*/

const HELPER = process.platform === "win32" ? "tutornote-screen.exe" : "tutornote-screen";
/** Windows: the helper speaks physical pixels, the app its own points (DIPs). */
const PIXELS = process.platform === "win32";
/** Windows 10 2004 (build 19041): Tutornote's floating windows can be left out of screen pictures. */
const WINDOWS_MIN_BUILD = 19041;

/** A read that never came back (a helper too old for the command ignores it) gives up after this. */
const READ_TIMEOUT_MS = 30_000;
/** A turn waits for the window to settle for up to its own timeoutMs; this much more before giving up. */
const TURN_GRACE_MS = 5_000;
/** An Accessibility check that is not answered counts as "not allowed". */
const AX_TIMEOUT_MS = 3_000;

/** One word of a line, as Vision boxed it, in the same screen points as its line. */
export interface ScreenWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenLine {
  /** The line's text, as Vision read it. */
  t: string;
  /** Vision's confidence, 0 to 1. */
  c: number;
  /** Its box, in screen points from the top left of the main display (Electron's own space). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Its words' boxes, when the helper sent them. */
  words?: ScreenWord[];
}

/** A line the page draws for an answer (the founder, 2026-10-27: "on the page where there is dash or
 *  line asking for a answer. some places asking for a answer can look like a long line breaker tab
 *  too"): from x0 to x1, its middle at y, in the same screen points as the lines (tutornote-web
 *  writePlace.ts AnswerLine). */
export interface ScreenRule {
  x0: number;
  x1: number;
  y: number;
}

/** The most answer lines a read keeps (the Windows helper sends no more). */
const MAX_RULES = 200;

export interface ScreenRead {
  app: string;
  bundle: string;
  title: string;
  /** The window's id (CGWindowID) and its process: what later reads and turns of it are sent. */
  window: number;
  pid: number;
  frame: { x: number; y: number; w: number; h: number };
  lines: ScreenLine[];
  captureMs: number;
  ocrMs: number;
  /** How bright the window is, 0 (black) to 1 (white), from its thumbnail: the lesson draws
   *  strong marks on a light page and light marks on a dark one. A helper older than the
   *  companion sends none. */
  ground?: number;
  /** The pass that read it: "fast" (a glance) or "accurate". */
  level?: "fast" | "accurate";
  /** The lines the page draws for an answer, found in an accurate read's picture (the Windows
   *  helper's Rules.cs: the web's rulesIn, words' own underlines left out), top to bottom; [] when
   *  there are none. Absent when none were looked for: a glance, or the Mac's helper. */
  rules?: ScreenRule[];
  /** How long its words waited, once pictured, for a companion tap being judged (main.swift
   *  tapsJudged: Vision reads one picture at a time); only when it waited. */
  heldMs?: number;
}

/** How a turn moves the window: a scroll of `dy` points at `at`, a key pressed `count` times, or nothing (the student turns it). */
export interface ScreenTurn {
  window: number;
  pid: number;
  how: "scroll" | "key" | "manual";
  /** Scroll: positive shows later content, negative earlier. */
  dy?: number;
  key?: "right" | "left" | "pagedown" | "pageup" | "down" | "up";
  count?: number;
  /** In screen points: where a scroll is posted, inside the content (the helper keeps it
   *  inside the window). */
  at: { x: number; y: number };
  /** The longest the helper waits for the window to change and settle. */
  timeoutMs: number;
  /** When the window no longer looks as it did at its last read (the student moved it), post
   *  nothing: that move is the turn. */
  unlessMoved?: boolean;
  /** No turn ("manual" only): a wait for the window to be still, answered as soon as two of the
   *  helper's thumbnails in a row agree, changed or not (a lesson switching documents reads the
   *  window once it is: screenTeach.ts switchRead). The watch for a new look is not kept quiet
   *  for it as for a turn. A helper older than it waits for a change instead, up to timeoutMs. */
  still?: boolean;
}

/** What a turn came to. `moved`: the window had moved since its last read, and nothing was
 *  posted. `front`: for a key, whether the app was in front to take it (null for the rest).
 *  `still`: for a wait for the window to be still, whether it was in time (null for the rest). */
export interface ScreenTurned {
  changed: boolean;
  settleMs: number;
  moved: boolean;
  front: boolean | null;
  still: boolean | null;
}

/**
 * A read or a turn that failed: no_permission, no_window, capture_failed, window_gone (the
 * window was closed or left the screen), no_access (turning needs Accessibility), timeout
 * (no answer), no_helper, or cancelled (given up here: its AbortSignal).
 */
export class ScreenReadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function helperPath(): string | null {
  if (process.platform === "win32") {
    if (Number(os.release().split(".")[2] ?? 0) < WINDOWS_MIN_BUILD) return null;
  } else if (process.platform !== "darwin") {
    return null;
  } else if (Number(os.release().split(".")[0]) < 23) {
    // ScreenCaptureKit's one-picture capture is macOS 14 (Darwin 23) and later.
    return null;
  }
  const file = app.isPackaged ? path.join(process.resourcesPath, HELPER) : path.join(app.getAppPath(), "build", "helpers", HELPER);
  return existsSync(file) ? file : null;
}

export const screenReadingAvailable = (): boolean => helperPath() !== null;

/**
 * Windows: keep one of Tutornote's floating windows (the lesson's layer, the blob, the board, the
 * Explain on screen panel) out of every screen picture, so the helper's looks of a page never take
 * the tutor's own pointer and marks for the page changing. The window still shows on the display;
 * it also stays out of the student's own screenshots and screen shares.
 */
export function hideFromCapture(win: BaseWindow): void {
  if (PIXELS) win.setContentProtection(true);
}

type Box = { x: number; y: number; w: number; h: number };
const boxIn = (b: Box): Box => {
  // (Electron takes a rectangle in whole pixels only)
  const r = screen.screenToDipRect(null, { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.w), height: Math.round(b.h) });
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};
const isBox = (v: unknown): v is Box => {
  const b = v as Record<string, unknown> | null;
  return !!b && finiteNumber(b.x) && finiteNumber(b.y) && finiteNumber(b.w) && finiteNumber(b.h);
};

/** A read's answer lines as the helper sent them: each one finite numbers with x1 past x0, the first
 *  MAX_RULES of them; null when it sent none (none were looked for). */
function rulesOf(value: unknown): ScreenRule[] | null {
  if (!Array.isArray(value)) return null;
  const rules: ScreenRule[] = [];
  for (const v of value as unknown[]) {
    const r = v as Record<string, unknown> | null;
    if (!r || !finiteNumber(r.x0) || !finiteNumber(r.x1) || !finiteNumber(r.y) || !(r.x1 > r.x0)) continue;
    rules.push({ x0: r.x0, x1: r.x1, y: r.y });
    if (rules.length >= MAX_RULES) break;
  }
  return rules;
}

/** Windows: an answer line from physical pixels into the app's points, as a line's box is (a pixel
 *  tall, on the display the box is nearest). */
const ruleIn = (r: ScreenRule): ScreenRule => {
  const b = boxIn({ x: r.x0, y: r.y, w: r.x1 - r.x0, h: 1 });
  return { x0: b.x, x1: b.x + b.w, y: b.y };
};

/** Windows: a helper message's points and boxes, from physical pixels into the app's points. */
function pixelsIn(msg: Record<string, unknown>): void {
  if (finiteNumber(msg.x) && finiteNumber(msg.y)) {
    const p = screen.screenToDipPoint({ x: msg.x, y: msg.y });
    msg.x = p.x;
    msg.y = p.y;
  }
  for (const key of ["frame", "topFrame"]) if (isBox(msg[key])) msg[key] = boxIn(msg[key]);
  const other = msg.other as Record<string, unknown> | null | undefined;
  if (other && isBox(other.frame)) other.frame = boxIn(other.frame);
  if (Array.isArray(msg.lines)) {
    for (const line of msg.lines as Array<Record<string, unknown>>) {
      const words = line.words;
      if (isBox(line)) Object.assign(line, boxIn(line));
      if (Array.isArray(words)) for (const word of words as Array<Record<string, unknown>>) if (isBox(word)) Object.assign(word, boxIn(word));
    }
  }
  const rules = rulesOf(msg.rules);
  if (rules) msg.rules = rules.map(ruleIn);
}

/** Windows: a point the app names, into the helper's physical pixels. */
function pixelsOut(p: { x: number; y: number }): { x: number; y: number } {
  return PIXELS ? screen.dipToScreenPoint(p) : p;
}

type Helper = ChildProcessByStdio<Writable, Readable, Readable>;

interface Waiting {
  /** The answer's `ev` on success ("read", "turned"); any other is an error with a code. */
  ev: string;
  resolve: (message: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** A tap the student made on the watched window (watchWindow), in screen points; with the
 *  companion on (companionWatch), on any ordinary window: its verdict, a moment after its release
 *  (ScreenRelease). `moved`: the window no longer looks as it did before the click, so what was
 *  read there has moved. `acted` (companion only): the click did something in its app (a link, a
 *  button, a page turn, a menu): the tapped line's own patch changed and the tapped words did not
 *  stay (`words`). `alt`: Option was held. */
export interface ScreenTap {
  x: number;
  y: number;
  window: number;
  moved: boolean;
  acted: boolean;
  alt: boolean;
  /** The numbers the helper judged the tap by (companion only; for the log): `line`, how much the
   *  tapped line's own patch changed, and `away`, how much the window away from the tap did
   *  (mean differences, 0 to 255); `wide`: away changed too; `look`: how old the watch's look it
   *  also compared with was, in seconds, or -1 for none. */
  line?: number;
  away?: number;
  wide?: boolean;
  look?: number;
  /** The release this verdict is for (ScreenRelease.id); companion only. */
  id?: number;
  /** What the words at the tap said (companionPlace.ts TapWords), how many of the tapped row's
   *  words were found again (0 to 1) and how far they had moved (points, up negative), and how
   *  long reading them took (ms). Companion only, from a helper that reads them. */
  words?: TapWords;
  kept?: number;
  shift?: number;
  textMs?: number;
}

/** With the companion on: the student's tap on an ordinary window ended (a press and a release in
 *  one place), told at once, before it is judged (its ScreenTap follows with the same `id`), in
 *  screen points. `clicks`: 2 or more for a double click; `hand`: the cursor was a pointing hand
 *  at the press (a link); `private`: a private app's window, or secure input was on (nothing of it
 *  is pictured or read). */
export interface ScreenRelease {
  id: number;
  x: number;
  y: number;
  window: number;
  alt: boolean;
  clicks: number;
  hand: boolean;
  private: boolean;
}

/** The student scrolled the watched window (with the companion on, the one under the cursor):
 *  its content moved up by `dy` points (down when negative) and left by `dx`. `momentum`: the
 *  glide after the fingers left the trackpad. Never the helper's own scrolls. */
export interface ScreenScroll {
  dy: number;
  dx: number;
  momentum: boolean;
  window: number;
}

/** With the companion on: the window the cursor is over changed. `window` null over nothing, or
 *  over Tutornote's own windows (`own`). `secure`: a password field has the keys. */
export interface ScreenOver {
  window: number | null;
  pid: number;
  app: string;
  bundle: string;
  title: string;
  frame: { x: number; y: number; w: number; h: number } | null;
  own: boolean;
  secure: boolean;
}

/** With the companion on: the mouse button went down on an ordinary window (screen points). */
export interface ScreenPress {
  x: number;
  y: number;
  window: number;
}

/** An observed window (observeWindows) settled into a new look: a page the student turned. */
export interface ScreenChanged {
  window: number;
  settleMs: number;
}

/** A window "ident" names: its id, and its title and frame (screen points). */
export interface ScreenIdentWindow {
  window: number;
  title: string;
  frame: { x: number; y: number; w: number; h: number } | null;
}

/**
 * Which document the watched window shows (main.swift "The lesson's window: which document"), as
 * the watch starts and whenever any of it changes: its `title` (kCGWindowName) and whether it is
 * on the screen; `top`, while its app is in front, that app's front ordinary window (another of
 * its windows when the student opened or picked one), with its title and frame; and `other`,
 * while another app is in front (never Tutornote, nothing under secure input), that app's front
 * ordinary window with its app; and `secure`, whether secure input is on (a password field has
 * the keys, somewhere: nothing is read for another document then; false from a helper that does
 * not say). Titles are the screen's words: never logged.
 */
export interface ScreenIdent {
  window: number;
  title: string;
  onScreen: boolean;
  top: number | null;
  topTitle: string;
  topFrame: ScreenIdentWindow["frame"];
  other: (ScreenIdentWindow & { pid: number; app: string; bundle: string }) | null;
  secure: boolean;
}

/** The talk chord, Control and Option held on their own (main.swift "The talk chord"), while
 *  chordWatch is on: "down" once it has been held 300 ms (the page shows the hold's ring), "tap"
 *  at a release within 700 ms, "hold" once at 5 s (talk mode), "up" at the release after a hold,
 *  and "cancel" for one spoiled after its "down" (another key, a click, a scroll, another
 *  modifier joined), let go between 700 ms and 5 s, or watched no longer. `ms`: how long it had
 *  been held. `why` (a cancel's, such as "key", "mouse", "modifier", "long") and `keys` (which
 *  sides, "lctrl+lopt") are for the log only; the page gets the kind and the time. */
export interface ScreenChord {
  kind: "down" | "tap" | "hold" | "up" | "cancel";
  ms: number;
  why?: string;
  keys?: string;
}

const CHORD_KINDS: ReadonlySet<string> = new Set<ScreenChord["kind"]>(["down", "tap", "hold", "up", "cancel"]);

/** Whether the talk chord can be used at all, as the helper says it while the chord is watched (as
 *  the watch goes on, then on each change): off while VoiceOver is on ("voiceover": Control and
 *  Option are its keys), while secure input is ("secure") and once the modifier keys look hidden
 *  from the helper ("hidden"). ⌃⌥M is the way in then, and the page names it instead. */
export interface ScreenChordState {
  on: boolean;
  why?: string;
}

/**
 * What the helper tells unasked while a window is watched: "tap" (a ScreenTap), "scroll" (a
 * ScreenScroll), "front" (the pid of the app that came to the front; once on watch, then on
 * each change) and "ident" (a ScreenIdent: which document the window shows, from a helper that
 * says it). With the companion on, also "over" (a ScreenOver), "press" (a ScreenPress),
 * "release" (a ScreenRelease, ahead of its tap), and taps and scrolls on any window; and
 * "changed" (a ScreenChanged) for the windows observed. While the talk chord is watched
 * (chordWatch), "chord" (a ScreenChord) and "chordState" (a ScreenChordState).
 */
export const watchEvents = new EventEmitter();

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A frame the helper sent, or null. */
function frameOf(value: unknown): ScreenOver["frame"] {
  const f = (value ?? {}) as Record<string, unknown>;
  return finiteNumber(f.x) && finiteNumber(f.y) && finiteNumber(f.w) && finiteNumber(f.h) ? { x: f.x, y: f.y, w: f.w, h: f.h } : null;
}

/** An "ident" the helper sent, field by field (finite numbers, strings, a boolean), or null. */
function identOf(msg: Record<string, unknown>): ScreenIdent | null {
  if (!finiteNumber(msg.window)) return null;
  const o = (typeof msg.other === "object" && msg.other !== null ? msg.other : null) as Record<string, unknown> | null;
  const other =
    o && finiteNumber(o.window) && finiteNumber(o.pid)
      ? {
          window: o.window,
          pid: o.pid,
          app: typeof o.app === "string" ? o.app : "",
          bundle: typeof o.bundle === "string" ? o.bundle : "",
          title: typeof o.title === "string" ? o.title : "",
          frame: frameOf(o.frame),
        }
      : null;
  return {
    window: msg.window,
    title: typeof msg.title === "string" ? msg.title : "",
    onScreen: msg.onScreen === true,
    top: finiteNumber(msg.top) ? msg.top : null,
    topTitle: typeof msg.topTitle === "string" ? msg.topTitle : "",
    topFrame: frameOf(msg.topFrame),
    other,
    secure: msg.secure === true,
  };
}

let helper: Helper | null = null;
let nextId = 1;
const waiting = new Map<number, Waiting>();
const statusWaiters: Array<(granted: boolean) => void> = [];
const axWaiters: Array<(trusted: boolean) => void> = [];

function onLine(line: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.warn(`[screen] ${line}`);
    return;
  }
  if (PIXELS) pixelsIn(msg);
  if (msg.ev === "status") {
    statusWaiters.shift()?.(msg.screen === true);
    return;
  }
  if (msg.ev === "ax") {
    axWaiters.shift()?.(msg.trusted === true);
    return;
  }
  if (msg.ev === "tap") {
    if (typeof msg.x === "number" && typeof msg.y === "number" && typeof msg.window === "number") {
      watchEvents.emit("tap", {
        x: msg.x,
        y: msg.y,
        window: msg.window,
        moved: msg.moved === true,
        acted: msg.acted === true,
        alt: msg.alt === true,
        ...(finiteNumber(msg.line) ? { line: msg.line } : {}),
        ...(finiteNumber(msg.away) ? { away: msg.away } : {}),
        ...(typeof msg.wide === "boolean" ? { wide: msg.wide } : {}),
        ...(finiteNumber(msg.look) ? { look: msg.look } : {}),
        ...(finiteNumber(msg.id) ? { id: msg.id } : {}),
        ...(typeof msg.words === "string" && TAP_WORDS.has(msg.words) ? { words: msg.words as TapWords } : {}),
        ...(finiteNumber(msg.kept) ? { kept: msg.kept } : {}),
        ...(finiteNumber(msg.shift) ? { shift: msg.shift } : {}),
        ...(finiteNumber(msg.textMs) ? { textMs: msg.textMs } : {}),
      } satisfies ScreenTap);
    }
    return;
  }
  if (msg.ev === "release") {
    if (finiteNumber(msg.id) && finiteNumber(msg.x) && finiteNumber(msg.y) && typeof msg.window === "number") {
      watchEvents.emit("release", {
        id: msg.id,
        x: msg.x,
        y: msg.y,
        window: msg.window,
        alt: msg.alt === true,
        clicks: finiteNumber(msg.clicks) && msg.clicks >= 1 ? Math.round(msg.clicks) : 1,
        hand: msg.hand === true,
        private: msg.private === true,
      } satisfies ScreenRelease);
    }
    return;
  }
  if (msg.ev === "front") {
    if (typeof msg.pid === "number") watchEvents.emit("front", msg.pid);
    return;
  }
  if (msg.ev === "scroll") {
    if (finiteNumber(msg.dy) && typeof msg.window === "number") {
      const dx = finiteNumber(msg.dx) ? msg.dx : 0;
      watchEvents.emit("scroll", { dy: msg.dy, dx, momentum: msg.momentum === true, window: msg.window } satisfies ScreenScroll);
    }
    return;
  }
  if (msg.ev === "over") {
    watchEvents.emit("over", {
      window: typeof msg.window === "number" ? msg.window : null,
      pid: typeof msg.pid === "number" ? msg.pid : 0,
      app: typeof msg.app === "string" ? msg.app : "",
      bundle: typeof msg.bundle === "string" ? msg.bundle : "",
      title: typeof msg.title === "string" ? msg.title : "",
      frame: frameOf(msg.frame),
      own: msg.own === true,
      secure: msg.secure === true,
    } satisfies ScreenOver);
    return;
  }
  if (msg.ev === "press") {
    if (finiteNumber(msg.x) && finiteNumber(msg.y) && typeof msg.window === "number") {
      watchEvents.emit("press", { x: msg.x, y: msg.y, window: msg.window } satisfies ScreenPress);
    }
    return;
  }
  if (msg.ev === "changed") {
    if (typeof msg.window === "number") {
      watchEvents.emit("changed", { window: msg.window, settleMs: finiteNumber(msg.settleMs) ? msg.settleMs : 0 } satisfies ScreenChanged);
    }
    return;
  }
  if (msg.ev === "ident") {
    const ident = identOf(msg);
    if (ident) watchEvents.emit("ident", ident);
    return;
  }
  if (msg.ev === "chord") {
    // (whether it can be used: its own event, never taken for a press of the keys)
    if (msg.kind === "state") {
      if (typeof msg.on === "boolean") {
        watchEvents.emit("chordState", {
          on: msg.on,
          ...(typeof msg.why === "string" && msg.why ? { why: msg.why.slice(0, 24) } : {}),
        } satisfies ScreenChordState);
      }
      return;
    }
    // (a kind this side knows and a time, or nothing: the page only ever hears those two)
    if (typeof msg.kind === "string" && CHORD_KINDS.has(msg.kind) && finiteNumber(msg.ms)) {
      watchEvents.emit("chord", {
        kind: msg.kind as ScreenChord["kind"],
        ms: Math.max(0, Math.round(msg.ms)),
        ...(typeof msg.why === "string" && msg.why ? { why: msg.why.slice(0, 24) } : {}),
        ...(typeof msg.keys === "string" && msg.keys ? { keys: msg.keys.slice(0, 32) } : {}),
      } satisfies ScreenChord);
    }
    return;
  }
  const id = typeof msg.id === "number" ? msg.id : -1;
  const request = waiting.get(id);
  if (!request) return;
  waiting.delete(id);
  clearTimeout(request.timer);
  if (msg.ev === request.ev) request.resolve(msg);
  else request.reject(new ScreenReadError(typeof msg.code === "string" ? msg.code : "capture_failed"));
}

/*
  The companion's asks (companionWatch, observeWindows) and the lesson's watch (watchWindow) last
  until taken back, unlike a read: a helper started again (a restart for Screen Recording, or one
  that stopped) is told them again as it starts, so the tutor goes on following the cursor and the
  lesson goes on hearing which app is in front. One that stops while the companion is on, or while
  the talk chord is watched (chordWatch: a lesson's, with or without the companion), is started
  again a second later, a few times a minute at most (one refused for good, not started by the app,
  would only stop again).
*/
let companionAsk: { on: boolean; stop: number[]; private: string[]; readers: string[] } | null = null;
let observeAsk: number[] = [];
let watchAsk: number | null = null;
let chordAsk = false;
const RESPAWN_MS = 1_000;
const RESPAWNS_PER_MINUTE = 5;
let respawns: number[] = [];

function helperGone(why: string): void {
  console.warn(`[screen] helper ${why}`);
  for (const request of waiting.values()) {
    clearTimeout(request.timer);
    request.reject(new ScreenReadError("no_helper"));
  }
  waiting.clear();
  while (statusWaiters.length) statusWaiters.shift()?.(false);
  while (axWaiters.length) axWaiters.shift()?.(false);
  if (!companionAsk?.on && !chordAsk) return;
  const now = Date.now();
  respawns = respawns.filter((at) => now - at < 60_000);
  if (respawns.length >= RESPAWNS_PER_MINUTE) {
    console.warn("[screen] the helper keeps stopping: the companion waits for the next ask");
    return;
  }
  respawns.push(now);
  setTimeout(() => {
    if (!helper && (companionAsk?.on || chordAsk)) ensureHelper();
  }, RESPAWN_MS).unref();
}

function ensureHelper(): Helper | null {
  if (helper) return helper;
  const file = helperPath();
  if (!file) return null;
  let child: Helper;
  try {
    child = spawn(file, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } catch (e) {
    console.warn(`[screen] could not start the helper: ${(e as Error).message}`);
    return null;
  }
  helper = child;
  readline.createInterface({ input: child.stdout }).on("line", onLine);
  readline.createInterface({ input: child.stderr }).on("line", (line) => console.warn(line));
  child.stdin.on("error", () => undefined);
  child.on("error", (e) => {
    if (helper === child) helper = null;
    helperGone(`failed: ${e.message}`);
  });
  child.on("exit", (code, signal) => {
    if (helper === child) helper = null;
    helperGone(`exited (${signal ?? code})`);
  });
  console.log(`[screen] helper ${file}`);
  // (what the lesson and the companion asked of the helper before this one, asked again)
  if (watchAsk !== null) child.stdin.write(`${JSON.stringify({ cmd: "watch", window: watchAsk })}\n`);
  if (companionAsk?.on) child.stdin.write(`${JSON.stringify({ cmd: "companion", ...companionAsk })}\n`);
  // (with the companion paused too: then the lesson's window alone, the companion told off)
  if (observeAsk.length) child.stdin.write(`${JSON.stringify({ cmd: "observe", windows: observeAsk })}\n`);
  // (a helper older than the chord says "unknown command" to its log, and hears no chord)
  if (chordAsk) child.stdin.write(`${JSON.stringify({ cmd: "chord", on: true })}\n`);
  return child;
}

function command(message: Record<string, unknown>): boolean {
  const child = ensureHelper();
  if (!child) return false;
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return true;
}

/**
 * A command with an id, and its one answer: `ev` on success, else a ScreenReadError with the
 * helper's code. Aborted (`signal`), it is cancelled in the helper too, and fails at once.
 */
function request(message: Record<string, unknown>, ev: string, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ScreenReadError("cancelled"));
    const id = nextId++;
    const onAbort = (): void => {
      if (!waiting.delete(id)) return;
      clearTimeout(timer);
      command({ cmd: "cancel", id });
      reject(new ScreenReadError("cancelled"));
    };
    const done = (): void => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      if (!waiting.delete(id)) return;
      done();
      reject(new ScreenReadError("timeout"));
    }, timeoutMs);
    waiting.set(id, {
      ev,
      resolve: (answer) => {
        done();
        resolve(answer);
      },
      reject: (e) => {
        done();
        reject(e);
      },
      timer,
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (!command({ ...message, id })) {
      waiting.delete(id);
      clearTimeout(timer);
      done();
      reject(new ScreenReadError("no_helper"));
    }
  });
}

function askStatus(cmd: "status" | "request"): Promise<boolean> {
  return new Promise((resolve) => {
    if (!command({ cmd })) return resolve(false);
    statusWaiters.push(resolve);
  });
}

/** Whether macOS lets the helper read the screen (Screen Recording). */
export const screenAllowed = (): Promise<boolean> => askStatus("status");

/** Ask macOS for Screen Recording: its own prompt the first time, then System Settings. */
export const requestScreenAccess = (): Promise<boolean> => askStatus("request");

/**
 * Whether macOS lets the helper post scrolls and key presses to other apps (Accessibility),
 * which turning their pages needs. With `prompt`, macOS also asks the student to allow it
 * (its own dialog, which leads to System Settings); the answer is how things stand now.
 */
export function accessibilityAllowed(prompt: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (!command({ cmd: "ax", prompt })) return resolve(false);
    let answered = false;
    const answer = (trusted: boolean): void => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      resolve(trusted);
    };
    // Left in the queue on a timeout: a late answer is still this one's, so the next
    // check gets its own.
    axWaiters.push(answer);
    const timer = setTimeout(() => answer(false), AX_TIMEOUT_MS);
  });
}

/**
 * Restart the helper: a Screen Recording permission given in System Settings counts only
 * for a process started after it.
 */
export function restartScreenHelper(): void {
  const child = helper;
  helper = null;
  if (child) {
    child.stdin.end();
    child.kill();
  }
}

/** A read as the helper answered it, its answer lines checked (rulesOf): one that sent none has none. */
function readOf(answer: Record<string, unknown>): ScreenRead {
  const rules = rulesOf(answer.rules);
  if (rules) answer.rules = rules;
  else delete answer.rules;
  return answer as unknown as ScreenRead;
}

/** The text of the window on top at (x, y), skipping the windows of the processes in `exclude`. */
export async function readWindowAt(x: number, y: number, exclude: number[]): Promise<ScreenRead> {
  return readOf(await request({ cmd: "read", ...pixelsOut({ x, y }), exclude }, "read", READ_TIMEOUT_MS));
}

/**
 * The text of a window read before, as it is now (its id from that read). Fails with window_gone
 * once it has closed. `fast`: a glance (Vision's fast pass, a quarter of the time, boxes good for
 * paragraphs and lines), for the companion's hover band and a lesson's quick check after a scroll;
 * never the words a lesson teaches.
 */
export async function readWindow(window: number, opts?: { fast?: boolean }): Promise<ScreenRead> {
  const level = opts?.fast ? { level: "fast" } : {};
  return readOf(await request({ cmd: "read", window, ...level }, "read", READ_TIMEOUT_MS));
}

/**
 * Turn or scroll a window, then wait until it has changed and settled (or the turn's
 * timeout). `changed` false: the window looks as it did, so the move did nothing there.
 * `signal`: given up (a wait for the student no longer wanted), it fails with "cancelled".
 */
export async function turnWindow(turn: ScreenTurn, signal?: AbortSignal): Promise<ScreenTurned> {
  const answer = await request({ cmd: "turn", ...turn, at: pixelsOut(turn.at) }, "turned", turn.timeoutMs + TURN_GRACE_MS, signal);
  return {
    changed: answer.changed === true,
    settleMs: typeof answer.settleMs === "number" ? answer.settleMs : 0,
    moved: answer.moved === true,
    front: typeof answer.front === "boolean" ? answer.front : null,
    still: typeof answer.still === "boolean" ? answer.still : null,
  };
}

/** Tell the student's taps on this window, and which app is in front (watchEvents), until unwatchWindow. */
export function watchWindow(window: number): void {
  // (kept after it is sent: a helper this starts is not told it twice)
  command({ cmd: "watch", window });
  watchAsk = window;
}

export function unwatchWindow(): void {
  watchAsk = null;
  if (helper) command({ cmd: "unwatch" });
}

/**
 * The desktop companion on or off (companion.ts): the helper says which window the cursor is over
 * ("over"), and hears presses, taps and scrolls on any ordinary window (watchEvents). `stop`: the
 * CGWindowIDs of Tutornote's own windows that the helper cannot tell by their app (the blob, the
 * board, which float), so it counts them as Tutornote's. Asked again with a new `stop` whenever
 * those windows change. `privateApps`: the bundle ids whose windows it never takes a picture of
 * (a press or a tap there is told with none). `readerApps`: the readers, whose bars fade in and
 * out at a click on their page, so a tap there is judged against a vetted look (main.swift judgeTap).
 */
export function companionWatch(on: boolean, stop: number[], privateApps: readonly string[] = [], readerApps: readonly string[] = []): void {
  const ask = { on, stop, private: [...privateApps], readers: [...readerApps] };
  companionAsk = on ? ask : null;
  if (!on) observeAsk = [];
  if (on || helper) command({ cmd: "companion", ...ask });
}

/** Watch these windows (two at most: the lesson's and the one under the cursor) for a new look
 *  ("changed"); [] stops, as the companion going off does. The companion's while it is on (paused,
 *  the lesson's window alone, after companionWatch(false)); with it off, the lesson's own window
 *  (screenTeach.ts), so a slide the student changes reaches every lesson. */
export function observeWindows(ids: number[]): void {
  observeAsk = ids.slice(0, 2);
  if (helper) command({ cmd: "observe", windows: observeAsk });
}

/**
 * The talk chord watched, or no longer (screenTeach.ts: exactly while its talk key is): the helper
 * polls the modifier keys and says "chord" (a ScreenChord) as Control and Option are held on their
 * own and let go. No permission and no prompt: it reads the keys' state, never the keys typed.
 * Kept, like the companion's ask, for a helper started again; one is started for it if none runs.
 */
export function chordWatch(on: boolean): void {
  const was = chordAsk;
  chordAsk = on;
  // (a helper this starts is told it as it starts: ensureHelper)
  if (helper) {
    if (on !== was) command({ cmd: "chord", on });
  } else if (on) {
    ensureHelper();
  }
}

app.on("will-quit", () => {
  // (not started again as it goes)
  companionAsk = null;
  chordAsk = false;
  const child = helper;
  helper = null;
  if (child) {
    child.stdin.end();
    setTimeout(() => child.kill(), 500).unref();
  }
});
