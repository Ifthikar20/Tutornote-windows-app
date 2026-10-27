/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from "electron";

/*
  The bridge between the web app and the desktop shell. Deliberately tiny: the web app
  can tell it is running on the desktop (window.anothernotes is undefined in a browser)
  and which version, and it can sign in: with an email and password
  (signin.ts in the main process, which checks every argument), or through the browser
  (auth.ts). Nothing else is exposed, and every call is a fixed channel. This file runs
  sandboxed, with context isolation, so the page never sees Node.
  The see-through window of a lesson over another app (src/main/screenTeach.ts) loads it
  too, with one more part: that lesson's bridge (screenTeach, below).
*/

const VERSION_FLAG = "--anothernotes-version=";
const versionArg = process.argv.find((arg) => arg.startsWith(VERSION_FLAG));
/* The main process has the Mac's speech helper (src/main/speech.ts): this page gets a
   SpeechRecognition of its own over it (below), and tells the web app so (speech.native). */
const nativeSpeech = process.argv.includes("--anothernotes-speech=1");
/* The lesson's see-through window (src/main/screenTeach.ts), not a tab: it gets the
   screenTeach bridge, and none of what keeps the window's tabs in step with the window
   (the sidebar followed across tabs, the room made for the tab bar, link routing, the
   layout reports). The cookie store and the speech shim are the same as a tab's. */
const screenTeach = process.argv.includes("--anothernotes-screen-teach=1");

/*
  The speech bridge. A recogniser of the page (the shim below) starts a session here
  and gets its events back: start, audiostart, speechstart, interim (the words in
  flight), phrase (continuous: one finished), error (a Web Speech API code), end (and,
  for one utterance, its text). Sessions are numbered per page; the main process maps
  them to the helper's.
  A start may carry options: `preroll` (unix ms: the student's press; the words said since
  are fed from the microphone's ring) and `hints` (the lesson's words, for Apple's recogniser
  to expect). Only those two go, and only as a number and a list of strings: the main process
  checks them again (speechLog.ts speechStartOptions). warm and prepare get the microphone and
  the recogniser ready for a start about to come (src/main/speech.ts).
  output and onOutput: where the tutor's voice plays ({name, transport, source, speakers}: the
  Mac's default output, and whether the microphone can hear it), now (null while unknown) and on
  every change. Only those four go to the page, as strings and a boolean.
*/
interface SpeechEvent {
  ev: string;
  text?: string;
  code?: string;
}

/** A start's options as they go to the main process: a finite `preroll`, string `hints`, nothing else. */
function speechStartOptions(opts: unknown): { preroll?: number; hints?: string[] } | undefined {
  if (typeof opts !== "object" || opts === null) return undefined;
  const { preroll, hints } = opts as { preroll?: unknown; hints?: unknown };
  const out: { preroll?: number; hints?: string[] } = {};
  if (typeof preroll === "number" && Number.isFinite(preroll)) out.preroll = preroll;
  if (Array.isArray(hints)) out.hints = hints.filter((hint): hint is string => typeof hint === "string");
  return out.preroll !== undefined || out.hints ? out : undefined;
}
/** Where the voice plays, as the page gets it: the four fields with their types, or null. */
function outputRouteOf(value: unknown): { name: string; transport: string; source: string; speakers: boolean } | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, transport, source, speakers } = value as Record<string, unknown>;
  if (typeof speakers !== "boolean") return null;
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  return { name: text(name), transport: text(transport), source: text(source), speakers };
}
const speechListeners = new Map<number, (event: SpeechEvent) => void>();
let speechRef = 0;
if (nativeSpeech) {
  ipcRenderer.on("speech:event", (_event, message: { ref?: unknown; ev?: unknown; text?: unknown; code?: unknown }) => {
    if (typeof message?.ref !== "number" || typeof message.ev !== "string") return;
    const listener = speechListeners.get(message.ref);
    if (!listener) return;
    if (message.ev === "end") speechListeners.delete(message.ref);
    listener({
      ev: message.ev,
      text: typeof message.text === "string" ? message.text : undefined,
      code: typeof message.code === "string" ? message.code : undefined,
    });
  });
}
const speechBridge = Object.freeze({
  /** The words appear as they are said, on this Mac: the web app may treat it as a browser's recogniser. */
  native: true,
  start: (lang: unknown, continuous: unknown, onEvent: (event: SpeechEvent) => void, opts?: unknown): number => {
    const ref = ++speechRef;
    speechListeners.set(ref, onEvent);
    ipcRenderer.send("speech:start", ref, typeof lang === "string" ? lang : "", continuous === true, speechStartOptions(opts));
    return ref;
  },
  /** Keep the microphone running for `ms` (a start about to come); 0 lets it go. Never asks for it. */
  warm: (ms: unknown): void => {
    if (typeof ms === "number" && Number.isFinite(ms)) ipcRenderer.send("speech:warm", ms);
  },
  /** Make the recogniser for `lang` now, when both permissions are given. Never asks. */
  prepare: (lang: unknown): void => {
    if (typeof lang === "string") ipcRenderer.send("speech:prepare", lang);
  },
  stop: (ref: unknown): void => {
    if (typeof ref === "number") ipcRenderer.send("speech:stop", ref);
  },
  abort: (ref: unknown): void => {
    if (typeof ref !== "number") return;
    speechListeners.delete(ref);
    ipcRenderer.send("speech:abort", ref);
  },
  /** Where the tutor's voice plays now ({name, transport, source, speakers}), or null while that is
   *  not known. Asking it also has every change told to onOutput. */
  output: (): Promise<unknown> => ipcRenderer.invoke("speech:output").then(outputRouteOf, () => null),
  /** Every change of where the voice plays, once output() has been asked. Returns the way to stop. */
  onOutput: (cb: unknown): (() => void) =>
    typeof cb === "function"
      ? listen("speech:output", (value: unknown) => {
          const route = outputRouteOf(value);
          if (route) (cb as (route: unknown) => void)(route);
        })
      : () => undefined,
});

/*
  The lesson over another app's window: the web app's ScreenTeachBridge (its
  src/lib/screen/types.ts), method for method. The main process checks that each call
  comes from the lesson's window and checks every argument.
*/
function listen(channel: string, cb: unknown): () => void {
  if (typeof cb !== "function") return () => undefined;
  const listener = (_event: IpcRendererEvent, value: unknown): void => (cb as (value: unknown) => void)(value);
  ipcRenderer.on(channel, listener);
  return () => void ipcRenderer.removeListener(channel, listener);
}
const screenTeachBridge = Object.freeze({
  /** The page is mounted: the start it is to run, or null. */
  ready: (): Promise<unknown> => ipcRenderer.invoke("screen-teach:ready"),
  /** A new pick while the page is open. Returns the way to stop listening. Its `switched` (another
   *  document where the last run was teaching) comes as the Mac app sends it. */
  onStart: (cb: unknown): (() => void) => listen("screen-teach:start", cb),
  started: (): void => ipcRenderer.send("screen-teach:started"),
  interactive: (on: unknown): void => ipcRenderer.send("screen-teach:interactive", on === true),
  turn: (request: unknown): Promise<unknown> => ipcRenderer.invoke("screen-teach:turn", request),
  /** Read the window again. `opts.fast`: a quick check of where the words are (after a scroll). */
  reread: (run: unknown, opts?: unknown): Promise<unknown> =>
    ipcRenderer.invoke("screen-teach:reread", run, { fast: (opts as { fast?: unknown } | undefined)?.fast === true }),
  allowTurning: (): Promise<unknown> => ipcRenderer.invoke("screen-teach:allow-turning"),
  openSettings: (which: unknown): void => ipcRenderer.send("screen-teach:open-settings", which),
  openInMain: (path: unknown): void => ipcRenderer.send("screen-teach:open-in-main", path),
  /** The global shortcuts while the lesson is on screen, and "close" when it is closed from the app. */
  onCommand: (cb: unknown): (() => void) => listen("screen-teach:command", cb),
  /** The student's taps on the page being read (the window lets them through; the helper hears them).
   *  With the companion on, `id` is the release the page heard first (onCompanionRelease). */
  onTap: (cb: unknown): (() => void) => listen("screen-teach:tap", cb),
  /** The student scrolling the page being read, as it happens. */
  onScroll: (cb: unknown): (() => void) => listen("screen-teach:scroll", cb),
  /** Start the lesson afresh from a tap on words it has not read yet. */
  pickAt: (point: unknown): void => ipcRenderer.send("screen-teach:pick-at", point),
  close: (): void => ipcRenderer.send("screen-teach:close"),
  /** The board in its own window (the page opens it, empty, and draws into it): whether this
   *  run's board has something on it, whether it is zoomed, and its colour. */
  board: (state: unknown): void => ipcRenderer.send("screen-teach:board", state),
  /** That window's red light or ⌘W ("close") and green light ("zoom", "unzoom"). A channel of
   *  its own: a page older than it would take an unknown command for a key. */
  onBoardControl: (cb: unknown): (() => void) => listen("screen-teach:board-control", cb),
  /** Where the board lives ({ where, canMove, covering, app? }), on every change. */
  onBoardPlace: (cb: unknown): (() => void) => listen("screen-teach:board-place", cb),
  /** The same, now (null with no board). Asking it tells the Mac app this page knows tabs. */
  boardPlace: (): Promise<unknown> => ipcRenderer.invoke("screen-teach:board-place-now"),
  /** The student moved the board: "tab" | "float". */
  moveBoard: (to: unknown): void => ipcRenderer.send("screen-teach:board-move", to),
  /** The student asked for the app being read (Back to {app}). */
  backToApp: (): void => ipcRenderer.send("screen-teach:back-to-app"),

  /*
    The desktop companion (src/main/companion.ts): the tutor that trails the cursor over any app.
    Every point is the window's own (screen points less its top left), as above. The page
    feature-detects each of these, so it runs on a Mac app older than the companion as before.
  */
  /** The companion on ({on, overlay, from?, first}) or off ({on: false, to?}: the tutor flies home). */
  onCompanion: (cb: unknown): (() => void) => listen("screen-teach:companion", cb),
  /** The companion's state as the page starts (a reload too), or null when it is off. */
  companionState: (): Promise<unknown> => ipcRenderer.invoke("screen-teach:companion-state"),
  /** A glance at a window ({window, read, ground, fast, keepCard?, tap?, empty?}): its lines, read on
   *  this Mac, for the pointer and for where a tap lands. `keepCard`: the new look of the card's own
   *  tap, so the card stays; `tap`: the careful read taken at that release, now the window's glance;
   *  `empty`: no lines on a second look too (the window is blank now), so it replaces one with lines. */
  onGlance: (cb: unknown): (() => void) => listen("screen-teach:glance", cb),
  /** What the cursor is over ({window | null, own?, private?, reading?}). */
  onOver: (cb: unknown): (() => void) => listen("screen-teach:over", cb),
  /** The button went down on another app's window ({window, x, y}), before anything is judged. */
  onPress: (cb: unknown): (() => void) => listen("screen-teach:press", cb),
  /** A tap on another app's window that did nothing there ({window, x, y, id?}): the card is
   *  offered (`id`: the release it was opened for at once, if it was). */
  onCompanionTap: (cb: unknown): (() => void) => listen("screen-teach:companion-tap", cb),
  /** A tap just ended on another app's window, before it is judged ({id, window, x, y, alt, hand,
   *  clicks, lesson, run?, private?}): the page may paint the card in this frame. `hand`: the
   *  cursor was a pointing hand (a link); `lesson`: on the lesson's own window (`run`); `private`:
   *  a window never read. */
  onCompanionRelease: (cb: unknown): (() => void) => listen("screen-teach:companion-release", cb),
  /** That release was the app's after all ({id, why}: it acted, or a double click selected words):
   *  a card opened for it goes at once. */
  onCompanionWithdraw: (cb: unknown): (() => void) => listen("screen-teach:companion-withdraw", cb),
  /** The student scrolled another app's window ({window, dy, dx}). */
  onWindowScroll: (cb: unknown): (() => void) => listen("screen-teach:window-scroll", cb),
  /** The lesson's window settled into a new look ({run, window}): a page the student turned. */
  onChanged: (cb: unknown): (() => void) => listen("screen-teach:changed", cb),
  /** Another document where the lesson teaches ({run, on, why}): `on`, seen and being read (the
   *  lesson stops at once; `why`: "title", "window", "app" or "tap"); then a start with `switched`
   *  for it, or `on` false, the same document after all (`why`: "back", "same", "failed"), and the
   *  lesson goes on. While it waits with nothing to read yet, `on` again with `why` "wait words",
   *  "wait student", "wait secure" or "wait screen", and "reading" as it reads again. Only a
   *  finite run, a boolean and a short string reach the page. A channel of its own; listening on it
   *  tells the Mac app this page hears of a switch (screen-teach:hears-switching): for a page older
   *  than it none is begun, and its lesson goes on as it always did. */
  onSwitching: (cb: unknown): (() => void) => {
    if (typeof cb !== "function") return () => undefined;
    const stop = listen("screen-teach:switching", (value: unknown) => {
      const s = (typeof value === "object" && value !== null ? value : {}) as { run?: unknown; on?: unknown; why?: unknown };
      if (typeof s.run !== "number" || !Number.isFinite(s.run) || typeof s.on !== "boolean") return;
      const why = typeof s.why === "string" ? s.why.slice(0, 24) : "";
      (cb as (switching: { run: number; on: boolean; why?: string }) => void)({ run: s.run, on: s.on, ...(why ? { why } : {}) });
    });
    ipcRenderer.send("screen-teach:hears-switching");
    return stop;
  },
  /** The student went to another app (true), or came back (false); the window stays up. */
  onAside: (cb: unknown): (() => void) => listen("screen-teach:aside", cb),
  /** Whether the student is with the lesson (false: in another app), with or without the companion,
   *  and as the page starts while they are away. The page's mics follow it, not the window's focus
   *  (the window never takes the keys with the companion on). */
  onPresent: (cb: unknown): (() => void) =>
    typeof cb === "function" ? listen("screen-teach:present", (present: unknown) => (cb as (present: boolean) => void)(present === true)) : () => undefined,
  /** ⌃⌥M, from any app: a tap on the page's mic (one question, an interrupt, or talk mode off, as
   *  the page's tap rule says). A channel of its own: a page older than it would take an unknown
   *  command for a key. */
  onTalk: (cb: unknown): (() => void) =>
    typeof cb === "function" ? listen("screen-teach:talk", () => (cb as () => void)()) : () => undefined,
  /** The talk chord, Control and Option held on their own from any app ({kind, ms}): "down" (held
   *  300 ms: the hold's ring), "tap" (let go within 700 ms: a tap on the mic), "hold" (5 s: talk
   *  mode on), "up" (let go after a hold), "cancel" (spoiled, or let go too late for a tap). Only a
   *  kind of those five and a finite ms reach the page. A channel of its own, for the same reason. */
  onChord: (cb: unknown): (() => void) =>
    typeof cb === "function"
      ? listen("screen-teach:chord", (value: unknown) => {
          const c = (typeof value === "object" && value !== null ? value : {}) as { kind?: unknown; ms?: unknown };
          const kind = c.kind;
          if (kind !== "down" && kind !== "tap" && kind !== "hold" && kind !== "up" && kind !== "cancel") return;
          if (typeof c.ms !== "number" || !Number.isFinite(c.ms)) return;
          (cb as (chord: { kind: string; ms: number }) => void)({ kind, ms: c.ms });
        })
      : () => undefined,
  /** Whether the talk chord can be used ({on}): told as the page gets ready, then on each change.
   *  Off while VoiceOver is on, while secure input is, or when the modifier keys look hidden from
   *  the helper: ⌃⌥M is the way in then, and the page names that. Only a boolean reaches the page.
   *  A channel of its own, for the same reason. */
  onChordState: (cb: unknown): (() => void) =>
    typeof cb === "function"
      ? listen("screen-teach:chord-state", (value: unknown) => {
          const on = typeof value === "object" && value !== null ? (value as { on?: unknown }).on : undefined;
          if (typeof on !== "boolean") return;
          (cb as (state: { on: boolean }) => void)({ on });
        })
      : () => undefined,
  /** The cursor, fed from the Mac app while the page asks for it (cursorFeed "main"). */
  onCursor: (cb: unknown): (() => void) => listen("screen-teach:cursor", cb),
  /** The card's pick ({window, x, y, choice, tap?, row?}: "explain" or "ask", the point as tapped,
   *  the release it opened for, the tapped row's words): resolves {ok: true}, or {ok: false,
   *  reason} when the window could not be read ("failed"), is private, or the tutor is off. */
  explainAt: (request: unknown): Promise<unknown> => ipcRenderer.invoke("screen-teach:explain-at", request),
  /** The card went without a pick: the careful read made for it is no longer its. */
  cardClosed: (): void => ipcRenderer.send("screen-teach:card-closed"),
  /** The card's box after each paint ({x, y, w, h}, the page's own points), or null once it has
   *  gone: the Mac app gives the page the clicks over it at once, ahead of the page's own word.
   *  Anything but four finite numbers is sent as null. */
  cardBox: (box: unknown): void => {
    const b = (typeof box === "object" && box !== null ? box : {}) as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
    const ok = [b.x, b.y, b.w, b.h].every((v) => typeof v === "number" && Number.isFinite(v));
    ipcRenderer.send("screen-teach:card-box", ok ? { x: b.x, y: b.y, w: b.w, h: b.h } : null);
  },
  /** A text field of the page is in use: the window takes the keys (true) until false. */
  wantKeys: (on: unknown): void => ipcRenderer.send("screen-teach:want-keys", on === true),
  /** Where the page gets the cursor: its own mouse moves ("page"), or the Mac app's feed ("main"). */
  cursorFeed: (from: unknown): void => ipcRenderer.send("screen-teach:cursor-feed", from === "main" ? "main" : "page"),
  /** The student's × in the page's dock with the companion on: the tutor turns off. */
  companionOff: (): void => ipcRenderer.send("screen-teach:companion-off"),
  /** The student paused the tutor from a dock (true) or played it on (false). */
  companionHold: (held: unknown): void => ipcRenderer.send("screen-teach:companion-hold", held === true),
  /** The page shows a dock of its own while the companion is on (true), or no longer (false). */
  companionDock: (on: unknown): void => ipcRenderer.send("screen-teach:companion-dock", on === true),
  /** A tap in a reader that the app used ({window, app, x, y}). No longer sent (the helper now
   *  reads the tapped words, so a tap on a reader's words is the tutor's): kept for a page that
   *  still listens. */
  onTapDropped: (cb: unknown): (() => void) => listen("screen-teach:tap-dropped", cb),
});

contextBridge.exposeInMainWorld(
  "anothernotes",
  Object.freeze({
    platform: process.platform,
    version: versionArg ? versionArg.slice(VERSION_FLAG.length) : "",
    ...(nativeSpeech ? { speech: speechBridge } : {}),
    ...(screenTeach ? { screenTeach: screenTeachBridge } : {}),
    auth: Object.freeze({
      /** Sign in with an email and password; on success the window moves to the dashboard. */
      signIn: (form: { email: string; password: string }): Promise<unknown> =>
        ipcRenderer.invoke("auth:sign-in", { email: form?.email, password: form?.password }),
      /** Sign in through the system browser; the app comes back signed in on its own. */
      signInWithBrowser: (): Promise<void> => ipcRenderer.invoke("auth:sign-in-with-browser"),
      /** Show the app's sign-in screen in this window. */
      signInHere: (): Promise<void> => ipcRenderer.invoke("auth:sign-in-here"),
      /** Forget a browser sign-in that was started and not finished. */
      cancelBrowserSignIn: (): Promise<void> => ipcRenderer.invoke("auth:cancel-browser-sign-in"),
    }),
  }),
);

/** The tab bar's height (TOOLBAR_HEIGHT in windows.ts): the room the page makes for it. */
const BAR = 38;

/** A computed colour that covers what is under it (an alpha of 1, or none given). */
function opaque(color: string): boolean {
  if (!color || color === "transparent") return false;
  const rgba = color.match(/^rgba?\(([^)]*)\)$/);
  if (rgba) {
    const parts = rgba[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length < 4 || Number(parts[3]) >= 0.98;
  }
  const slash = color.match(/\/\s*([\d.]+)(%?)\s*\)$/);
  return !slash || Number(slash[1]) / (slash[2] ? 100 : 1) >= 0.98;
}

/** Floating layers that may pass over the page's top (menus, tooltips, toasts, dialogs): never the page's colour. */
const FLOATING = '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], [role="tooltip"], [data-sonner-toaster]';

/*
  The window's tab bar sits over the content column, starting where the web app's
  sidebar ends (windows.ts). The page is the only one that knows where that is, so this
  reports it, and the sidebar's colour, whenever either changes: the sidebar resized or
  folded away, the theme or a note's sheet colour switched, another page shown. -1 means
  the page has no sidebar.
  It also reports the page's own colour just under the bar (the surface), which the
  active tab takes so that it runs into the page as Notion's does: the colour of the
  topmost opaque layer there that is the page itself, one spanning the whole content
  column down to the window's bottom (the page column with its sheet, Read mode, the
  PDF reader), never a card, a code block or a picture scrolled under it. And a dialog's
  backdrop while one is open (a full-window layer the web app dims itself with), so the
  tab bar, which sits above the page, can be dimmed with it; the surface is not read
  again until it closes.
*/
function reportChrome(): void {
  let last = "";
  let surface = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Topmost first, so a layer over the page (Read mode, the PDF reader) wins over the page.
  const surfaceAt = (x: number, y: number, left: number): string => {
    // A modal menu or dialog has switched the page's pointer events off (Radix sets them on
    // <body>), which hides every layer from elementsFromPoint: keep what was there.
    if (getComputedStyle(document.body).pointerEvents === "none") return surface;
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.closest(FLOATING)) continue;
      const color = getComputedStyle(el).backgroundColor;
      if (!opaque(color)) continue;
      const box = el.getBoundingClientRect();
      if (box.left <= left + 2 && box.right >= innerWidth - 2 && box.top <= y && box.bottom >= innerHeight - 2) return color;
    }
    const page = getComputedStyle(document.body).backgroundColor;
    return opaque(page) ? page : surface;
  };
  const report = (): void => {
    timer = undefined;
    const sidebar = document.querySelector('[data-sidebar="sidebar"]');
    const shell = document.querySelector(".peer ~ main");
    let right = -1;
    if (shell) {
      const box = sidebar?.getBoundingClientRect();
      right = box && box.width > 0 && box.right > 0 ? Math.round(box.right) : 0;
    }
    const painted = sidebar ?? document.body;
    const background = painted ? getComputedStyle(painted).backgroundColor : "";
    let scrim = "";
    for (const el of Array.from(document.querySelectorAll('[data-state="open"]'))) {
      const style = getComputedStyle(el);
      if (style.position !== "fixed" || /rgba\(0, 0, 0, 0\)|transparent/.test(style.backgroundColor)) continue;
      const box = el.getBoundingClientRect();
      if (box.left <= 0 && box.top <= 0 && box.right >= innerWidth - 1 && box.bottom >= innerHeight - 1) {
        scrim = style.backgroundColor;
        break;
      }
    }
    // Under where the first tabs are: the page starts below the bar in the sidebar layout,
    // and at its own top without one (windows.ts lays it out below the bar then).
    if (!scrim && document.body) {
      const left = Math.max(right, 0);
      surface = surfaceAt(Math.min(innerWidth - 1, left + 160), right >= 0 ? BAR + 6 : 6, left);
    }
    if (location.protocol === "app:" && sidebarSettled === null) settleSidebar();
    // A reader over the whole page (Read mode, the PDF's full-page reader): the tab bar
    // makes way for it, its own top bar (Close, the background, full screen) being where the
    // bar sits. The web app's own test of it: lib/study/pageCover.ts studyPageCovered.
    const reading = Boolean(document.body?.classList.contains("pdf-reading") || document.querySelector("[data-read-theme]"));
    const state = { right, background, surface, scrim, reading, dark: document.documentElement.classList.contains("dark") };
    const key = JSON.stringify(state);
    if (key === last) return;
    last = key;
    ipcRenderer.send("chrome:layout", state);
  };
  const soon = (): void => {
    if (timer === undefined) timer = setTimeout(report, 60);
  };
  new MutationObserver(soon).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "data-state", "data-collapsible", "data-scroll-locked", "data-an-sheet"],
  });
  window.addEventListener("resize", soon);
  document.addEventListener("transitionend", soon, true);
  report();
}

/*
  window.SpeechRecognition, over the Mac's own speech recognition. The web app's dictation
  and Teach mode drive a browser's recogniser (lib/guide/speech.ts createNativeRecognizer
  in the web repo): lang, continuous, interimResults, start/stop/abort, and the events
  start, audiostart, speechstart, result (results[i].isFinal, results[i][0].transcript,
  resultIndex), error (error: a code) and end. This is that surface, in the page's own
  world before any of its scripts run, backed by the bridge above; Chromium's own
  recogniser, which has no speech service behind it in the app, is put aside.

  Continuous: every finished phrase is one final result, kept in order, and the words in
  flight the one interim result after them. One utterance: a single result at index 0,
  interim until the utterance is done, then final, then end.

  Two fields of the Mac's own, set before start() (the web app's createNativeRecognizer does,
  when speech.native): tutornotePreroll (unix ms, the student's press: the words said since
  are fed from the microphone's ring) and tutornoteHints (the lesson's words). A browser's
  recogniser has neither, and ignores them.
*/
if (nativeSpeech) {
  contextBridge.executeInMainWorld({
    func: () => {
      type Bridge = {
        start: (
          lang: string,
          continuous: boolean,
          onEvent: (event: { ev: string; text?: string; code?: string }) => void,
          opts?: { preroll?: number; hints?: string[] },
        ) => number;
        stop: (ref: number) => void;
        abort: (ref: number) => void;
      };
      const found = (window as unknown as { anothernotes?: { speech?: Bridge } }).anothernotes?.speech;
      if (!found) return;
      const bridge: Bridge = found;
      const result = (transcript: string, isFinal: boolean) => {
        const alternative = { transcript, confidence: isFinal ? 1 : 0.5 };
        return { 0: alternative, length: 1, isFinal, item: () => alternative };
      };
      class Recognition extends EventTarget {
        lang = "";
        continuous = false;
        interimResults = false;
        maxAlternatives = 1;
        onstart: ((e: Event) => void) | null = null;
        onaudiostart: ((e: Event) => void) | null = null;
        onsoundstart: ((e: Event) => void) | null = null;
        onspeechstart: ((e: Event) => void) | null = null;
        onspeechend: ((e: Event) => void) | null = null;
        onsoundend: ((e: Event) => void) | null = null;
        onaudioend: ((e: Event) => void) | null = null;
        onresult: ((e: Event) => void) | null = null;
        onnomatch: ((e: Event) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        onend: ((e: Event) => void) | null = null;
        /** The Mac's own: where the first request's audio starts (unix ms), and the lesson's words. */
        tutornotePreroll: number | undefined = undefined;
        tutornoteHints: string[] | undefined = undefined;
        private ref: number | null = null;
        private finals: string[] = [];

        private fire(name: string, props: Record<string, unknown> = {}): void {
          const event = Object.assign(new Event(name), props);
          this.dispatchEvent(event);
          const handler = (this as unknown as Record<string, unknown>)[`on${name}`];
          if (typeof handler === "function") (handler as (e: Event) => void).call(this, event);
        }

        private results(interim: string | null) {
          const list = this.finals.map((text) => result(text, true));
          if (interim !== null) list.push(result(interim, false));
          return Object.assign(list, { item: (i: number) => list[i] });
        }

        start(): void {
          if (this.ref !== null) throw new DOMException("recognition has already started", "InvalidStateError");
          this.finals = [];
          const opts: { preroll?: number; hints?: string[] } = {};
          if (typeof this.tutornotePreroll === "number") opts.preroll = this.tutornotePreroll;
          if (Array.isArray(this.tutornoteHints)) opts.hints = this.tutornoteHints;
          const ref = bridge.start(this.lang || navigator.language || "en-US", !!this.continuous, (event) => this.on(ref, event), opts);
          this.ref = ref;
        }

        private on(ref: number, event: { ev: string; text?: string; code?: string }): void {
          if (this.ref !== ref) return;
          switch (event.ev) {
            case "start":
            case "audiostart":
            case "speechstart":
              this.fire(event.ev);
              return;
            case "interim":
              if (this.interimResults) this.fire("result", { results: this.results(event.text ?? ""), resultIndex: this.finals.length });
              return;
            case "phrase":
              if (!event.text) return;
              this.finals.push(event.text);
              this.fire("result", { results: this.results(null), resultIndex: this.finals.length - 1 });
              return;
            case "error":
              this.ref = null;
              this.fire("error", { error: event.code || "network", message: "" });
              this.fire("end");
              return;
            case "end":
              this.ref = null;
              if (event.text) {
                this.finals.push(event.text);
                this.fire("result", { results: this.results(null), resultIndex: this.finals.length - 1 });
              }
              this.fire("end");
              return;
            default:
              return;
          }
        }

        stop(): void {
          if (this.ref !== null) bridge.stop(this.ref);
        }

        abort(): void {
          const ref = this.ref;
          if (ref === null) return;
          this.ref = null;
          bridge.abort(ref);
          queueMicrotask(() => {
            this.fire("error", { error: "aborted", message: "" });
            this.fire("end");
          });
        }
      }
      const w = window as unknown as Record<string, unknown>;
      w.SpeechRecognition = Recognition;
      w.webkitSpeechRecognition = Recognition;
    },
  });
}

/*
  document.cookie on the bundled web app. Chromium keeps cookies only for http(s), so on
  the app's own scheme (app://anothernotes) every cookie the web app sets is dropped, and
  the preferences it keeps there (the sidebar docked or not) reset at each launch. This
  gives the page a small cookie store in its localStorage instead, installed in the
  page's own world before any of its scripts run. The server's cookies are unaffected:
  they never reach the page (server.ts keeps them in the main process).
*/
if (location.protocol === "app:") {
  contextBridge.executeInMainWorld({
    func: () => {
      const KEY = "__anothernotes_cookies";
      type Jar = Record<string, { value: string; expires: number | null }>;
      const load = (): Jar => {
        try {
          return JSON.parse(localStorage.getItem(KEY) || "{}") as Jar;
        } catch {
          return {};
        }
      };
      const save = (jar: Jar): void => {
        try {
          localStorage.setItem(KEY, JSON.stringify(jar));
        } catch {
          /* storage full or blocked: the cookie lasts as long as the page */
        }
      };
      const live = (jar: Jar): Jar => {
        const now = Date.now();
        for (const name of Object.keys(jar)) {
          const expires = jar[name].expires;
          if (expires !== null && expires <= now) delete jar[name];
        }
        return jar;
      };
      Object.defineProperty(Document.prototype, "cookie", {
        configurable: true,
        get(): string {
          const jar = live(load());
          return Object.keys(jar)
            .map((name) => `${name}=${jar[name].value}`)
            .join("; ");
        },
        set(line: string) {
          const [pair, ...attributes] = String(line).split(";");
          const eq = pair.indexOf("=");
          if (eq <= 0) return;
          const name = pair.slice(0, eq).trim();
          const value = pair.slice(eq + 1).trim();
          let expires: number | null = null;
          for (const attribute of attributes) {
            const [key, ...rest] = attribute.split("=");
            const k = key.trim().toLowerCase();
            const v = rest.join("=").trim();
            if (k === "max-age") expires = Date.now() + Number(v) * 1000;
            else if (k === "expires" && expires === null) expires = Date.parse(v);
          }
          // The desktop is making this page's sidebar follow another page's fold or unfold
          // (followSidebar): that choice is in the jar already, and saving it again from here
          // would send it round the other pages once more.
          const root = document.documentElement;
          if (name === "sidebar:open" && root.hasAttribute("data-an-following")) return;
          const jar = live(load());
          if (expires !== null && (Number.isNaN(expires) || expires <= Date.now())) delete jar[name];
          else jar[name] = { value, expires };
          save(jar);
          // This page's own choice, which its sidebar already shows (settleSidebar).
          if (name === "sidebar:open") root.setAttribute("data-an-sidebar-chose", jar[name] ? JSON.stringify(jar[name]) : "");
        },
      });
    },
  });
}

/*
  Room in the web app's layout for the window's chrome, in place before the web app
  draws anything (a style added after its first paint would make the page jump). The
  selectors are the sidebar component's: its header, above whose brand block the window
  buttons sit and whose strip moves the window; its edge strip, which folds and resizes
  the sidebar and must never drag the window instead; and the content column, which
  starts below the tab bar (BAR, TOOLBAR_HEIGHT in windows.ts). The column is the
  window's height less the bar: flush with the sidebar, as the web app lays it out now
  (variant "sidebar"), or less its card's bottom margin should it go back to the inset
  card it used to be.
*/
const SHELL_CSS = `
  @media (min-width: 768px) {
    .peer ~ main { margin-top: ${BAR}px !important; height: calc(100svh - ${BAR}px) !important; min-height: 0 !important; }
    .peer[data-variant="inset"] ~ main { height: calc(100svh - ${BAR}px - 0.5rem) !important; }
    [data-sidebar="header"] { padding-top: ${process.platform === "darwin" ? BAR - 4 : 8}px !important; -webkit-app-region: drag; }
    [data-sidebar="header"] :is(a, button, input, select, textarea, [role="button"], [role="combobox"], [tabindex]) {
      -webkit-app-region: no-drag;
    }
    [data-sidebar="rail"] { -webkit-app-region: no-drag; }
    /* The PDF full-page reader (web index.css .pdf-reader) fills the window; here the tab bar
       covers its top ${BAR}px, and the window buttons and the sidebar header's drag strip sit
       there too. So it starts below the bar, and it is never part of the drag strip. Its
       pages fit its own box (PdfDocument measureFit). Only in the sidebar layout, where the
       page starts at the window's top. */
    .peer ~ main .pdf-doc.pdf-reader { top: ${BAR}px !important; -webkit-app-region: no-drag; }
    .peer ~ main .pdf-reader-top { top: ${BAR}px !important; }
    .peer ~ main .pdf-reader-arrow { top: calc(50% + ${BAR / 2}px) !important; }
    .pdf-reader-bar, .pdf-reader-arrow { -webkit-app-region: no-drag; }
  }
`;

/*
  Links routed before the page follows them. Notes and learning sessions open in tabs
  and everything else in the home page (windows.ts), so a link that leads across that
  line is handed to the app instead: a note clicked in the home page's sidebar opens in
  its tab while the home page stays as it was, and "Dashboard" clicked in a note's tab
  shows the home page while the tab keeps its note. Links within the page's own side of
  the line, and anything the page handles itself, go on as usual. The app says which
  role this page has (home, note, or a page out of sight, which routes nothing).
*/
let role = "";
ipcRenderer.on("tabs:role", (_event, value: unknown) => {
  role = typeof value === "string" ? value : "";
});

/** The note or session a path shows (the same rule as noteKey in windows.ts), or null. */
function noteOf(pathname: string): string | null {
  const where = pathname.replace(/\/+$/, "");
  const note = where.match(/^\/dashboard\/note\/([^/]+)$/);
  if (note) return note[1];
  const study = where.match(/^\/dashboard\/([^/]+)\/full-study$/);
  if (study) return study[1];
  return where === "/dashboard/full-study" ? "full-study" : null;
}

function routeLinks(): void {
  window.addEventListener(
    "click",
    (event) => {
      if (role !== "home" && role !== "note") return;
      if (event.defaultPrevented || event.button !== 0 || event.altKey || event.shiftKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const to = new URL(link.href, location.href);
      if (to.protocol !== location.protocol || to.host !== location.host) return;
      const there = noteOf(to.pathname);
      const here = noteOf(location.pathname);
      const elsewhere = role === "home" ? there !== null : there === null || there !== here;
      if (!elsewhere) return;
      // A link in the home page's own content (a dashboard card; the exam plan's link carries
      // router state, { plan: true }) goes through the web app's router, which keeps that
      // state, and the page then becomes the note's tab (route -> becomeTab in windows.ts),
      // as a button's navigate() does. The sidebar, its rail menus (portaled outside it) and
      // the narrow-window sheet are not in <main>, so their links are still routed here.
      if (role === "home" && link.closest("main")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ipcRenderer.send("nav:open", `${to.pathname}${to.search}${to.hash}`);
    },
    true,
  );
}


/*
  One sidebar for the window. Each tab is its own copy of the web app, which reads
  whether its sidebar is open, and how wide it was dragged, once, as it starts; so when
  it is folded, opened or resized in one tab, the others follow. Open or folded lives in
  the pages' shared cookie store (the localStorage one above, cookie "sidebar:open") and
  the width in their localStorage ("sidebar:width"), both ui/sidebar.tsx in the web repo:
  a change to either reaches every other page as a storage event.
  The web app writes the cookie only when the student folds or opens the sidebar (never
  on its own: a tablet-width window starting as the rail, or Teach mode folding it for its
  board, saves nothing), so the cookie is the student's latest choice. A page matches it
  once, when its sidebar is first drawn (a page started at a window width of 900 to 1023
  starts as the rail whatever the choice), then whenever another page makes a new one,
  in or out of sight, and as it comes on screen if one came while it could not follow.
  What a page has matched is kept (sidebarSettled), so a fold of its own that saved
  nothing (Teach mode's) stays until the student chooses again.
  A page that is the other way presses the web app's own fold button: not a ⌘B, which the
  PDF reader keeps for itself and a talk key set to ⌘B would take. While it does, the
  cookie store does not save the choice again (data-an-following, above), so nothing
  echoes back.
*/
const SIDEBAR_OPEN_COOKIE = "sidebar:open";
const COOKIE_JAR_KEY = "__anothernotes_cookies";

/** The sidebar choice this page shows: an entry of the jar ("" for none yet), or null before its sidebar is drawn. */
let sidebarSettled: string | null = null;

/** The sidebar cookie in the shared jar, as written (value and expiry: every write differs), or "". */
function sidebarEntry(jar: string | null): string {
  try {
    const entry = (JSON.parse(jar || "{}") as Record<string, unknown>)[SIDEBAR_OPEN_COOKIE];
    return entry ? JSON.stringify(entry) : "";
  } catch {
    return "";
  }
}

/**
 * Open (true) or fold (false) this page's sidebar for a choice made in another page. False
 * when the page cannot follow yet: no sidebar drawn, its edge being dragged, no fold button.
 */
function followSidebar(entry: string): boolean {
  let open: boolean | null = null;
  try {
    const value = (JSON.parse(entry) as { value?: unknown }).value;
    if (value === "true" || value === "false") open = value === "true";
  } catch {
    /* not a choice: nothing to follow */
  }
  const state = document.querySelector(".peer[data-state]")?.getAttribute("data-state");
  if (!state) return false;
  if (open === null || (state === "expanded") === open) return true;
  // This page's own edge strip is being dragged: the drag owns the sidebar until it ends.
  if (document.querySelector('[class~="group/sidebar-wrapper"]')?.hasAttribute("data-resizing")) return false;
  // FoldButton in AppSidebar.tsx, in both states; not the Search button (Meta+K) beside it.
  const fold = document.querySelector<HTMLButtonElement>('[data-sidebar="sidebar"] button[aria-keyshortcuts~="Meta+B"]');
  if (!fold) return false;
  const root = document.documentElement;
  root.setAttribute("data-an-following", "");
  try {
    fold.click();
  } finally {
    root.removeAttribute("data-an-following");
  }
  return true;
}

/** Match this page's sidebar to the student's latest choice, unless it already shows it. */
function settleSidebar(): void {
  let entry: string;
  try {
    entry = sidebarEntry(localStorage.getItem(COOKIE_JAR_KEY));
  } catch {
    return;
  }
  if (sidebarSettled !== null && entry === sidebarSettled) return;
  // Chosen here: the sidebar already shows it.
  if (sidebarSettled !== null && entry === document.documentElement.getAttribute("data-an-sidebar-chose")) {
    sidebarSettled = entry;
    return;
  }
  if (!entry) {
    if (document.querySelector(".peer[data-state]")) sidebarSettled = "";
    return;
  }
  if (followSidebar(entry)) sidebarSettled = entry;
}

/** The widths the web app's edge strip allows (SIDEBAR_MIN_PX and SIDEBAR_MAX_PX in ui/sidebar.tsx). */
const SIDEBAR_WIDTH_KEY = "sidebar:width";
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 480;

function followSidebarWidth(value: string | null): void {
  const px = Number(value);
  if (!value || !(px >= SIDEBAR_WIDTH_MIN && px <= SIDEBAR_WIDTH_MAX)) return;
  const wrapper = document.querySelector<HTMLElement>('[class~="group/sidebar-wrapper"]');
  // Not while this page's own strip is being dragged: the drag owns the width until it ends.
  if (!wrapper || wrapper.hasAttribute("data-resizing")) return;
  const width = `${Math.round(px)}px`;
  if (wrapper.style.getPropertyValue("--sidebar-width") === width) return;
  wrapper.style.setProperty("--sidebar-width", width);
  // Where the open sidebar ends, for what lines up with it from outside the shell (the
  // consent card, Teach mode's reading column), as the web app's own drag sets it.
  if (document.querySelector(".peer[data-state]")?.getAttribute("data-state") === "expanded") {
    document.documentElement.style.setProperty("--an-sidebar-edge", width);
  }
}

if (!screenTeach && location.protocol === "app:") {
  window.addEventListener("storage", (event) => {
    if (event.key === COOKIE_JAR_KEY) {
      if (sidebarEntry(event.newValue) !== sidebarEntry(event.oldValue)) settleSidebar();
    } else if (event.key === SIDEBAR_WIDTH_KEY) followSidebarWidth(event.newValue);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    settleSidebar();
    try {
      followSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    } catch {
      /* storage blocked: the page keeps the width it has */
    }
  });
}

/* Last, so that everything they use above is defined (sidebarSettled for reportChrome). */
if (!screenTeach && (location.protocol === "app:" || location.protocol === "http:" || location.protocol === "https:")) {
  webFrame.insertCSS(SHELL_CSS);
  routeLinks();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reportChrome);
  else reportChrome();
}
