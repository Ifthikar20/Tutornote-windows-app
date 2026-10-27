import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { beginBrowserSignIn } from "./auth";
import { BOARD_COPY, clampBoardZoom } from "./boardHost";
import { WEBSITE_URL } from "./config";
import { appEvents } from "./events";
import { openExternal } from "./links";
import {
  boardPlaceNow,
  closeScreenBoard,
  closeScreenTeach,
  rememberBoardZoom,
  screenBoardContents,
  screenBoardFocused,
  screenTeachFocused,
  toggleBoardPlace,
} from "./screenTeach";
import { checkForUpdates } from "./updater";
import { activeContents, closeActiveTab, navigateTo, newTab, selectAdjacentTab } from "./windows";

const isMac = process.platform === "darwin";

/** The menus act on the page in the active tab, not the window's toolbar; and on none while the
 *  lesson over another app has the keys (screenTeach.ts), whose ⌘R or zoom would land on a tab
 *  the student cannot see. */
const contents = () => (screenTeachFocused() ? undefined : activeContents());

/** The page's text size; the lesson's board's while it has the keys (kept within its range, and
 *  for later lessons: screenTeach.ts). */
function zoom(step: number): void {
  const board = screenBoardContents();
  const wc = board ?? contents();
  if (!wc) return;
  const level = step === 0 ? 0 : wc.getZoomLevel() + step * 0.5;
  wc.setZoomLevel(board ? clampBoardZoom(level) : level);
  if (board) rememberBoardZoom(wc.getZoomLevel());
}

function goBack(): void {
  const wc = contents();
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
}

function goForward(): void {
  const wc = contents();
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
}

function openCurrentPageInBrowser(): void {
  const url = contents()?.getURL() ?? "";
  openExternal(/^https?:/i.test(url) ? url : WEBSITE_URL);
}

/** The Window menu's board item says where the board is: the menu is built again when that changes. */
let boardHooked = false;

export function installMenu(): void {
  if (!boardHooked) {
    boardHooked = true;
    appEvents.on("board-place-changed", () => installMenu());
  }
  const updateItem: MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => void checkForUpdates(true),
  };

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            updateItem,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : [];

  const editExtras: MenuItemConstructorOptions[] = isMac
    ? [{ role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" }]
    : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }];

  const devTools: MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [{ label: "Toggle Developer Tools", accelerator: "Alt+CmdOrCtrl+I", click: () => (screenBoardContents() ?? contents())?.toggleDevTools() }];

  const windowExtras: MenuItemConstructorOptions[] = isMac
    ? [{ type: "separator" }, { role: "front" }]
    : [];

  const helpExtras: MenuItemConstructorOptions[] = isMac
    ? []
    : [{ type: "separator" }, updateItem, { label: `Version ${app.getVersion()}`, enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: "File",
      submenu: [
        { label: "New Note", accelerator: "CmdOrCtrl+N", click: () => newTab() },
        { label: "New Note in Tab", accelerator: "CmdOrCtrl+T", visible: false, click: () => newTab() },
        { type: "separator" },
        { label: "Sign In with Your Browser…", click: () => beginBrowserSignIn() },
        { type: "separator" },
        // (in the lesson over another app, ⌘W closes that lesson, never a tab behind it; in the
        // lesson's board window, only the board, as its red light does)
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => (screenBoardFocused() ? closeScreenBoard() : screenTeachFocused() ? closeScreenTeach() : closeActiveTab()),
        },
        ...(isMac ? [] : [{ role: "quit" } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...editExtras,
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => contents()?.reload() },
        { label: "Force Reload", accelerator: "Shift+CmdOrCtrl+R", click: () => contents()?.reloadIgnoringCache() },
        ...devTools,
        { type: "separator" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => zoom(0) },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => zoom(1) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => zoom(-1) },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Go",
      submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", click: goBack },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: goForward },
        { type: "separator" },
        { label: "Dashboard", accelerator: "CmdOrCtrl+1", click: () => navigateTo("/dashboard") },
        { label: "Folders", accelerator: "CmdOrCtrl+2", click: () => navigateTo("/dashboard/folders") },
        { label: "Sticky Wall", accelerator: "CmdOrCtrl+3", click: () => navigateTo("/dashboard/stickies") },
        { label: "Calendar", accelerator: "CmdOrCtrl+4", click: () => navigateTo("/dashboard/calendar") },
        { label: "Profile", accelerator: "CmdOrCtrl+5", click: () => navigateTo("/dashboard/profile") },
        { type: "separator" },
        // The pick (explain.ts), kept as a fallback. ⌃⌥E is the desktop companion's now
        // (companion.ts registers it), as is the tab bar's button.
        {
          label: "Explain on Screen",
          click: () => appEvents.emit("explain-start", "app"),
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { label: "Show Next Tab", accelerator: "Ctrl+Tab", click: () => selectAdjacentTab(1) },
        { label: "Show Previous Tab", accelerator: "Ctrl+Shift+Tab", click: () => selectAdjacentTab(-1) },
        { label: "Next Tab", accelerator: "CmdOrCtrl+Shift+]", visible: false, click: () => selectAdjacentTab(1) },
        { label: "Previous Tab", accelerator: "CmdOrCtrl+Shift+[", visible: false, click: () => selectAdjacentTab(-1) },
        { type: "separator" },
        // The lesson's board (screenTeach.ts): into its own window, or into a tab here.
        {
          label: boardPlaceNow() === "tab" ? BOARD_COPY.popOut : BOARD_COPY.showIn,
          accelerator: "Alt+CmdOrCtrl+B",
          enabled: boardPlaceNow() !== null,
          click: () => toggleBoardPlace(),
        },
        ...windowExtras,
      ],
    },
    {
      role: "help",
      submenu: [
        { label: "Open This Page in Browser", click: openCurrentPageInBrowser },
        { label: "Tutornote Website", click: () => openExternal(WEBSITE_URL) },
        ...helpExtras,
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
