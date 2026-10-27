import { app, screen, type BrowserWindow, type Rectangle } from "electron";
import fs from "node:fs";
import path from "node:path";
import { boardFileWith, boardPrefsOf, type BoardPrefs } from "./boardHost";
import { BOARD_MIN } from "./boardPlace";
import { blobPlacesOf, clampBlobPlace } from "./companionPlace";

/** The main window's last size and position, so it opens where it was closed. */
export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 820, maximized: false };

const stateFile = (): string => path.join(app.getPath("userData"), "window-state.json");

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Read the saved state; fall back to defaults when there is none, or when the saved
 *  position is on a display that is no longer connected. */
export function loadWindowState(): WindowState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as Partial<WindowState>;
    if (!isNumber(raw.width) || !isNumber(raw.height) || raw.width < 600 || raw.height < 400) return DEFAULT_STATE;
    const state: WindowState = { width: raw.width, height: raw.height, maximized: raw.maximized === true };
    if (isNumber(raw.x) && isNumber(raw.y)) {
      const rect: Rectangle = { x: raw.x, y: raw.y, width: state.width, height: state.height };
      if (screen.getAllDisplays().some((d) => intersects(d.workArea, rect))) {
        state.x = raw.x;
        state.y = raw.y;
      }
    }
    return state;
  } catch {
    return DEFAULT_STATE;
  }
}

export function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    const bounds = win.getNormalBounds();
    const state: WindowState = { ...bounds, maximized: win.isMaximized() };
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state));
  } catch (e) {
    console.warn("[anothernotes] could not save the window state:", e);
  }
}

/*
  The board of a lesson over another app (screenTeach.ts): where the student last moved its own
  window, and the size they last gave it, so the next lesson opens it there (boardPlace.ts decides
  whether that place still suits the page being read). Not Electron's own window state, which puts
  a window back at its old bounds whatever is under them now. The same file keeps whether they
  chose Pop out (place "window") or Open in Tutornote ("tab"), and the board's text size (zoom):
  { x, y, width, height, place, zoom }, each checked as it is read (boardHost.ts).
*/
const boardFile = (): string => path.join(app.getPath("userData"), "screen-board.json");

function readBoardFile(): unknown {
  try {
    return JSON.parse(fs.readFileSync(boardFile(), "utf8")) as unknown;
  } catch {
    return {};
  }
}

function writeBoardFile(content: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(boardFile()), { recursive: true });
    fs.writeFileSync(boardFile(), JSON.stringify(content));
  } catch (e) {
    console.warn("[screen-teach] could not save the board's place:", e);
  }
}

/** The board's last place and size, or null when there is none, it is smaller than the board is
 *  made (boardPlace.ts BOARD_MIN), or it is on a display that is no longer connected. */
export function loadScreenBoard(): Rectangle | null {
  try {
    const raw = JSON.parse(fs.readFileSync(boardFile(), "utf8")) as Partial<Rectangle>;
    if (!isNumber(raw.x) || !isNumber(raw.y) || !isNumber(raw.width) || !isNumber(raw.height)) return null;
    if (raw.width < BOARD_MIN.width || raw.height < BOARD_MIN.height) return null;
    const rect: Rectangle = { x: Math.round(raw.x), y: Math.round(raw.y), width: Math.round(raw.width), height: Math.round(raw.height) };
    return screen.getAllDisplays().some((d) => intersects(d.workArea, rect)) ? rect : null;
  } catch {
    return null;
  }
}

/** The floating window's place and size, as the student left it (the choice and the text size stay). */
export function saveScreenBoard(r: Rectangle): void {
  writeBoardFile(boardFileWith(readBoardFile(), { bounds: { x: r.x, y: r.y, width: r.width, height: r.height } }));
}

/** The student's choice of where the board goes, and its text size; the defaults on any error. */
export const loadBoardPrefs = (): BoardPrefs => boardPrefsOf(readBoardFile());

export function saveBoardPrefs(patch: Partial<BoardPrefs>): void {
  writeBoardFile(boardFileWith(readBoardFile(), patch));
}

/*
  The desktop companion's blob (companion.ts): where the student last left it on each display, by
  the display's id, so it comes back there on the next launch (companionPlace.ts brings a place on
  to the work area as it is now); and whether its first-time tip has been shown. One small file,
  companion-blob.json: { places: { "<display id>": { x, y } }, tipped: true }.
*/
const blobFile = (): string => path.join(app.getPath("userData"), "companion-blob.json");

function readBlobFile(): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(blobFile(), "utf8")) as unknown;
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeBlobFile(content: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(blobFile()), { recursive: true });
    fs.writeFileSync(blobFile(), JSON.stringify(content));
  } catch (e) {
    console.warn("[companion] could not save the blob's place:", e);
  }
}

/** Where the student last left the blob on the display `displayId`, brought into its work area,
 *  or null when they never moved it there or that display is no longer connected. */
export function loadBlobPlace(displayId: number): { x: number; y: number } | null {
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (!display) return null;
  const kept = blobPlacesOf(readBlobFile())[String(displayId)];
  return kept ? clampBlobPlace(kept, display.workArea) : null;
}

export function saveBlobPlace(displayId: number, point: { x: number; y: number }): void {
  const content = readBlobFile();
  const places = blobPlacesOf(content);
  places[String(displayId)] = { x: Math.round(point.x), y: Math.round(point.y) };
  writeBlobFile({ ...content, places });
}

/** The companion's first-time tip ("Point at what you're reading…") has been shown. */
export const companionTipped = (): boolean => readBlobFile().tipped === true;

export function markCompanionTipped(): void {
  writeBlobFile({ ...readBlobFile(), tipped: true });
}
