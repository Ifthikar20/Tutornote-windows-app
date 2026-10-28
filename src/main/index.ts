import { app, ipcMain, session, systemPreferences, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { offendingSwitch } from "./argGuard";
import { authLog, beginBrowserSignIn, cancelBrowserSignIn, deepLinksIn, handleDeepLink, registerProtocol } from "./auth";
import {
  API_ORIGIN,
  API_URL,
  APP_ORIGIN,
  APP_URL,
  BUNDLED,
  CLIENT_HEADER,
  originOf,
  PREVIEW_COOKIE,
  PREVIEW_KEY,
  SESSION_COOKIE,
  SESSION_COOKIE_URL,
  SITE_ORIGIN,
  WEBSITE_URL,
} from "./config";
import { installCompanion } from "./companion";
import { installExplain } from "./explain";
import { installMenu } from "./menu";
import { installRenderer, registerAppScheme, rendererBuild } from "./renderer";
import { installScreenTeach } from "./screenTeach";
import { installSignIn } from "./signin";
import { installSpeech } from "./speech";
import { installUpdater } from "./updater";
import { createMainWindow, focusMainWindow, getMainWindow, setBrowserSignIn, showMainWindow, showSignIn } from "./windows";

/*
  Tutornote for the desktop, v0: the live web app in a window of its own.

  The renderer is the website, untouched. Everything native lives here in the main
  process: one window whose size and place are remembered, native menus, links to the
  browser, the microphone permission, sign-in through the browser (auth.ts), and
  updates. See the README for what comes next.
*/

app.setAppUserModelId("app.tutornote.desktop");

// A packaged app refuses the debugging, proxy and certificate switches that would let another
// program on the machine instrument it or read its origin (WHAT_TO_FIX.md WIN-03 / MAC-03); the
// fuses cover only the matching environment variables. A development run keeps them.
if (app.isPackaged) {
  const bad = offendingSwitch((name) => app.commandLine.hasSwitch(name));
  if (bad) {
    console.error(`[anothernotes] refusing to start: the --${bad} switch is not allowed`);
    app.exit(1);
  }
}

// An error nothing caught goes to the log (the terminal the app was started from), not
// into a dialog that stops the app until someone clicks it away.
process.on("uncaughtException", (error) => {
  console.error("[anothernotes] unexpected error:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[anothernotes] unexpected error:", reason);
});
registerAppScheme();

// Links the OS hands us before the window exists (a cold start from a link).
let queuedLinks: string[] = deepLinksIn(process.argv);
// The first main window has been made (whenReady, below). Set once, never reset: before it the
// Dock (or a second launch) has nothing to show, and a window made for it then would be a second one.
let launched = false;

// One running copy. A second launch (a double-click on the dock, a link) focuses it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // (the step that shows whether Windows handed a sign-in link to this copy: the sign-in log)
    if (deepLinksIn(argv).length) authLog(`a second launch brought ${deepLinksIn(argv).length} link(s)${launched ? "" : " before the window was up"}`);
    // (before the first window is made, as the Dock's activate: focusMainWindow would make one,
    // and the launch's own a second; its links wait with the cold start's, handled once it is)
    if (!launched) {
      queuedLinks.push(...deepLinksIn(argv));
      return;
    }
    focusMainWindow();
    for (const link of deepLinksIn(argv)) handleDeepLink(link);
  });

  // macOS delivers tutornote:// (and old anothernotes://) links here, possibly before the app is ready.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (getMainWindow()) handleDeepLink(url);
    else queuedLinks.push(url);
  });

  app.on("web-contents-created", (_event, contents) => {
    // No <webview> tags: the app has one page, the web app.
    contents.on("will-attach-webview", (event) => event.preventDefault());
    // No Bluetooth devices either: unhandled, Electron would hand a page the first one found.
    contents.on("select-bluetooth-device", (event, _devices, callback) => {
      event.preventDefault();
      callback("");
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // The Dock icon brings the main window back when it was closed, or hidden by "Explain on
  // screen" (explain.ts) for a lesson started from its tab bar. Not "when there are no
  // windows": the lesson over another app (screenTeach.ts) keeps its window, hidden, between
  // lessons, and that must not stop the main one from reopening. During a slow start it shows
  // the window at once, and the loader goes (windows.ts showMainWindow); before the first window
  // is made at all, nothing.
  app.on("activate", () => {
    if (!launched) return;
    showMainWindow();
  });

  void app.whenReady().then(async () => {
    // The first thing to check when the window shows the wrong site: which addresses this
    // build resolved. ANOTHERNOTES_URL and ANOTHERNOTES_API_URL change them (config.ts).
    console.log(
      `[anothernotes] v${app.getVersion()} electron=${process.versions.electron} ` +
        (BUNDLED ? `renderer=bundled (${rendererBuild()}) ` : "renderer=site ") +
        `app=${APP_URL} api=${API_URL}`,
    );
    if (BUNDLED) installRenderer();
    app.setAboutPanelOptions({
      applicationName: "Tutornote",
      applicationVersion: app.getVersion(),
      website: WEBSITE_URL,
    });
    registerProtocol();
    setBrowserSignIn(beginBrowserSignIn);

    // The web app may use the microphone (dictation, talking to the tutor) and the
    // clipboard; nothing else, and nothing at all from any other origin.
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      let origin = "";
      try {
        origin = originOf(details.requestingUrl);
      } catch {
        /* no origin: refused below */
      }
      if (origin !== APP_ORIGIN) {
        console.log(`[permissions] request refused: ${permission} (${origin || details.requestingUrl || "no url"}, page ${contents?.getURL?.() ?? "?"})`);
        return callback(false);
      }
      if (permission === "media") {
        const types = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
        if (types.includes("video")) return callback(false);
        if (process.platform === "darwin") {
          void systemPreferences.askForMediaAccess("microphone").then((granted) => callback(granted));
          return;
        }
        return callback(true);
      }
      callback(permission === "clipboard-sanitized-write" || permission === "fullscreen" || permission === "notifications");
    });
    // The same rule for a page asking whether it has a permission (navigator.permissions,
    // and what Chromium checks before a device or a feature): yes only for the app's origin
    // and what the requests above can grant. Devices (HID, serial, USB) are never granted,
    // and their choosers close with nothing chosen.
    session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      let origin = "";
      try {
        origin = originOf(requestingOrigin);
      } catch {
        /* no origin: refused below */
      }
      const allowed =
        origin === APP_ORIGIN &&
        (permission === "media"
          ? details.mediaType !== "video"
          : permission === "clipboard-sanitized-write" || permission === "fullscreen" || permission === "notifications");
      if (!allowed) console.log(`[permissions] check refused: ${permission} (${origin || requestingOrigin || "no origin"})`);
      return allowed;
    });
    session.defaultSession.setDevicePermissionHandler(() => false);
    session.defaultSession.on("select-hid-device", (event, _details, callback) => {
      event.preventDefault();
      callback();
    });
    session.defaultSession.on("select-serial-port", (event, _ports, _contents, callback) => {
      event.preventDefault();
      callback("");
    });
    session.defaultSession.on("select-usb-device", (event, _details, callback) => {
      event.preventDefault();
      callback();
    });

    // Tell the API which client this is, on every request to the site and to the API.
    const origins = [...new Set([SITE_ORIGIN, API_ORIGIN])].map((origin) => `${origin}/*`);
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: origins }, (details, callback) => {
      details.requestHeaders["X-AnotherNotes-Client"] = CLIENT_HEADER;
      if (details.resourceType === "mainFrame") {
        const sent = /(^|;\s*)an_preview=[^;]+/.test(details.requestHeaders.Cookie ?? "");
        console.log(`[anothernotes] GET ${details.url} gateKey=${sent ? "sent" : "not sent"}`);
      }
      callback({ requestHeaders: details.requestHeaders });
    });

    // The refresh cookie is what keeps the app signed in across launches; make sure it
    // reaches disk as soon as it changes rather than at Chromium's leisure.
    session.defaultSession.cookies.on("changed", (_event, cookie) => {
      if (cookie.name === SESSION_COOKIE) void session.defaultSession.cookies.flushStore();
    });

    // The bridge's few calls, from the app's own pages only: its own files (static/: the
    // sign-in screen, the offline page), never any other file, and the web app at its origin.
    const ownPages = `${pathToFileURL(path.join(app.getAppPath(), "static")).href}/`;
    const trusted = (event: IpcMainInvokeEvent): boolean => {
      const url = event.senderFrame?.url ?? "";
      return url.startsWith(ownPages) || url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`);
    };
    ipcMain.handle("auth:sign-in-with-browser", (event) => {
      if (!trusted(event)) throw new Error("not allowed");
      beginBrowserSignIn();
    });
    ipcMain.handle("auth:sign-in-here", (event) => {
      if (!trusted(event)) throw new Error("not allowed");
      showSignIn();
    });
    installSignIn(trusted);
    // Dictation and Teach mode through the Mac's own speech recognition (speech.ts).
    installSpeech();
    // Explain on screen: the tutor teaches the page in another app's window (explain.ts
    // picks and reads it, screenTeach.ts runs the lesson over it).
    installExplain();
    installScreenTeach();
    // The desktop companion: the tutor's blob, and the tutor following the cursor over any app
    // (companion.ts). After the two above, whose lesson window and checks it uses.
    installCompanion();
    ipcMain.handle("auth:cancel-browser-sign-in", (event) => {
      if (!trusted(event)) throw new Error("not allowed");
      cancelBrowserSignIn();
    });

    if (PREVIEW_KEY) await unlockMaintenanceGate(PREVIEW_KEY);
    console.log(
      `[anothernotes] profile=${app.getPath("userData")} gateKey=${await gateKeyState()}`,
    );

    installMenu();
    // The web app when there is a session, the app's own sign-in screen when there is not
    // (signin.ts).
    createMainWindow((await hasSession()) ? "app" : "signin");
    launched = true;
    installUpdater();

    for (const link of queuedLinks) handleDeepLink(link);
    queuedLinks = [];
  });
}

/** Store the maintenance gate's team key in the app's own cookie jar, for 30 days. */
async function unlockMaintenanceGate(key: string): Promise<void> {
  try {
    await session.defaultSession.cookies.set({
      url: SITE_ORIGIN,
      name: PREVIEW_COOKIE,
      value: encodeURIComponent(key),
      path: "/",
      sameSite: "lax",
      secure: SITE_ORIGIN.startsWith("https:"),
      expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    });
    await session.defaultSession.cookies.flushStore();
    console.log(`[anothernotes] maintenance gate: ${PREVIEW_COOKIE} cookie stored for ${SITE_ORIGIN}`);
  } catch (e) {
    console.warn("[anothernotes] maintenance gate: could not store the cookie:", e);
  }
}

/**
 * Is the maintenance gate's key in the cookie jar, and readable? Cookies are encrypted
 * with a key in the macOS Keychain; a build that cannot read that item sees empty values.
 */
async function gateKeyState(): Promise<string> {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: SITE_ORIGIN, name: PREVIEW_COOKIE });
    if (cookies.length === 0) return "none";
    return cookies[0].value ? `stored (${cookies[0].value.length} chars)` : "stored but unreadable (empty value)";
  } catch {
    return "none";
  }
}

/** Is there a refresh cookie for the API in this app's cookie jar? Then the site opens signed in. */
async function hasSession(): Promise<boolean> {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: SESSION_COOKIE_URL, name: SESSION_COOKIE });
    return cookies.length > 0;
  } catch {
    return false;
  }
}
