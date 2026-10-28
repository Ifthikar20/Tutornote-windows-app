import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, type IpcMainEvent, type Rectangle } from "electron";
import path from "node:path";
import { appEvents } from "./events";
import { hideFromCapture, readWindowAt, requestScreenAccess, restartScreenHelper, screenAllowed, ScreenReadError, screenReadingAvailable, type ScreenRead } from "./screen";
import { closeScreenTeach, openScreenTeach, screenTeachOpen } from "./screenTeach";
import { blocksOf, type Rect } from "./screenText";
import { getMainWindow } from "./windows";

/*
  "Explain on screen": the tutor teaches the page in ANOTHER app's window (a Kindle book, a
  PDF in Chrome or Preview), as Teach mode teaches a PDF in the app.

    1. pick     a see-through layer over every display (static/overlay.html) takes one click;
                Esc, or the panel's Close, cancels. Started from Tutornote, its window steps
                aside while the student picks, and comes back as soon as the page is read.
    2. read     the screen helper (screen.ts) reads the window under the click, on this Mac.
    3. teach    the lesson opens over that window (screenTeach.ts): the web app's own Teach
                mode, from the paragraph that was clicked, turning the app's pages as it goes.

  The desktop companion (companion.ts) is now the way in: the tab bar's button and ⌃⌥E are its.
  The pick stays as a fallback, and this module's checks are the companion's too
  (ensureScreenReading: the helper is there, and Screen Recording is on).

  Until the lesson is on screen, a small floating panel (static/board.html) says what is
  happening ("Reading the page…") or what went wrong, with the way on (System Settings,
  Try again). The lesson's own page does everything after that: the tutor, its voice, the
  student's session.

  Local test build only: nothing here is committed.
*/

const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 300;
const SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

let overlays: BrowserWindow[] = [];
let panel: BrowserWindow | null = null;
let picking = false;
let hidMain = false;
/** The pick was started from Tutornote's own window (the menu): it steps aside again for a new
 *  try (the panel's "again"). */
let pickFromApp = false;
let run: AbortController | null = null;
/** What the panel's Try again goes back to: a pick, or turning the companion on. */
let retryTo: "pick" | "companion" = "pick";

// MARK: the panel

type PanelMessage =
  | { kind: "status"; text: string }
  | { kind: "error"; text: string; actions?: Array<"settings" | "retry" | "again"> };

function tellPanel(message: PanelMessage): void {
  if (!panel || panel.isDestroyed()) return;
  const contents = panel.webContents;
  // Said before the page has loaded: said once it has, in the same order.
  if (contents.isLoading()) contents.once("did-finish-load", () => contents.send("board:message", message));
  else contents.send("board:message", message);
}

function ensurePanel(): BrowserWindow {
  if (panel && !panel.isDestroyed()) return panel;
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    minWidth: 300,
    minHeight: 200,
    show: false,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    backgroundColor: "#fffdf8",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "board.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "floating", 1);
  // Over a full-screen app too (Kindle in full-screen Chrome): see screenTeach.ts for the price.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hideFromCapture(win);
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("closed", () => {
    if (panel === win) {
      panel = null;
      closeAll();
    }
  });
  void win.loadFile(path.join(app.getAppPath(), "static", "board.html"));
  panel = win;
  return win;
}

/** The panel beside the click: in the wider empty side of the screen, else in a corner. */
function placePanel(near: Rect | { x: number; y: number }): void {
  const win = ensurePanel();
  const rect: Rect = "w" in near ? near : { x: near.x, y: near.y, w: 1, h: 1 };
  const area = screen.getDisplayNearestPoint({ x: Math.round(rect.x), y: Math.round(rect.y) }).workArea;
  const [width] = win.getSize();
  const height = Math.min(PANEL_HEIGHT, area.height - 32);
  const roomRight = area.x + area.width - (rect.x + rect.w) - 24;
  const roomLeft = rect.x - area.x - 24;
  let x: number;
  if (roomRight >= width) x = rect.x + rect.w + 24;
  else if (roomLeft >= width) x = rect.x - 24 - width;
  else x = area.x + area.width - width - 16;
  const y = Math.min(Math.max(rect.y - 20, area.y + 16), area.y + area.height - height - 16);
  win.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  if (!win.isVisible()) win.showInactive();
}

// MARK: the pointer layer

function overlayFor(display: Electron.Display): BrowserWindow {
  const bounds: Rectangle = display.bounds;
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "overlay.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hideFromCapture(win);
  win.setIgnoreMouseEvents(true);
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void win.loadFile(path.join(app.getAppPath(), "static", "overlay.html"));
  return win;
}

function ensureOverlays(): void {
  overlays = overlays.filter((w) => !w.isDestroyed());
  if (overlays.length) return;
  overlays = screen.getAllDisplays().map(overlayFor);
}

type OverlayState =
  | { mode: "pick" }
  | { mode: "idle" }
  | { mode: "reading"; at: { x: number; y: number } };

/** The same picture on every display, in each one's own coordinates. */
function tellOverlays(state: OverlayState): void {
  for (const win of overlays) {
    if (win.isDestroyed()) continue;
    const b = win.getBounds();
    const message = state.mode === "reading" ? { mode: "reading", at: { x: state.at.x - b.x, y: state.at.y - b.y } } : state;
    const send = (): void => win.webContents.send("overlay:state", message);
    if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
    else send();
  }
}

// MARK: picking

function enterPick(): void {
  run?.abort();
  run = null;
  ensureOverlays();
  picking = true;
  for (const win of overlays) {
    win.setIgnoreMouseEvents(false);
    win.showInactive();
  }
  tellOverlays({ mode: "pick" });
  if (!globalShortcut.isRegistered("Escape")) globalShortcut.register("Escape", cancelPick);
  tellPanel({ kind: "status", text: "Click the paragraph you want explained. Press Esc to cancel." });
}

function leavePick(): void {
  picking = false;
  for (const win of overlays) if (!win.isDestroyed()) win.setIgnoreMouseEvents(true);
  if (globalShortcut.isRegistered("Escape")) globalShortcut.unregister("Escape");
}

function cancelPick(): void {
  if (!picking) return;
  leavePick();
  restoreMain();
  tellOverlays({ mode: "idle" });
  // A lesson on screen carries on as it was.
  if (panel && !panel.isDestroyed()) tellPanel({ kind: "status", text: "Press Explain another part." });
  else if (!screenTeachOpen()) closeAll();
}

/** Tutornote's window steps aside while the student picks in the app behind it (a pick started
 *  from it), so that app is the one clicked and read. */
function hideMainForPick(): void {
  const main = getMainWindow();
  if (!main?.isVisible()) return;
  main.hide();
  hidMain = true;
}

/**
 * Tutornote's window back, once the pick it stepped aside for is over (the page is read, or the
 * pick was given up), without taking the front from the app being read. showInactive alone
 * brings it in front of every window (Electron 44 orders it front regardless), where it would
 * cover the page the lesson marks: over `behind` (the window read, screen points) it goes to the
 * back instead (blur, which on a Mac orders it behind the other windows), open, a click away.
 */
function restoreMain(behind?: Rect): void {
  if (!hidMain) return;
  hidMain = false;
  const main = getMainWindow();
  if (!main) return;
  main.showInactive();
  if (behind && overlaps(main.getBounds(), behind)) main.blur();
}

const overlaps = (a: Rectangle, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.width && a.y < b.y + b.h && b.y < a.y + a.height;

function closeAll(): void {
  run?.abort();
  run = null;
  leavePick();
  for (const win of overlays) if (!win.isDestroyed()) win.destroy();
  overlays = [];
  const p = panel;
  panel = null;
  if (p && !p.isDestroyed()) p.destroy();
  pickFromApp = false;
  if (hidMain) {
    hidMain = false;
    getMainWindow()?.show();
  }
  // Last: closing the lesson tells this module so (screen-teach-closed), which finds
  // everything above already closed.
  closeScreenTeach();
}

/**
 * Whether the screen can be read: the helper is there (macOS 14, built) and Screen Recording is on
 * for it (asked for the first time). If not, the panel says so with the way on (System Settings,
 * Try again), and false. `forWhat`: what Try again goes back to. The companion's panel goes once
 * the screen can be read.
 */
export async function ensureScreenReading(forWhat: "pick" | "companion" = "pick"): Promise<boolean> {
  retryTo = forWhat;
  if (!screenReadingAvailable()) {
    placePanel(screen.getCursorScreenPoint());
    tellPanel({ kind: "error", text: "Reading other apps needs macOS 14 or later and the app's screen helper (npm run build)." });
    return false;
  }
  let allowed = await screenAllowed();
  if (!allowed) allowed = await requestScreenAccess();
  if (!allowed) {
    placePanel(screen.getCursorScreenPoint());
    tellPanel({
      kind: "error",
      text:
        "Tutornote needs Screen Recording to read the page. In System Settings, open Privacy & Security, then Screen Recording, " +
        "and switch on Tutornote Screen Reader. Then press Try again.",
      actions: ["settings", "retry"],
    });
    return false;
  }
  if (forWhat === "companion" && panel && !panel.isDestroyed() && !picking && !screenTeachOpen()) panel.hide();
  return true;
}

async function start(fromApp: boolean): Promise<void> {
  if (!(await ensureScreenReading("pick"))) return;
  pickFromApp = fromApp;
  // Started from Tutornote's own window: it steps aside so the other app is clickable, while the
  // student picks only (restoreMain).
  if (fromApp) hideMainForPick();
  enterPick();
}

async function onPick(win: BrowserWindow, clientX: number, clientY: number): Promise<void> {
  if (!picking) return;
  const b = win.getBounds();
  const at = { x: b.x + clientX, y: b.y + clientY };
  leavePick();
  tellOverlays({ mode: "reading", at });
  placePanel(at);
  tellPanel({ kind: "status", text: "Reading the page…" });

  const controller = new AbortController();
  run?.abort();
  run = controller;

  let read: ScreenRead;
  try {
    read = await readWindowAt(at.x, at.y, [process.pid]);
  } catch (e) {
    restoreMain();
    if (controller.signal.aborted) return;
    tellOverlays({ mode: "idle" });
    const code = e instanceof ScreenReadError ? e.code : "capture_failed";
    tellPanel(
      code === "no_permission"
        ? { kind: "error", text: "Screen Recording is off for Tutornote Screen Reader.", actions: ["settings", "retry"] }
        : code === "no_window"
          ? { kind: "error", text: "There was no window under that click. Try again on the page.", actions: ["again"] }
          : { kind: "error", text: "The page couldn't be read just now.", actions: ["again"] },
    );
    return;
  }
  // Read: Tutornote's window is back, behind the window read if it would cover it (the lesson
  // floats above them both).
  restoreMain(read.frame);
  if (controller.signal.aborted) return;

  const blocks = blocksOf(read.lines);
  console.log(
    `[explain] ${read.app}: ${read.lines.length} lines, ${blocks.length} paragraphs, capture ${read.captureMs} ms, text ${read.ocrMs} ms`,
  );
  if (!blocks.length) {
    tellOverlays({ mode: "idle" });
    tellPanel({ kind: "error", text: "No text there. Click right on a paragraph.", actions: ["again"] });
    return;
  }
  // The lesson lays the page out itself and starts at the paragraph under the click. The
  // panel says "Reading the page…" until the lesson is on screen (screen-teach-started).
  void openScreenTeach(read, at);
}

// MARK: install

function fromOverlay(event: IpcMainEvent): BrowserWindow | null {
  return overlays.find((w) => !w.isDestroyed() && w.webContents === event.sender) ?? null;
}

const fromPanel = (event: IpcMainEvent): boolean => Boolean(panel && !panel.isDestroyed() && panel.webContents === event.sender);

/** The floating panel, if there is one (the companion counts it as Tutornote's own). */
export const screenPanelWindow = (): BrowserWindow | null => (panel && !panel.isDestroyed() ? panel : null);

export function installExplain(): void {
  appEvents.on("explain-start", (from: unknown) => void start(from === "app"));
  // The lesson (screenTeach.ts): on screen, closed, or it could not open.
  appEvents.on("screen-teach-started", () => {
    tellOverlays({ mode: "idle" });
    if (panel && !panel.isDestroyed()) panel.hide();
  });
  appEvents.on("screen-teach-closed", () => closeAll());
  appEvents.on("screen-teach-failed", (text: unknown) => {
    tellOverlays({ mode: "idle" });
    if (!panel || panel.isDestroyed() || !panel.isVisible()) placePanel(screen.getCursorScreenPoint());
    tellPanel({ kind: "error", text: typeof text === "string" ? text : "The lesson couldn't open. Please try again.", actions: ["again"] });
  });
  // (⌃⌥E is the companion's now: companion.ts registers it)

  ipcMain.on("overlay:pick", (event, x: unknown, y: unknown) => {
    const win = fromOverlay(event);
    if (!win || typeof x !== "number" || typeof y !== "number") return;
    void onPick(win, x, y);
  });
  ipcMain.on("overlay:cancel", (event) => {
    if (fromOverlay(event)) cancelPick();
  });

  ipcMain.on("board:command", (event, command: unknown) => {
    if (!fromPanel(event)) return;
    if (command === "again") {
      // (Tutornote's window, back since the last try, steps aside again for this one)
      if (pickFromApp) hideMainForPick();
      enterPick();
    } else if (command === "close") closeAll();
    else if (command === "settings") void shell.openExternal(SETTINGS_URL);
    else if (command === "retry") {
      restartScreenHelper();
      // (the companion turns itself on again: companion.ts)
      if (retryTo === "companion") appEvents.emit("companion-retry");
      else void start(pickFromApp);
    }
  });

  app.on("will-quit", () => globalShortcut.unregisterAll());
}
