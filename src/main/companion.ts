import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, type IpcMainEvent, type Rectangle, type WebContents } from "electron";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BLOB_SIZE,
  blobUp,
  choiceOf,
  clampBlobPlace,
  CLICK_TRAVEL,
  defaultBlobPlace,
  isEditorApp,
  isPrivateApp,
  labelBounds,
  PRIVATE_APPS,
  READER_APPS,
  selectionKept,
  tapNumbers,
  tapOnWords,
  tapRoute,
  windowIdOf,
  type Point,
} from "./companionPlace";
import { titleChange } from "./docIdentity";
import { appEvents } from "./events";
import { ensureScreenReading, screenPanelWindow } from "./explain";
import {
  companionWatch,
  hideFromCapture,
  observeWindows,
  readWindow,
  restartScreenHelper,
  screenReadingAvailable,
  ScreenReadError,
  watchEvents,
  type ScreenChanged,
  type ScreenIdent,
  type ScreenOver,
  type ScreenPress,
  type ScreenRead,
  type ScreenRelease,
  type ScreenScroll,
  type ScreenTap,
} from "./screen";
import {
  boardWindow,
  closeScreenTeach,
  companionArea,
  companionWentOff,
  fromScreenTeachPage,
  hideCompanionOverlay,
  localPoint,
  localRead,
  moveCompanionOverlay,
  openScreenTeach,
  overlayInteractive,
  overlayWindow,
  pressWasThePage,
  screenPoint,
  screenTeachLesson,
  sendToPage,
  showCompanionOverlay,
  useCarefulReads,
} from "./screenTeach";
import { companionTipped, loadBlobPlace, markCompanionTipped, saveBlobPlace } from "./store";
import { getMainWindow } from "./windows";

/*
  The desktop companion: Tutornote's tutor over any app ("Teach mode over any app").

  A blob lives on the desktop (static/blob.html, a 64 point window of its own that floats over every
  app and every Space and never takes the keys). Click it, or press ⌃⌥E in any app, and the tutor
  hops out and trails the cursor over whatever is under it: a Kindle book, Kortext, a PDF in
  Chrome. It is drawn by the lesson's own see-through window (screenTeach.ts companion mode, the web
  app's /dashboard/screen-teach page), which now stays up for as long as the tutor is on.

    hover   the helper (screen.ts, helpers/screen/main.swift) says which window the cursor is over;
            after DWELL_MS of stillness over one this side has not read, it is glanced at (a fast
            read, on this Mac). The page keeps the glance for where its pointer goes and where a
            tap lands, and draws nothing under the cursor. Nothing leaves the Mac.
    tap     the moment a tap ends on another app's window (the helper's "release") the page hears
            it, and may paint the card in that frame: Explain, Ask a question. The window is read
            carefully from then on, so the lesson's words are ready when the student picks. The
            helper's verdict follows (about 0.2 s): a click its app used (a link, a button, a page
            turn, a double click) takes the card away again; an Option click is always the tutor's.
    pick    the lesson runs over that window as before (openScreenTeach), quietly after the first.

  The tutor never moves the real cursor, and never clicks or types: every event here is heard, not
  taken. Esc stays the other apps': the page's dock (its ×), the tab bar's button and ⌃⌥E end the
  tutor. While it is on the blob is hidden and that dock is the control (one spot, bottom right);
  only a page too old to have one (it never says companion-dock) keeps the blob up as a ring. The
  dock's pause holds the whole tutor (held): nothing is followed, glanced at or read until Play.

  Never read: Tutornote's own windows (the helper reports them as "own", with the ids of the ones it
  cannot tell by their app: stopIds), the apps in companionPlace.ts PRIVATE_APPS, and any window
  while a password field has the keys (secure input). Everything read stays on this Mac until the
  student picks a choice on the card.

  The tab bar's button turns the tutor on and off ("companion-blob"); its look follows the
  companion ("companion-state": hidden, shown, on), told through appEvents so windows.ts imports
  nothing here.
*/

const SHORTCUT = "Control+Alt+E";
/** Stillness over a window not glanced at yet, before it is. */
const DWELL_MS = 120;
/** A window glanced at again this long after the student's last scroll of it. */
const AFTER_SCROLL_MS = 250;
/** The tutor's flight home into the blob, before the window goes. */
const HOME_MS = 320;
/** The blob shows the tutor inside it again once it has flown home. */
const HOME_LOOK_MS = 300;
/** How often the blob follows the cursor while dragged, and the cursor fed to the page. */
const FRAME_MS = 16;
/** A drag that never ended (the release was lost) ends after this. */
const DRAG_SAFETY_MS = 10_000;
/** Windows heard of (their app), kept at most this many. */
const WINDOWS_KEPT = 200;
/** A window that keeps settling into new looks (typing, a slideshow) is glanced at again at most
 *  this often for them. */
const CHANGED_GLANCE_MS = 2_000;
/** A new look of a window this soon after the tap that opened its card is that tap's doing away
 *  from the paragraph (a reader's bars shown by a click on its page), not a page turned: the card
 *  stays. */
const TAP_SETTLE_MS = 1_500;
/** A glance that found no words over one that had some is tried once more this much later. */
const GLANCE_AGAIN_MS = 300;
/** The tapped row's words a pick may carry (explainAt `row`). */
const ROW_CHARS = 300;
/** The blob starts to go this long after the tutor hops out of it (its own fade is about as long), */
const BLOB_HANDOFF_MS = 180;
/** and fades out in this long (blob.html's hidden look) before its window hides. */
const BLOB_FADE_MS = 120;

const LABELS = {
  resting: "Click to turn me on",
  on: "Click to stop",
  blocked: "Tutornote needs Screen Recording. Click to fix.",
  // (no screen helper in this build, or a Mac older than macOS 14: Screen Recording is not it)
  unavailable: process.platform === "win32" ? "Tutornote can't read other apps on this computer." : "Tutornote can't read other apps on this Mac.",
} as const;

let blob: BrowserWindow | null = null;
/** The blob is up (the tab bar's button, ⌃⌥E): hidden, it is out of the way entirely. */
let blobShown = false;
/** The blob's top left, in screen points: the window's place, but for its label's room. */
let blobAt: Point | null = null;
/** Its label shows on this side (the window is wider then), or not at all. */
let labelSide: "left" | "right" | null = null;
let drag: { grab: Point; start: Point; travel: number; timer: NodeJS.Timeout; safety: NodeJS.Timeout } | null = null;

/** The tutor is on: it follows the cursor. */
let on = false;
let turning = false;
/** The student paused the tutor from a dock: nothing is followed, glanced at or read until Play. */
let held = false;
/** The lesson's page has a dock of its own (companion-dock), so the blob may hide while on. */
let pageDock = false;
/** Screen Recording is off (the blob shows "!"), or this Mac cannot read other apps at all
 *  (`blockedBy`: which, for its label). */
let blocked = false;
let blockedBy: "screen" | "unavailable" = "screen";
/** The first lesson of this companion session has greeted the student; later ones start quietly. */
let greeted = false;
let offTimer: NodeJS.Timeout | undefined;
let lookTimer: NodeJS.Timeout | undefined;
/** The blob fading out before its window hides (syncBlobWindow): it looks "hidden" meanwhile. */
let blobGoing: NodeJS.Timeout | undefined;

/** What the cursor is over, as the helper last said. */
let hovered: ScreenOver | null = null;
/** The app of each window heard of (over events), for the logs and the editor rule, and its title
 *  as of then (a browser's PDF: selectionKept). */
const windowApps = new Map<number, { app: string; bundle: string; title: string }>();
/** Windows never read: a private app's, or one under secure input. */
const privateWindows = new Set<number>();
const privateLogged = new Set<number>();

/** A window's latest glance (a fast read, or the lesson's own accurate one), in screen points.
 *  `stale`: it has scrolled or changed since. */
interface Glance {
  read: ScreenRead;
  at: number;
  stale: boolean;
}
const glances = new Map<number, Glance>();
/** The glances the page holds, as last sent (in its points of the time). */
const pageHas = new Set<number>();
/** Glances being taken, by window; `again`: wanted afresh once this one is in (`keepAgain`: by
 *  the tap's own new look, so the card stays). */
const inFlight = new Map<number, { again: boolean; keepAgain: boolean }>();
let dwell: NodeJS.Timeout | undefined;
const afterScroll = new Map<number, NodeJS.Timeout>();
/** The last glance a "changed" brought on, by window, and the one waiting its turn (CHANGED_GLANCE_MS). */
const changedGlance = new Map<number, { at: number; timer?: NodeJS.Timeout; keepCard?: boolean }>();
/** A careful read taken from a tap's release (startCarefulRead): the release it is for (`id`; null
 *  once its card went without a pick), its window, the read, when it began (`at`, Date.now()),
 *  whether the window has scrolled or changed since it began (`stale`), and whether it is in. */
interface CarefulRead {
  id: number | null;
  window: number;
  read: Promise<ScreenRead>;
  at: number;
  stale: boolean;
  done: boolean;
}
/** The careful read of the window last tapped: the one a later tap there reuses while it is on its
 *  way, and a restart of the lesson from a tap there starts from (carefulReadOf). */
let pendingRead: CarefulRead | null = null;
/** The careful reads of the latest releases, by release id (CAREFUL_KEPT of them): a card's pick
 *  starts from the read taken at its own tap, whatever was tapped or read since (explainAt). */
const carefulReads = new Map<number, CarefulRead>();
const CAREFUL_KEPT = 4;
/** When each window last scrolled or changed (Date.now()), as far as this side heard: a pick whose
 *  tap's own read is gone knows whether the window still shows what was tapped. */
const windowMoved = new Map<number, number>();
/** The tap that last opened a card: its window, and when. */
let cardTap: { window: number; at: number } | null = null;
/** The latest releases heard, by id (a few): what a tap's recording says of its clicks and cursor,
 *  when it was heard (`at`, Date.now()), and whether its press was on the page's own controls
 *  (`page`, decided at the release and kept for its verdict). */
const releases = new Map<number, ScreenRelease & { at: number; page: boolean }>();
const RELEASES_KEPT = 16;
let cursorFeed: NodeJS.Timeout | undefined;
let lastCursor: Point | null = null;
/** What the helper was last told: the windows it counts as Tutornote's, the windows it watches. */
let stopKey = "";
let observeKey = "";

const liveBlob = (): BrowserWindow | null => (blob && !blob.isDestroyed() ? blob : null);

const sameArea = (a: Rectangle | null, b: Rectangle): boolean =>
  Boolean(a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

function blobCentre(): Point {
  const at = blobAt ?? screen.getCursorScreenPoint();
  return { x: at.x + BLOB_SIZE / 2, y: at.y + BLOB_SIZE / 2 };
}

const errorCode = (e: unknown): string => (e instanceof ScreenReadError ? e.code : (e as Error)?.message ?? "failed");

// MARK: the blob

type BlobLook = "resting" | "on" | "reading" | "blocked" | "hidden";

function blobLook(): BlobLook {
  if (blobGoing) return "hidden";
  if (on) return inFlight.size > 0 ? "reading" : "on";
  return blocked ? "blocked" : "resting";
}

/** `look`: this one rather than the blob's own now (blobLook). */
function tellBlob(extra: { pop?: boolean } = {}, look: BlobLook = blobLook()): void {
  const b = liveBlob();
  if (!b) return;
  const label =
    look === "on" || look === "reading" || look === "hidden"
      ? LABELS.on
      : look === "blocked" && blockedBy === "unavailable"
        ? LABELS.unavailable
        : LABELS[look];
  const send = (): void => b.webContents.send("blob:state", { look, label, side: labelSide, ...extra });
  if (b.webContents.isLoading()) b.webContents.once("did-finish-load", send);
  else send();
}

/**
 * The bubble pop as the tutor hops out of the blob and as it lands back in it (static/sounds/
 * bubble_pop.mp3, played by the blob's page). An interface sound, so it keeps to the web app's
 * Sounds switch (lib/sound/pref.ts: "an-sounds" set to "off" in the app's own storage), read from
 * the lesson's window, which is the app's origin; with no page to ask, it plays.
 */
async function soundsOn(): Promise<boolean> {
  const w = overlayWindow();
  if (!w || w.isDestroyed() || w.webContents.isLoading()) return true;
  try {
    const said: unknown = await w.webContents.executeJavaScript(
      '(() => { try { return localStorage.getItem("an-sounds") !== "off"; } catch (e) { return true; } })()',
    );
    return said !== false;
  } catch {
    return true;
  }
}

function popSound(): void {
  void soundsOn().then((ok) => {
    const b = liveBlob();
    if (ok && b) b.webContents.send("blob:sound");
  });
}

/** The tab bar's button: the blob hidden, shown, or the tutor on. */
function tellToolbar(): void {
  appEvents.emit("companion-state", !blobShown ? "hidden" : on ? "on" : "shown");
}

/** Whether the blob's window is to be up now (companionPlace.ts blobUp). */
function blobWanted(): boolean {
  return blobUp({ shown: blobShown, on, pageDock });
}

/** The blob's window up or not, as blobWanted says, once its page has loaded (showBlob shows it
 *  then). Going, it fades out first (BLOB_FADE_MS), and takes the ring look again once hidden,
 *  for when it is back while on or for the tutor to fly home into (turnOff). */
function syncBlobWindow(): void {
  const b = liveBlob();
  if (!b || b.webContents.isLoading()) return;
  if (blobWanted()) {
    if (blobGoing) {
      clearTimeout(blobGoing);
      blobGoing = undefined;
      // (the ring, as before its fade began; turnOff gives it its resting look as the tutor lands)
      tellBlob({}, "on");
    }
    if (!b.isVisible()) {
      b.showInactive();
      // (Windows has one always-on-top band: the blob back at its top, over the lesson's layer)
      if (process.platform === "win32") b.setAlwaysOnTop(true, "floating", 2);
    }
  } else if (b.isVisible() && !blobGoing) {
    blobGoing = setTimeout(() => {
      blobGoing = undefined;
      if (!blobWanted()) liveBlob()?.hide();
      tellBlob();
    }, BLOB_FADE_MS);
    tellBlob();
  }
}

function ensureBlob(): BrowserWindow {
  const kept = liveBlob();
  if (kept) return kept;
  const created = new BrowserWindow({
    width: BLOB_SIZE,
    height: BLOB_SIZE,
    show: false,
    // A panel: a click on it never makes Tutornote the app in front (a non-activating window, as
    // Spotlight's is), so the student's keys stay with the app they are reading. focusable false
    // alone does not do that on a Mac: Electron then only keeps the window from taking the keys,
    // and the click still brings Tutornote forward (Electron 44's NativeWindowMac).
    // (Windows has no panel: a tool window stays out of the taskbar and Alt+Tab)
    type: process.platform === "win32" ? "toolbar" : "panel",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    // (moved from here: a drag of its own, below)
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // It never takes the keys either.
    focusable: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "blob.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // (its pop as the tutor hops out and lands back: popSound; no click asks for it)
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  // Above the lesson's window (floating +1) and its board (+0).
  created.setAlwaysOnTop(true, "floating", 2);
  // Over a full-screen app's Space too; once, here (screenTeach.ts ensureWindow says what it costs).
  created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hideFromCapture(created);
  created.webContents.on("will-navigate", (event) => event.preventDefault());
  created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  created.on("closed", () => {
    if (blob !== created) return;
    blob = null;
    endDrag(false);
    if (blobShown) {
      blobShown = false;
      if (on) turnOff();
      tellToolbar();
    }
  });
  void created.loadFile(path.join(app.getAppPath(), "static", "blob.html"));
  blob = created;
  return created;
}

/** Up, where the student last left it on the cursor's display, or at its bottom right. */
function showBlob(): void {
  const b = ensureBlob();
  if (!blobShown || !blobAt) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    blobAt = loadBlobPlace(display.id) ?? defaultBlobPlace(display.workArea);
  }
  labelSide = null;
  b.setBounds({ x: blobAt.x, y: blobAt.y, width: BLOB_SIZE, height: BLOB_SIZE });
  const wasShown = blobShown;
  blobShown = true;
  tellBlob({ pop: !wasShown });
  // (not while the tutor is on with a page that has its own dock)
  const show = (): void => {
    if (!blobWanted() || b.isDestroyed()) return;
    b.showInactive();
    // (Windows has one always-on-top band: the blob at its top, over the lesson's layer)
    if (process.platform === "win32") b.setAlwaysOnTop(true, "floating", 2);
  };
  if (b.webContents.isLoading()) b.webContents.once("did-finish-load", show);
  else show();
  sendStop();
  tellToolbar();
}

/** Out of the way; the tutor goes off with it. The tab bar's button or ⌃⌥E brings it back. */
function hideBlob(): void {
  if (on) turnOff();
  endDrag(false);
  blobShown = false;
  labelSide = null;
  liveBlob()?.hide();
  tellToolbar();
}

/** The blob's window: the blob alone, or with room for its label beside it. */
function placeBlob(): void {
  const b = liveBlob();
  if (!b || !blobAt) return;
  if (labelSide) {
    const display = screen.getDisplayNearestPoint(blobCentre());
    b.setBounds(labelBounds(blobAt, display.workArea).bounds);
  } else {
    b.setBounds({ x: Math.round(blobAt.x), y: Math.round(blobAt.y), width: BLOB_SIZE, height: BLOB_SIZE });
  }
}

/** A display went, or changed its size or arrangement: the blob is brought back whole on to the
 *  nearest one's work area. macOS moves a window off a display that went, but the place kept here
 *  is where the next hover or drag would put it back, off every screen. Not saved: the student
 *  did not move it, and the display may come back. */
function reclampBlob(): void {
  if (!liveBlob() || !blobAt || !blobShown || drag) return;
  const display = screen.getDisplayNearestPoint(blobCentre());
  const next = clampBlobPlace(blobAt, display.workArea);
  if (next.x === blobAt.x && next.y === blobAt.y) return;
  blobAt = next;
  labelSide = null;
  placeBlob();
  tellBlob();
}

function onHover(hover: boolean): void {
  if (!blobAt || drag) return;
  if (hover) {
    const display = screen.getDisplayNearestPoint(blobCentre());
    labelSide = labelBounds(blobAt, display.workArea).side;
    tellBlob();
    placeBlob();
  } else if (labelSide) {
    labelSide = null;
    placeBlob();
    tellBlob();
  }
}

/*
  The drag. The page says when the button goes down and up; between the two, this side moves the
  window after the cursor 60 times a second, from where it was taken hold of. A release that has
  hardly moved it is a click. A -webkit-app-region drag area would move it too, but the click that
  turns the tutor on would never reach the page.
*/
function startDrag(): void {
  const b = liveBlob();
  if (!b || !blobAt || drag) return;
  if (labelSide) {
    labelSide = null;
    placeBlob();
    tellBlob();
  }
  const cursor = screen.getCursorScreenPoint();
  const start = { ...blobAt };
  const grab = { x: cursor.x - start.x, y: cursor.y - start.y };
  const timer = setInterval(() => {
    const now = screen.getCursorScreenPoint();
    const next = { x: now.x - grab.x, y: now.y - grab.y };
    if (!blobAt || !drag || (next.x === blobAt.x && next.y === blobAt.y)) return;
    blobAt = next;
    drag.travel = Math.max(drag.travel, Math.hypot(next.x - start.x, next.y - start.y));
    liveBlob()?.setPosition(Math.round(next.x), Math.round(next.y));
  }, FRAME_MS);
  const safety = setTimeout(() => endDrag(false), DRAG_SAFETY_MS);
  drag = { grab, start, travel: 0, timer, safety };
}

/** The drag is over: a click (`asClick`, hardly moved) turns the tutor on or off; a drag leaves the
 *  blob on the display it was dropped on, whole on its work area, and is kept for next time. */
function endDrag(asClick: boolean): void {
  const ended = drag;
  if (!ended) return;
  drag = null;
  clearInterval(ended.timer);
  clearTimeout(ended.safety);
  if (!blobAt) return;
  if (asClick && ended.travel < CLICK_TRAVEL) {
    blobAt = ended.start;
    placeBlob();
    toggle();
    return;
  }
  const display = screen.getDisplayNearestPoint(blobCentre());
  blobAt = clampBlobPlace(blobAt, display.workArea);
  placeBlob();
  saveBlobPlace(display.id, blobAt);
}

function showMenu(): void {
  const b = liveBlob();
  if (!b) return;
  endDrag(false);
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(on ? [{ label: "Turn off", click: () => turnOff() }] : []),
    { label: "Hide the tutor", click: () => hideBlob() },
  ];
  Menu.buildFromTemplate(template).popup({ window: b });
}

function toggle(): void {
  if (on) turnOff();
  else void turnOn();
}

// MARK: on and off

/** Tutornote's own windows the helper cannot tell by their app (they float), and the main window
 *  (a development build runs as Electron): never read, never helped with. Not the lesson's window,
 *  which covers the whole display and lets every click through. */
function stopIds(): number[] {
  const ids = new Set<number>();
  for (const w of [liveBlob(), boardWindow(), getMainWindow(), screenPanelWindow()]) {
    if (!w || w.isDestroyed()) continue;
    const id = windowIdOf(w.getMediaSourceId());
    if (id !== null) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** Tell the helper the companion is on, with the windows it is to count as Tutornote's (again
 *  whenever they change: a window gets its id once it has been on screen). */
function sendStop(force = false): void {
  // (held: the helper hears nothing of the companion until Play, which tells it again)
  if (!on || held) return;
  const ids = stopIds();
  const key = ids.join(",");
  if (!force && key === stopKey) return;
  stopKey = key;
  // (and the apps it never takes a picture of, even for a tap, and the readers)
  companionWatch(true, ids, [...PRIVATE_APPS], [...READER_APPS]);
}

/** Watch the lesson's window and the one under the cursor for a new look (two at most; held, the
 *  lesson's alone). */
function refreshObserve(): void {
  if (!on) return;
  const lessonWindow = screenTeachLesson()?.window ?? null;
  const under = hovered && !held && !hovered.own && hovered.window !== null && !privateWindows.has(hovered.window) ? hovered.window : null;
  const wanted = [lessonWindow, under];
  const ids = [...new Set(wanted.filter((w): w is number => w !== null))];
  const key = ids.join(",");
  if (key === observeKey) return;
  observeKey = key;
  observeWindows(ids);
}

async function turnOn(): Promise<void> {
  if (on || turning) return;
  turning = true;
  try {
    if (!blobShown) showBlob();
    // Clicked as its "!" asks, once Screen Recording was switched on: that counts only for a
    // helper started after it (screen.ts restartScreenHelper), as for the panel's Try again.
    if (blocked) restartScreenHelper();
    if (!(await ensureScreenReading("companion"))) {
      blocked = true;
      blockedBy = screenReadingAvailable() ? "screen" : "unavailable";
      tellBlob();
      return;
    }
    blocked = false;
    if (on) return;
    clearTimeout(offTimer);
    clearTimeout(lookTimer);
    // The cursor's display; a lesson already on (a pick) keeps its own.
    const lessonArea = screenTeachLesson() ? overlayWindow()?.getBounds() : undefined;
    const area = lessonArea ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    on = true;
    held = false;
    greeted = false;
    const first = !companionTipped();
    showCompanionOverlay(area, blobCentre(), first);
    // (the tutor hops out of the blob: its pop)
    popSound();
    if (first) markCompanionTipped();
    stopKey = "";
    observeKey = "";
    sendStop(true);
    tellBlob();
    // The tutor hops out; the blob goes once it has, and the page's dock is the control (a page
    // with none keeps the blob up as a ring).
    setTimeout(syncBlobWindow, BLOB_HANDOFF_MS);
    tellToolbar();
    console.log("[companion] on");
  } finally {
    turning = false;
  }
}

/** The tutor flies home into the blob, any lesson stops, the marks and the board go. */
function turnOff(): void {
  if (!on) {
    if (blocked) {
      blocked = false;
      tellBlob();
    }
    return;
  }
  on = false;
  held = false;
  // The blob is back (still the ring) for the tutor to fly into; it pops into its resting look as
  // the tutor lands when it had been away while on.
  const wasAway = Boolean(liveBlob() && !liveBlob()?.isVisible());
  syncBlobWindow();
  const overlay = companionArea();
  const home = localPoint(blobCentre());
  if (overlay && home) {
    sendToPage("screen-teach:companion", { on: false, overlay: { x: overlay.x, y: overlay.y, w: overlay.width, h: overlay.height }, first: false, to: home });
  }
  closeScreenTeach();
  companionWentOff();
  // (Tutornote's own floating windows stay known: the helper looks through only the lesson's layer)
  companionWatch(false, stopIds());
  observeWindows([]);
  clearCaches();
  clearTimeout(offTimer);
  offTimer = setTimeout(() => {
    if (!on) hideCompanionOverlay();
  }, HOME_MS);
  // The tutor is back in the blob once it has flown there.
  clearTimeout(lookTimer);
  lookTimer = setTimeout(() => {
    tellBlob(wasAway ? { pop: true } : {});
    // (the tutor lands back in the blob: its pop)
    popSound();
  }, HOME_LOOK_MS);
  tellToolbar();
  console.log("[companion] off");
}

/*
  The student paused the tutor from a dock (held), or played it on. Held: the dwell, the glances
  after a scroll or a new look and the card's careful read go, and the helper is told the
  companion is off, so it says no window under the cursor, no press, and no tap but on the
  lesson's own window (heard as with no companion). It still watches the lesson's window for a
  new look (refreshObserve), so a page of it turned meanwhile is followed as it settles. The
  cursor is still fed while the page wants it: the page follows nothing with it, but its dock
  takes clicks only while the page knows the cursor is over it (Play, ×). Play: the helper is
  told again, and the page what the cursor is over.
*/
function setHeld(value: boolean): void {
  if (!on || held === value) return;
  held = value;
  if (held) {
    clearTimeout(dwell);
    for (const timer of afterScroll.values()) clearTimeout(timer);
    afterScroll.clear();
    for (const kept of changedGlance.values()) clearTimeout(kept.timer);
    changedGlance.clear();
    pendingRead = null;
    carefulReads.clear();
    cardTap = null;
    companionWatch(false, stopIds());
    stopKey = "";
    observeKey = "";
    refreshObserve();
  } else {
    sendStop(true);
    observeKey = "";
    refreshObserve();
    pageHas.clear();
    if (hovered) onOver(hovered);
  }
  console.log(`[companion] ${held ? "paused" : "playing"}`);
}

/** Screen Recording went off (switched off, or its consent lapsed) while the tutor was on: every
 *  glance and read fails from now on. The tutor goes off, the blob shows "!", and the panel says
 *  how to switch it on again (its Try again, or a click on the blob, turns the tutor back on). */
function screenRecordingLost(): void {
  if (!on) return;
  console.warn("[companion] Screen Recording is off: the tutor is off");
  turnOff();
  blocked = true;
  blockedBy = "screen";
  tellBlob();
  void ensureScreenReading("companion");
}

function clearCaches(): void {
  clearTimeout(dwell);
  for (const timer of afterScroll.values()) clearTimeout(timer);
  afterScroll.clear();
  for (const kept of changedGlance.values()) clearTimeout(kept.timer);
  changedGlance.clear();
  glances.clear();
  pageHas.clear();
  inFlight.clear();
  windowApps.clear();
  privateWindows.clear();
  privateLogged.clear();
  pendingRead = null;
  carefulReads.clear();
  windowMoved.clear();
  cardTap = null;
  releases.clear();
  hovered = null;
  stopKey = "";
  observeKey = "";
  feedCursor(false);
}

// MARK: hover and glances

/** The cursor went to another display with no lesson on: the window follows it there, and the
 *  page gets its glances again in its new points. During a lesson it stays on the lesson's. The
 *  area the window covers is screenTeach.ts's to say (companionArea): a lesson started from a
 *  pick meanwhile may have moved it. */
function followDisplay(): void {
  const area = companionArea();
  if (!on || !area || screenTeachLesson()) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (sameArea(area, display.workArea)) return;
  moveTo(display.workArea);
}

function moveTo(area: Rectangle): void {
  moveCompanionOverlay(area);
  pageHas.clear();
  const window = hovered?.window;
  const kept = window != null ? glances.get(window) : undefined;
  if (window != null && kept) sendGlance(window, kept);
}

/** `keepCard`: the glance is of the new look the card's own tap brought on (onChanged): the page
 *  keeps the card. `tap`: it is the careful read taken at that release (startCarefulRead). `empty`:
 *  a read with no lines found again on the second look (GLANCE_AGAIN_MS): the window is blank now,
 *  and the page lets it replace a glance with lines (one with no lines otherwise never does). */
function sendGlance(window: number, glance: Glance, keepCard = false, tap?: number, empty = false): void {
  const read = localRead(glance.read);
  if (!read) return;
  sendToPage("screen-teach:glance", {
    window,
    read,
    ground: glance.read.ground ?? 1,
    fast: glance.read.level === "fast",
    ...(keepCard ? { keepCard: true } : {}),
    ...(tap !== undefined ? { tap } : {}),
    ...(empty ? { empty: true } : {}),
  });
  pageHas.add(window);
}

function onOver(over: ScreenOver): void {
  if (!on) return;
  hovered = over;
  if (held) return;
  clearTimeout(dwell);
  followDisplay();
  const window = over.window;
  if (window === null) {
    sendToPage("screen-teach:over", over.own ? { window: null, own: true } : { window: null });
    refreshObserve();
    return;
  }
  if (windowApps.size >= WINDOWS_KEPT) windowApps.clear();
  windowApps.set(window, { app: over.app, bundle: over.bundle, title: over.title });
  if (isPrivateApp(over.bundle) || over.secure) {
    privateWindows.add(window);
    glances.delete(window);
    sendToPage("screen-teach:over", { window, private: true });
    if (!privateLogged.has(window)) {
      privateLogged.add(window);
      console.log(`[companion] private window ${over.bundle || over.app}${over.secure ? " (secure input)" : ""}`);
    }
    refreshObserve();
    return;
  }
  privateWindows.delete(window);
  sendToPage("screen-teach:over", { window });
  refreshObserve();
  const kept = glances.get(window);
  // A window moved since its glance (dragged by its title bar, same size: no new look) is read
  // again where it is now, or a tap there would be judged against words that are no longer there.
  const was = kept?.read.frame;
  const f = over.frame;
  if (kept && was && f && (Math.abs(was.x - f.x) > 1 || Math.abs(was.y - f.y) > 1 || Math.abs(was.w - f.w) > 1 || Math.abs(was.h - f.h) > 1)) {
    kept.stale = true;
    markReadStale(window);
  }
  if (kept && !kept.stale) {
    if (!pageHas.has(window)) sendGlance(window, kept);
    return;
  }
  // The lesson's own reads keep its window's glance (screen-teach-read).
  if (window === screenTeachLesson()?.window) return;
  dwell = setTimeout(() => {
    if (on && hovered?.window === window) void glance(window);
  }, DWELL_MS);
}

/** A fast read of `window`, for the pointer and the page's targeting: one at a time per window,
 *  the latest wanted winning. `keepCard`: for the new look the card's own tap brought on
 *  (sendGlance). `retry`: the second try after one that found no words (GLANCE_AGAIN_MS). */
async function glance(window: number, opts: { keepCard?: boolean; retry?: boolean } = {}): Promise<void> {
  if (!on || held || privateWindows.has(window)) return;
  const going = inFlight.get(window);
  if (going) {
    going.again = true;
    if (opts.keepCard) going.keepAgain = true;
    return;
  }
  const mine = { again: false, keepAgain: false };
  inFlight.set(window, mine);
  tellBlob();
  // (the dots by the tutor, the first time over this window)
  if (hovered?.window === window && !pageHas.has(window)) sendToPage("screen-teach:over", { window, reading: true });
  let failed = false;
  try {
    const read = await readWindow(window, { fast: true });
    if (!on || inFlight.get(window) !== mine) return;
    if (isPrivateApp(read.bundle)) {
      privateWindows.add(window);
      return;
    }
    if (!mine.again) {
      // A read that found no words (a window still drawing, a page mid-turn) never replaces one
      // that found some: the last is kept, and the window is glanced at once more a moment later.
      // That second look finding none either is the window as it is now (blank): it is the
      // window's glance then, sent as `empty` so the page lets it replace the one with lines.
      const emptyAgain = !read.lines.length && opts.retry === true;
      if (!read.lines.length && glances.get(window)?.read.lines.length && !emptyAgain) {
        console.log(`[companion] glance ${read.app}: 0 lines, kept the last`);
        setTimeout(() => {
          if (on && !held) void glance(window, { keepCard: opts.keepCard, retry: true });
        }, GLANCE_AGAIN_MS);
        return;
      }
      const kept: Glance = { read, at: Date.now(), stale: false };
      glances.set(window, kept);
      sendGlance(window, kept, opts.keepCard, undefined, emptyAgain);
      const f = read.frame;
      console.log(
        `[companion] glance ${read.app}, window ${window} at ${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.w)}x${Math.round(f.h)}: ` +
          `${read.lines.length} lines, capture ${read.captureMs} ms, text ${read.ocrMs} ms (${read.level ?? "accurate"})` +
          (emptyAgain ? ", none again on the second look" : ""),
      );
    }
  } catch (e) {
    failed = true;
    const code = errorCode(e);
    if (code === "window_gone") glances.delete(window);
    console.warn(`[companion] glance failed: ${code}`);
    if (code === "no_permission") screenRecordingLost();
  } finally {
    if (inFlight.get(window) === mine) inFlight.delete(window);
    tellBlob();
    // (the dots go: nothing came)
    if (failed && on && hovered?.window === window) sendToPage("screen-teach:over", { window });
    if (mine.again && on) void glance(window, { keepCard: mine.keepAgain });
  }
}

/** The lesson read its window accurately (its start, a turn, a reread): that is its glance now. */
function onLessonRead(read: unknown): void {
  if (!on || typeof read !== "object" || read === null) return;
  const r = read as ScreenRead;
  if (typeof r.window !== "number" || !Array.isArray(r.lines)) return;
  const kept: Glance = { read: r, at: Date.now(), stale: false };
  glances.set(r.window, kept);
  sendGlance(r.window, kept);
  refreshObserve();
}

// MARK: press, tap, scroll, changed

function onPress(press: ScreenPress): void {
  if (!on || held || privateWindows.has(press.window) || overlayInteractive()) return;
  followDisplay();
  const local = localPoint(press);
  if (local) sendToPage("screen-teach:press", { window: press.window, x: local.x, y: local.y });
}

/*
  A tap ended on another app's window (the helper's "release", told before the tap is judged). The
  page hears it at once with where it goes (companionPlace.ts tapRoute, before anything is known of
  what the click did): on words it paints the card in that same frame; on a margin, or under a
  pointing hand (a link), it waits for the verdict (onTap). A tap on the lesson's own window is
  the lesson's to place (lesson, run); on a private window, the card says only that it is skipped.
  A plain click in an editor, or on the page's own controls, is nobody's here: the helper looks
  through the page's window, so a click on its card or its dock comes as a release on the window
  under it, the lesson's too. That is decided once, now, and kept for the verdict (onTap), by
  which time the cursor may well be over a card painted at this release.
  The careful read starts now (startCarefulRead), so the lesson's words are ready by the time the
  student picks: for every card, and on the lesson's window for a tap off the words it has read.
  Not for a double click: its verdict takes any card away (but in a reader, selectionKept), and its
  first click's read is on its way.
*/
function onRelease(release: ScreenRelease): void {
  if (!on || held) return;
  const page = pressWasThePage() || overlayInteractive();
  releases.set(release.id, { ...release, at: Date.now(), page });
  if (releases.size > RELEASES_KEPT) {
    const oldest = releases.keys().next().value;
    if (oldest !== undefined) releases.delete(oldest);
  }
  const info = windowApps.get(release.window);
  const lessonNow = screenTeachLesson();
  const route = tapRoute({
    onLesson: !page && release.window === lessonNow?.window,
    onPage: page,
    private: release.private || privateWindows.has(release.window) || isPrivateApp(info?.bundle),
    acted: false,
    editor: isEditorApp(info?.bundle),
    alt: release.alt,
  });
  if (route === "page" || route === "editor") return;
  const local = localPoint(release);
  if (!local) return;
  sendToPage("screen-teach:companion-release", {
    id: release.id,
    window: release.window,
    x: local.x,
    y: local.y,
    alt: release.alt,
    hand: release.hand,
    clicks: release.clicks,
    lesson: route === "lesson",
    ...(route === "lesson" && lessonNow ? { run: lessonNow.run } : {}),
    ...(route === "private" ? { private: true } : {}),
  });
  if (route === "private" || release.clicks >= 2) return;
  // (on the lesson's words, the lesson has its read)
  if (route === "lesson" && tapOnWords(glances.get(release.window)?.read.lines ?? [], release)) return;
  startCarefulRead(release.id, release.window);
}

/** Read `window` carefully for the tap `id` (the lesson its card's pick starts), unless a read of
 *  it begun since its last scroll or new look is still on its way: that one is this tap's too.
 *  In, and still the one wanted, it is the window's glance, sent with the tap's id (the page places
 *  a card it opened with no glance by it), and with keepCard: a page older than the words rule
 *  closes its card on any other glance of the card's window, and this one is of the card's own
 *  tap. Never replaces a glance with words by one with none, nor is a glance at all once the window
 *  has scrolled or changed since it began (its lines are no longer where it says): it is kept for
 *  its tap's pick alone then, which starts from it where the student tapped (stale). */
function startCarefulRead(id: number | null, window: number): void {
  const going = pendingRead && pendingRead.window === window && !pendingRead.stale && !pendingRead.done ? pendingRead : null;
  const read = going?.read ?? readWindow(window);
  if (!going) read.catch(() => undefined);
  const mine: CarefulRead = { id, window, read, at: going?.at ?? Date.now(), stale: false, done: false };
  pendingRead = mine;
  if (id !== null) {
    carefulReads.set(id, mine);
    if (carefulReads.size > CAREFUL_KEPT) {
      const oldest = carefulReads.keys().next().value;
      if (oldest !== undefined) carefulReads.delete(oldest);
    }
  }
  read.then(
    (r) => {
      mine.done = true;
      if (pendingRead !== mine || !on || held) return;
      if (isPrivateApp(r.bundle)) {
        privateWindows.add(window);
        return;
      }
      const waited = r.heldMs ? `, held ${r.heldMs} ms for a tap being judged` : "";
      if (mine.stale) {
        console.log(`[companion] careful read for the tap: the window moved meanwhile, kept for its pick only${waited}`);
        return;
      }
      if (!r.lines.length && glances.get(window)?.read.lines.length) {
        console.log("[companion] careful read for the tap: 0 lines, kept the last glance");
        return;
      }
      const kept: Glance = { read: r, at: Date.now(), stale: false };
      glances.set(window, kept);
      sendGlance(window, kept, true, id ?? undefined);
      console.log(
        `[companion] careful read for the tap: ${r.lines.length} lines, text ${r.ocrMs} ms${waited}${going ? " (one already on its way)" : ""}`,
      );
    },
    () => {
      mine.done = true;
    },
  );
}

/*
  The verdict on a tap, a moment after its release (main.swift companionTap): whether the click did
  something in its app, with what the words at the tap said (tapNumbers). One its app used (a link,
  a button, a page turn, a menu; "acted") or a double click (words selected; "select"): a card the
  page opened at the release goes at once (companion-withdraw), and the careful read taken for it
  with it. An Option click is always the tutor's, but for a double click. A double click in a
  reader, or on a PDF in a browser (companionPlace.ts selectionKept), is the student pointing at a
  word, not the app's: its card stays (or opens there) and its careful read is kept, the window's
  title being the one known for it (the glance's, as recordTap's, else the cursor's last over).
  Otherwise, where a card is wanted, the page hears the tap again (companion-tap, the release's
  id), to open the card now if
  it waited for this (a margin, a pointing hand). Whether the click was on the page's own controls
  is what was decided at its release (onRelease): by now the cursor may be over the card painted
  then, and the verdict is still the tap's. A helper too old to say the release: the card is
  offered and the careful read starts here, as before.
*/
function onTap(tap: ScreenTap): void {
  if (!on || held) return;
  const info = windowApps.get(tap.window);
  const heard = tap.id !== undefined ? releases.get(tap.id) : undefined;
  const page = heard ? heard.page : pressWasThePage() || overlayInteractive();
  // (a selection in a reader is no doing of its app's: it goes as a tap that did nothing there)
  const kept = selectionKept({ words: tap.words, bundle: info?.bundle, title: glances.get(tap.window)?.read.title || info?.title });
  const route = tapRoute({
    onLesson: !page && tap.window === screenTeachLesson()?.window,
    onPage: page,
    private: privateWindows.has(tap.window) || isPrivateApp(info?.bundle),
    acted: tap.acted && !kept,
    editor: isEditorApp(info?.bundle),
    alt: tap.alt,
  });
  if (route !== "private" && route !== "page") recordTap(tap, info);
  if (kept && route === "card") {
    console.log(`[companion] tap in ${info?.app || "another app"}: ${tap.words}${tapNumbers(tap)} (selection in a reader: kept)`);
  }
  if (route === "acted" || (route === "card" && tap.words === "select" && !kept)) {
    console.log(`[companion] tap acted in ${info?.app || "another app"}${tap.words ? `: ${tap.words}` : ""}${tapNumbers(tap)}`);
    if (tap.id !== undefined) {
      sendToPage("screen-teach:companion-withdraw", { id: tap.id, why: tap.words ?? "acted", window: tap.window });
      if (pendingRead?.id === tap.id) pendingRead = null;
      carefulReads.delete(tap.id);
    }
    return;
  }
  if (route !== "card") return;
  const local = localPoint(tap);
  if (!local) return;
  sendToPage("screen-teach:companion-tap", { window: tap.window, x: local.x, y: local.y, ...(tap.id !== undefined ? { id: tap.id } : {}) });
  cardTap = { window: tap.window, at: Date.now() };
  if (tap.id === undefined) startCarefulRead(null, tap.window);
}

/*
  Tap recordings, for checking where taps land offline (the web app's scripts/tap-replay.ts): with
  TUTORNOTE_TAP_LOG=1 in the environment, each verdict on a window that is not private is written
  to userData/taps/<time>.json with the glance the page had of the window and the careful read
  taken for the tap (once in), everything in screen points; the newest TAPS_KEPT are kept. Off
  unless asked for: the files hold the words read, so a packaged app never writes them however the
  environment is set (WHAT_TO_FIX.md WIN-02 / MAC-02).
*/
const TAP_LOG = !app.isPackaged && process.env.TUTORNOTE_TAP_LOG === "1";
const TAPS_KEPT = 200;
let tapFolderSaid = false;

function recordTap(tap: ScreenTap, info: { app: string; bundle: string } | undefined): void {
  if (!TAP_LOG) return;
  const glanced = glances.get(tap.window)?.read ?? null;
  const careful =
    tap.id !== undefined
      ? (carefulReads.get(tap.id)?.read ?? null)
      : pendingRead && pendingRead.window === tap.window
        ? pendingRead.read
        : null;
  const release = tap.id !== undefined ? releases.get(tap.id) : undefined;
  void writeTap(tap, release, glanced, careful, info);
}

async function writeTap(
  tap: ScreenTap,
  release: ScreenRelease | undefined,
  glanced: ScreenRead | null,
  careful: Promise<ScreenRead> | null,
  info: { app: string; bundle: string } | undefined,
): Promise<void> {
  const at = new Date().toISOString();
  const read = careful ? await careful.catch(() => null) : null;
  const about = read ?? glanced;
  const { x, y, alt, window: _window, ...verdict } = tap;
  const record = {
    at,
    app: about?.app ?? info?.app ?? "",
    bundle: about?.bundle ?? info?.bundle ?? "",
    title: about?.title ?? "",
    frame: about?.frame ?? null,
    tap: { x, y, alt, clicks: release?.clicks ?? 1, hand: release?.hand ?? false },
    verdict,
    glance: glanced?.lines ?? null,
    careful: read?.lines ?? null,
  };
  const folder = path.join(app.getPath("userData"), "taps");
  try {
    await mkdir(folder, { recursive: true });
    if (!tapFolderSaid) {
      tapFolderSaid = true;
      console.log(`[companion] tap recordings in ${folder}`);
    }
    // (the time with its colons as dashes: a file name Finder shows as it is)
    await writeFile(path.join(folder, `${at.replace(/:/g, "-")}.json`), JSON.stringify(record));
    const kept = (await readdir(folder)).filter((name) => name.endsWith(".json")).sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - TAPS_KEPT))) await unlink(path.join(folder, old)).catch(() => undefined);
  } catch (e) {
    console.warn(`[companion] tap recording failed: ${(e as Error).message}`);
  }
}

/** The careful reads for taps on `window` no longer show it as it is (it scrolled, or it changed):
 *  a pick still starts from its tap's, where the student tapped, and the page reads the window
 *  again once the lesson is up (stale); a new tap there reads the window afresh. */
function markReadStale(window: number): void {
  if (pendingRead?.window === window) pendingRead.stale = true;
  for (const kept of carefulReads.values()) if (kept.window === window) kept.stale = true;
  if (windowMoved.size >= WINDOWS_KEPT) windowMoved.clear();
  windowMoved.set(window, Date.now());
}

/** The careful read of `window` begun at `since` or later (Date.now() ms) that still shows it as
 *  it is, or null: screenTeach.ts restarts its lesson from a tap on words it has not read with the
 *  one taken at that tap's release, rather than reading the window again behind it (restartAt). */
function carefulReadOf(window: number, since: number): Promise<ScreenRead> | null {
  const kept = pendingRead;
  return on && !held && kept && kept.window === window && !kept.stale && kept.at >= since ? kept.read : null;
}

function onScroll(scroll: ScreenScroll): void {
  if (!on || held || privateWindows.has(scroll.window)) return;
  markReadStale(scroll.window);
  // (the lesson's own window: screenTeach.ts follows it)
  if (scroll.window === screenTeachLesson()?.window) return;
  sendToPage("screen-teach:window-scroll", { window: scroll.window, dy: scroll.dy, dx: scroll.dx });
  const kept = glances.get(scroll.window);
  if (kept) kept.stale = true;
  clearTimeout(afterScroll.get(scroll.window));
  afterScroll.set(
    scroll.window,
    setTimeout(() => {
      afterScroll.delete(scroll.window);
      if (on && hovered?.window === scroll.window) void glance(scroll.window);
    }, AFTER_SCROLL_MS),
  );
}

/*
  A window settled into a new look that no wheel scroll explains (the helper leaves those out, and
  a change only in its top and bottom 12%, a reader's bars): a page turned by a key or a click,
  a scroll bar dragged. The careful read taken for a tap there is stale from now on. The lesson's
  window: the lesson follows it (screenTeach.ts tells its page, onLessonChanged, with the companion
  on or off). Any other: the page hears it (run 0 is no
  lesson's, so no lesson follows it; a card there stays while its tapped words are still there,
  which the page judges by the window's next glance), and the window is glanced at again, at most
  every CHANGED_GLANCE_MS (typing or a slideshow settle again and again). Just after the tap that
  opened the card (TAP_SETTLE_MS) that new look is the tap's own, away from the paragraph: the
  page is not told, and the glance says to keep the card (keepCard, for a page older than the
  words rule). Held, only the lesson's window is followed.
*/
function onChanged(changed: ScreenChanged): void {
  if (!on) return;
  markReadStale(changed.window);
  const lesson = screenTeachLesson();
  if (lesson && changed.window === lesson.window) return;
  if (held) return;
  const tapsOwn = cardTap?.window === changed.window && Date.now() - cardTap.at < TAP_SETTLE_MS;
  if (!tapsOwn) sendToPage("screen-teach:changed", { run: 0, window: changed.window });
  const kept = glances.get(changed.window);
  if (kept) kept.stale = true;
  if (hovered?.window === changed.window && !privateWindows.has(changed.window)) glanceAfterChange(changed.window, tapsOwn);
}

/** Glance at `window` for a new look of it: now, or once CHANGED_GLANCE_MS have passed since the
 *  last glance a new look brought on (one waits at most). `keepCard`: the new look is the card's
 *  own tap's (onChanged); one waiting keeps that only while every new look it stands for was. */
function glanceAfterChange(window: number, keepCard = false): void {
  const now = Date.now();
  const last = changedGlance.get(window);
  if (last?.timer) {
    if (!keepCard) last.keepCard = false;
    return;
  }
  const wait = last ? last.at + CHANGED_GLANCE_MS - now : 0;
  if (wait <= 0) {
    if (changedGlance.size >= WINDOWS_KEPT) changedGlance.clear();
    changedGlance.set(window, { at: now });
    void glance(window, { keepCard });
    return;
  }
  const waiting: { at: number; timer?: NodeJS.Timeout; keepCard?: boolean } = { at: last?.at ?? now, keepCard };
  waiting.timer = setTimeout(() => {
    changedGlance.set(window, { at: Date.now() });
    if (on && !held && hovered?.window === window && !privateWindows.has(window)) void glance(window, { keepCard: waiting.keepCard });
  }, wait);
  changedGlance.set(window, waiting);
}

/*
  Which document a window shows, as the helper says it while a lesson watches its window ("ident",
  screen.ts ScreenIdent: the lesson's window, its app's front window, and another app's while that
  one is in front). A window this side knows (a glance of it, or its app from "over") whose title
  changed in its letters (docIdentity.ts titleChange) shows another document: its glance and the
  careful reads taken for taps there are stale (they are the document that was there), a card on
  it goes (companion-withdraw, "another document": the page keeps one that is asking), and it is
  glanced at again when the cursor is over it. Its title here is the new one either way, so the
  reader rule for a double click (selectionKept, a browser's ".pdf") goes by the document there now.
  The lesson's own window only goes stale: what the lesson does about another document there is
  screenTeach.ts's (beginSwitch). Titles stay on this Mac and out of the log.
*/
function onIdent(ident: ScreenIdent): void {
  if (!on) return;
  const lessonWindow = screenTeachLesson()?.window ?? null;
  const told = new Map<number, string>([[ident.window, ident.title]]);
  if (ident.top !== null) told.set(ident.top, ident.topTitle);
  if (ident.other) told.set(ident.other.window, ident.other.title);
  for (const [window, title] of told) retitled(window, title, window === lessonWindow);
}

function retitled(window: number, title: string, lessonsOwn: boolean): void {
  const info = windowApps.get(window);
  const kept = glances.get(window);
  const was = kept?.read.title ?? info?.title;
  if (was === undefined || was === title) return;
  if (info) windowApps.set(window, { ...info, title });
  const another = titleChange(was, title, info?.app ?? kept?.read.app ?? "") === "letters";
  if (kept) glances.set(window, { ...kept, read: { ...kept.read, title }, stale: kept.stale || another });
  if (!another) return;
  markReadStale(window);
  if (lessonsOwn) return;
  // (the card names the release it opened for: each one heard on that window is told)
  const ids = [...releases.values()].filter((r) => r.window === window).map((r) => r.id);
  for (const id of ids) sendToPage("screen-teach:companion-withdraw", { id, why: "another document", window });
  console.log(`[companion] another document in window ${window}: its glance is stale${ids.length ? ", a card on it withdrawn" : ""}`);
  if (!held && hovered?.window === window && !privateWindows.has(window)) glanceAfterChange(window);
}

// MARK: the page's requests

/** The cursor fed to the page by this side, for when it hears no mouse moves of its own. */
function feedCursor(feed: boolean): void {
  clearInterval(cursorFeed);
  cursorFeed = undefined;
  lastCursor = null;
  // (held too: by it the page knows when the cursor is over its dock, which then takes the click)
  if (!feed || !on) return;
  cursorFeed = setInterval(() => {
    const now = screen.getCursorScreenPoint();
    if (lastCursor && lastCursor.x === now.x && lastCursor.y === now.y) return;
    lastCursor = now;
    const local = localPoint(now);
    if (local) sendToPage("screen-teach:cursor", local);
  }, FRAME_MS);
}

type ExplainAnswer = { ok: true } | { ok: false; reason: "off" | "private" | "failed" | "bad" | "no_permission" };

/** The student picked on the card: the lesson runs over that window, from where they tapped (the
 *  point as tapped, however the window has scrolled since). `tap`: the release the card opened
 *  for, whose careful read is the lesson's (carefulReads); without it, the last one taken for
 *  that window while the window has not scrolled or changed since the tap, else a read now (said
 *  stale when it has: the page realigns once the lesson is up). `row`: the tapped row's words as
 *  the page read them. */
async function explainAt(value: unknown): Promise<ExplainAnswer> {
  const p = (value ?? {}) as Record<string, unknown>;
  const choice = choiceOf(p.choice);
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!choice || typeof p.window !== "number" || !finite(p.x) || !finite(p.y)) return { ok: false, reason: "bad" };
  if (!on || held) return { ok: false, reason: "off" };
  const window = p.window;
  if (privateWindows.has(window)) return { ok: false, reason: "private" };
  const at = screenPoint({ x: p.x, y: p.y });
  if (!at) return { ok: false, reason: "off" };
  const tap = finite(p.tap) ? p.tap : undefined;
  const row = typeof p.row === "string" && p.row.trim() ? p.row.slice(0, ROW_CHARS) : undefined;
  // (the tap's own read, else the last one taken for a tap on that window, while that still shows
  // the window as it was tapped)
  const own = tap !== undefined ? carefulReads.get(tap) : undefined;
  const heard = tap !== undefined ? releases.get(tap) : undefined;
  const movedSinceTap = !own && Boolean(heard && (windowMoved.get(window) ?? 0) >= heard.at);
  const kept = own?.window === window ? own : !movedSinceTap && pendingRead && pendingRead.window === window ? pendingRead : null;
  if (kept && tap !== undefined && kept !== own) console.log(`[companion] pick for tap ${tap}: using the read taken for the window's last tap`);
  if (movedSinceTap) console.log(`[companion] pick for tap ${tap}: its read is gone and the window moved since, reading it again (stale)`);
  const asked = Date.now();
  let read: ScreenRead;
  try {
    read = kept ? await kept.read : await readWindow(window);
  } catch (e) {
    if (kept && pendingRead === kept) pendingRead = null;
    if (tap !== undefined) carefulReads.delete(tap);
    const code = errorCode(e);
    console.warn(`[companion] read for the card failed: ${code}`);
    // (the panel says how to switch Screen Recording on again; the chip alone would loop)
    if (code === "no_permission") {
      screenRecordingLost();
      return { ok: false, reason: "no_permission" };
    }
    return { ok: false, reason: "failed" };
  }
  // The window scrolled or changed while the read was taken, or since (or, read now, since the
  // tap): the page reads it again once the lesson is up.
  const stale = kept ? kept.stale : movedSinceTap;
  if (pendingRead?.window === window) pendingRead = null;
  for (const [id, taken] of carefulReads) if (taken.window === window) carefulReads.delete(id);
  console.log(`[companion] pick ${choice}: read ready after ${Date.now() - asked} ms waiting${stale ? " (stale)" : ""}`);
  // (paused meanwhile: the pick is dropped, or its lesson would start and undo the pause)
  if (!on || held) return { ok: false, reason: "off" };
  if (isPrivateApp(read.bundle)) return { ok: false, reason: "private" };
  // The lesson's window goes over the display of the window it teaches.
  const display = screen.getDisplayMatching({
    x: Math.round(read.frame.x),
    y: Math.round(read.frame.y),
    width: Math.max(1, Math.round(read.frame.w)),
    height: Math.max(1, Math.round(read.frame.h)),
  });
  if (!sameArea(companionArea(), display.workArea)) moveTo(display.workArea);
  void openScreenTeach(read, at, { choice, quiet: greeted, companion: true, ...(row ? { row } : {}), ...(stale ? { stale: true } : {}) });
  greeted = true;
  return { ok: true };
}

// MARK: install

const fromBlob = (event: IpcMainEvent): boolean => {
  const b = liveBlob();
  return Boolean(b && event.sender === b.webContents);
};

/** The lesson pages that have said they have a dock or a hold, each heard of once. */
const pagesHeard = new WeakSet<WebContents>();

/** A page loaded afresh (a reload) knows no dock and no hold until it says so: the blob is back
 *  while on until it does, and the tutor plays on. Not on companion-state, which the page also
 *  asks for while it runs (a glance it dropped, wanted again). */
function hearPage(contents: WebContents): void {
  if (pagesHeard.has(contents)) return;
  pagesHeard.add(contents);
  contents.on("did-navigate", () => {
    pageDock = false;
    syncBlobWindow();
    if (held) setHeld(false);
  });
}

export function installCompanion(): void {
  watchEvents.on("over", onOver);
  watchEvents.on("press", onPress);
  watchEvents.on("release", onRelease);
  watchEvents.on("tap", onTap);
  watchEvents.on("scroll", onScroll);
  watchEvents.on("changed", onChanged);
  // (another document in a window it knows, while a lesson watches one)
  watchEvents.on("ident", onIdent);
  appEvents.on("screen-teach-read", onLessonRead);
  // (a lesson restarted from a tap on its window starts from the read taken at that tap's release)
  useCarefulReads(carefulReadOf);
  // A lesson started or ended: its window is watched for a new look, or no longer.
  appEvents.on("screen-teach-closed", () => refreshObserve());
  // The page started (again), or its window moved to another display with a pick's lesson: it is
  // told what the cursor is over, and its glance, in its points of now.
  const tellPageAgain = (): void => {
    pageHas.clear();
    if (on && hovered) onOver(hovered);
  };
  appEvents.on("screen-teach-companion-asked", tellPageAgain);
  appEvents.on("screen-teach-moved", tellPageAgain);
  // The lesson's window is gone (its page failed): the tutor is off; the blob stays (a new page
  // says again whether it has a dock).
  appEvents.on("screen-teach-gone", () => {
    pageDock = false;
    if (!on) return;
    console.warn("[companion] the lesson's window went: the tutor is off");
    turnOff();
  });
  // The tab bar's button: the tutor on or off.
  appEvents.on("companion-blob", () => (on ? turnOff() : void turnOn()));
  // The panel's Try again, after Screen Recording was switched on.
  appEvents.on("companion-retry", () => void turnOn());

  // Any window of Tutornote's that comes on screen gets its id then: the helper counts it as its own.
  app.on("browser-window-created", (_event, created) => {
    created.on("show", () => setImmediate(() => sendStop()));
  });
  // The lesson's board window is no BrowserWindow (it raises no browser-window-created): it says
  // itself when it shows. (In a tab of the main window it is the main window's.)
  appEvents.on("screen-board-shown", () => setImmediate(() => sendStop()));
  // Windows has one always-on-top band (the levels' order is the Mac's only): each time the board
  // shows or comes forward, the blob goes back above it and the lesson's window (screenTeach.ts).
  appEvents.on("screen-board-raised", () => {
    const b = liveBlob();
    if (process.platform === "win32" && b && b.isVisible()) b.setAlwaysOnTop(true, "floating", 2);
  });
  // A display unplugged or rearranged: the blob stays on a screen.
  screen.on("display-removed", () => reclampBlob());
  screen.on("display-metrics-changed", () => reclampBlob());

  // Mac only: on Windows Ctrl+Alt+E is AltGr+E, the euro sign on many keyboards, and a global
  // shortcut would take it from every app. There the tab bar's button and the blob turn the tutor on.
  if (
    process.platform === "darwin" &&
    !globalShortcut.register(SHORTCUT, () => {
      if (!blobShown) showBlob();
      toggle();
    })
  ) {
    console.warn(`[companion] ${SHORTCUT} is taken by another app; use the tab bar's button`);
  }

  ipcMain.on("blob:ready", (event) => {
    if (fromBlob(event)) tellBlob();
  });
  ipcMain.on("blob:drag-start", (event) => {
    if (fromBlob(event)) startDrag();
  });
  ipcMain.on("blob:drag-end", (event) => {
    if (fromBlob(event)) endDrag(true);
  });
  ipcMain.on("blob:toggle", (event) => {
    if (fromBlob(event)) toggle();
  });
  ipcMain.on("blob:menu", (event) => {
    if (fromBlob(event)) showMenu();
  });
  ipcMain.on("blob:hover", (event, hover: unknown) => {
    if (fromBlob(event) && typeof hover === "boolean") onHover(hover);
  });

  // From the lesson's page (screenTeach.ts companion mode): the card's pick, the card closed, and
  // the cursor fed from here while the page hears no mouse moves of its own.
  ipcMain.handle("screen-teach:explain-at", (event, value: unknown): Promise<ExplainAnswer> => {
    if (!fromScreenTeachPage(event)) throw new Error("not allowed");
    return explainAt(value);
  });
  // The card went without a pick: its read is no longer any tap's (a read still on its way is
  // kept for the next tap on that window).
  ipcMain.on("screen-teach:card-closed", (event) => {
    if (fromScreenTeachPage(event) && pendingRead) pendingRead.id = null;
  });
  ipcMain.on("screen-teach:cursor-feed", (event, from: unknown) => {
    if (!fromScreenTeachPage(event) || (from !== "main" && from !== "page")) return;
    feedCursor(from === "main");
  });
  // The page's dock (companion mode): its × turns the tutor off (not only the lesson), its pause
  // holds the whole tutor until Play, and the page says it has a dock at all (the blob may hide
  // while on then).
  ipcMain.on("screen-teach:companion-off", (event) => {
    if (!fromScreenTeachPage(event)) return;
    turnOff();
  });
  ipcMain.on("screen-teach:companion-hold", (event, value: unknown) => {
    if (!fromScreenTeachPage(event)) return;
    hearPage(event.sender);
    setHeld(value === true);
  });
  ipcMain.on("screen-teach:companion-dock", (event, value: unknown) => {
    if (!fromScreenTeachPage(event)) return;
    hearPage(event.sender);
    pageDock = value === true;
    syncBlobWindow();
  });

  app.on("will-quit", () => {
    feedCursor(false);
    if (on) companionWatch(false, []);
  });
}
