import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
  shell,
  WebContentsView,
  type BaseWindowConstructorOptions,
  type BrowserWindowConstructorOptions,
  type ContextMenuParams,
  type Display,
  type MenuItemConstructorOptions,
  type Rectangle,
  type WebContents,
} from "electron";
import { execFile } from "node:child_process";
import path from "node:path";
import {
  BOARD_COPY,
  boardMoveOf,
  boardPlaceFor,
  boardPlaceMsg,
  clampBoardZoom,
  coversReading,
  displayChanged,
  fullScreenFrame,
  leavesTab,
  mainCanHold,
  overlayArea,
  overlayHome,
  type BoardPlace,
  type BoardPrefs,
  type BoardWhere,
  type OverlayHome,
  type Reading,
} from "./boardHost";
import { boardStateOf, BOARD_MIN, opaqueColor, placeBoard, textBox } from "./boardPlace";
import { isBrowserApp, isPrivateApp, isReaderApp, selectionKept, tapNumbers, windowIdOf } from "./companionPlace";
import { APP_ORIGIN, originOf } from "./config";
import {
  anotherWindow,
  bodyRows,
  docKeyOf,
  firstBodyPoint,
  frameMove,
  identFrame,
  identVerdict,
  MOVE_SAME_SIZE,
  sameDocument,
  SWITCH_MIN_H,
  SWITCH_MIN_W,
  titleChange,
  type IdentLesson,
  type SwitchWhy,
} from "./docIdentity";
import { appEvents } from "./events";
import { openExternal } from "./links";
import { watchLessonAudio } from "./media";
import {
  accessibilityAllowed,
  bringWindowForward,
  chordWatch,
  cursorStream,
  hideFromCapture,
  noActivateWindow,
  observePaged,
  observeWindows,
  readWindow,
  ScreenReadError,
  turnWindow,
  unwatchWindow,
  watchEvents,
  watchWindow,
  type ScreenChanged,
  type ScreenChord,
  type ScreenChordState,
  type ScreenIdent,
  type ScreenKeyed,
  type ScreenLine,
  type ScreenPress,
  type ScreenRead,
  type ScreenScroll,
  type ScreenTap,
  type ScreenTurn,
  type ScreenTurned,
} from "./screen";
import { rereadLine, toLocal, turnReadLine } from "./screenRead";
import { nativeSpeechAvailable } from "./speech";
import { loadBoardPrefs, loadScreenBoard, saveBoardPrefs, saveScreenBoard } from "./store";
import {
  boardTabActive,
  boardTabDocked,
  bringMainForward,
  dockBoardView,
  getMainWindow,
  hideBoardTab,
  mainWindowLook,
  navigateTo,
  selectBoardTab,
  setBoardTabInfo,
  showBoardTab,
  undockBoardView,
} from "./windows";

/*
  Teach mode over another app's window ("screen teach"). Once a pick has been read
  (explain.ts), the web app's own Teach mode runs over the window that was read: one
  see-through window over that display's work area (not under the Dock or the menu bar, which
  macOS draws above it, so the lesson's own dock and chip never sit under them; all of the
  display when the window read is in native full screen, where both are hidden: boardHost.ts
  overlayArea) loads the web app's /dashboard/screen-teach page,
  with the preload's screenTeach bridge (src/preload/index.ts). The page lays the words
  out as a stand-in page and teaches it with the same pointer, marks, caption, voice and
  board as a PDF in the app. When it has taught what is on screen it asks here to turn
  the other app's page (or scroll it), and gets that window read again.

  The window lets every click through to the app below, except over the page's own
  controls (the board, the dock), which the page reports as the pointer moves over them.
  It is kept, hidden, between lessons, so the next pick starts at once: a new pick sends
  it a new start, and anything about an older start (its run) is ignored.

  Every rectangle the page is sent, or sends, is in its own CSS pixels: screen points less
  the window's top left (its zoom stays at 1). The shapes mirror the web app's
  src/lib/screen/types.ts.

  explain.ts hears about the lesson through appEvents: "screen-teach-started" (the lesson
  is on screen: its status panel goes), "screen-teach-closed", and "screen-teach-failed"
  (with the words to show in that panel).

  Companion mode (companion.ts, the tutor that trails the cursor over any app): the same window
  stays up for as long as the tutor is on, lesson or not, over the work area of the display the
  cursor is on (the lesson's, while one runs). It never takes the keys then (focusable false),
  except while the page asks for them (a question typed to the tutor: want-keys), so the
  student's arrow keys stay with the app being read. A lesson ending or the student going to
  another app no longer hides it: the lesson's own marks and dock step aside in the page
  (screen-teach:aside), and the tutor goes on following the cursor. companion.ts hears of every
  accurate read of the lesson's window ("screen-teach-read"), to keep its glance of that window
  current, and that the window is gone ("screen-teach-gone").

  Another document where a lesson teaches (another tab in its window, another window of its app,
  a reader the student stays in): the lesson stops at once and a new run starts on that document
  (beginSwitch, switchRead; APP_FOLLOW_MS says how it is noticed). The page hears it on its own
  channel (screen-teach:switching), and says it listens there (screen-teach:hears-switching): a
  page older than it, which would neither stop for it nor hold the new run until Play, gets no
  switch, and its lesson goes on as before.
*/

type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

type ScreenMode = "scroll" | "page";
type ScreenCommand = "toggle-play" | "next" | "prev" | "close" | "pause" | "resume";

/** What the student picked on the companion's card: explain from there, or ask a question. */
type ScreenChoice = "explain" | "ask";

interface ScreenStart {
  run: number;
  overlay: Rect;
  read: ScreenRead;
  click: Point;
  canTurn: boolean;
  mode: ScreenMode;
  /** Companion mode: the card's pick that started this run. */
  choice?: ScreenChoice;
  /** A later run of one companion session, or a run started afresh where its window went
   *  (rehome): no greeting, no start sound. */
  quiet?: boolean;
  /** Started by the companion (the overlay stays up between lessons). */
  companion?: boolean;
  /** How bright the page read is, 0 to 1 (ScreenRead.ground): the marks' palette. */
  ground?: number;
  /** Companion mode: the words of the row the student tapped, as the page read them (the card's
   *  pick), so the page can find that row in this read when the two disagree at a boundary. */
  row?: string;
  /** The window scrolled or changed since this read was taken at the tap: the page starts from it
   *  and reads the window again once the lesson is up. */
  stale?: true;
  /** Another document was seen where the last run was teaching (switchRead): this run is that
   *  document's, started quietly at its first words, and plays only if the last one was playing
   *  (the page remembers that from screen-teach:switching). Never sent to a page older than it
   *  (pageHearsSwitching). */
  switched?: true;
  /** A run started afresh where its window went (rehome: another display, full screen in or out,
   *  its display changed): the same document, and it plays on only if the run before was playing.
   *  One the student had paused, one standing on a new document's first words, or a held tutor,
   *  stands on its first words until Play, as a switched run that does not play (the page
   *  decides: it knows the run before). A page older than it hears a pick, and plays. */
  rehomed?: true;
}

/** How a lesson was asked for: by the companion's card (companion.ts), or by a pick; or by the
 *  lesson itself, for another document (switched). */
export interface ScreenTeachOptions {
  choice?: ScreenChoice;
  quiet?: boolean;
  companion?: boolean;
  row?: string;
  stale?: boolean;
  switched?: boolean;
  /** Started afresh where its window went (rehome): ScreenStart.rehomed. */
  rehomed?: boolean;
  /** Asked once the run's wait for the Accessibility answer is over, just before it starts: false
   *  and it never starts (the switch that asked for it was a flick after all, or the student went
   *  on to another app meanwhile). */
  still?: () => boolean;
}

/** What the page is told of the companion (screen-teach:companion): on or off; the overlay's own
 *  rectangle in screen points; where the tutor hops out from (the blob), or flies home to, in the
 *  overlay's points; and whether this is the first time ever (its tip). */
interface CompanionMessage {
  on: boolean;
  overlay: Rect;
  from?: Point;
  first: boolean;
  to?: Point;
}

interface ScreenTurnRequest {
  run: number;
  dir: "forward" | "back";
  scrollBy: number;
  pages: number;
  at: Point;
  how: "auto" | "manual";
  unlessMoved: boolean;
}

type ScreenTurnResult =
  | { ok: true; how: "scroll" | "key" | "manual"; mode: ScreenMode; read: ScreenRead; canTurn?: boolean }
  | { ok: false; reason: "end" | "stuck" | "no_access" | "no_permission" | "window_gone" | "failed" | "stale" };

/** A way of moving the app on: scrolling, or a key (forward; back is its opposite). */
type Way = { how: "scroll" } | { how: "key"; key: "right" | "pagedown" };

const ROUTE = "/dashboard/screen-teach";
/** Apps that turn whole pages (Kindle, Books). Any other app is taken to scroll until a turn shows otherwise. */
const PAGE_APPS = new Set(["com.amazon.Lassen", "com.apple.iBooksX"]);
const SETTINGS_URLS = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};
const BACK_KEY = { right: "left", pagedown: "pageup" } as const;
/** How long a way not yet seen to work is given to change the window, and the one that has. */
const TRY_TIMEOUT_MS = 2_500;
const TURN_TIMEOUT_MS = 4_000;
/** The helper presses a key this often when it presses it more than once. */
const KEY_GAP_MS = 250;
/** The student turning the page themselves: as long as they like, within reason. */
const MANUAL_WAIT_MS = 180_000;
/** The page says it is ready within this long, or the lesson is given up. */
const READY_TIMEOUT_MS = 20_000;
/** A scroll the page gave no distance for. */
const DEFAULT_SCROLL = 600;
/** While a lesson is on screen, from any app. */
const SHORTCUTS: ReadonlyArray<[string, ScreenCommand]> = [
  ["Control+Alt+Space", "toggle-play"],
  ["Control+Alt+Right", "next"],
  ["Control+Alt+Left", "prev"],
];
/** The talk key, from any app, while a lesson is on screen and while the companion is on without
 *  one (its dock's mic starts a lesson there). The student's way in is Control and Option on their
 *  own (the talk chord, screen.ts chordWatch, watched exactly while this is registered): a tap asks
 *  one question, a 5 s hold turns talk mode on (screen-teach:chord, the page decides). ⌃⌥M stays as
 *  the way in where the chord cannot be (VoiceOver owns Control and Option, a helper that cannot
 *  see the modifier keys, a page older than the chord), and it means a TAP of the mic now, never
 *  talk mode by itself: a one question mic, an interrupt, or talk mode off, as the page's tap rule
 *  says (a page older than this round still takes it as its old toggle).
 *  Its own channel (screen-teach:talk), not a ScreenCommand: a page older than it would take an
 *  unknown command for a key. */
const TALK_SHORTCUT = "Control+Alt+M";
/** A chord "tap" this soon after ⌃⌥M, or after one of the lesson's own ⌃⌥ keys (SHORTCUTS: Space,
 *  the arrows), is that key's Control and Option let go, not a tap of its own (the helper sees the
 *  key and spoils the chord itself; this is in case it ever cannot, or a quick roll hides it). */
const TALK_KEY_CHORD_MS = 400;

/*
  Another document (the founder, 2026-10-27: "when we detect a change of screen, we have to change
  the way we explain ... right away"). A lesson knows the window it reads, not the document in it:
  a browser's tab switch keeps the window, and coming back to its app said only "back to the
  lesson". So the helper says which document the window shows (screen.ts ScreenIdent, every 150
  ms while it is watched), and docIdentity.ts decides by its title: another title in the lesson's
  window ("title"), another window of its app in front of it ("window"), the student staying
  APP_FOLLOW_MS in another app on a reading window there ("app": a reader, Preview, a browser's
  PDF; never a private app's), or, from a helper that says none of it, a tap whose verdict saw the
  title change ("tap"). Then the lesson stops at once (beginSwitch: its page hears
  screen-teach:switching, the board goes), the other document is read once it is still
  (switchRead: SWITCH_SETTLE_MS at most, then an accurate read, SWITCH_RETRIES more SWITCH_RETRY_MS
  apart while it has fewer than SWITCH_MIN_ROWS rows of its own), and a new run starts on it
  quietly, at its first words (openScreenTeach, switched), playing if the last one was (the page
  decides). The same look again after all (a title that changed by itself) is the same document:
  the lesson goes on (cancelSwitch), as it does for a flick (another tab and straight back). A
  title changed in its digits alone ("Lecture 3.pdf" to "Lecture 4.pdf") is looked at first, with
  nothing stopped (checkTitle): only a look unlike the lesson's starts a switch. A document with
  none of the page's own rows yet (a page still coming: a browser's bars alone) is read again
  every SWITCH_EMPTY_RETRY_MS until SWITCH_EMPTY_GIVE_UP_MS after it was seen; one that shows no
  words at all then ends the lesson. Nothing starts behind the student's back (waitSwitch): a
  browser's page with too little of its own to teach (a page still blank, a new tab, a search
  page: under SWITCH_MIN_WORDS words, but for a document's page, a PDF or one DOCUMENT_TITLE
  names, whose title slide may say five words), the student gone on to another app (or to their
  notes in Tutornote) while it was read, secure input on (a password field has the keys: nothing
  is read then), or the lesson's own window gone off the screen showing another tab, leave the
  lesson stopped, waiting (the page hears what for), and the other document is read again as that
  changes: a new title, a new look or a scroll there for words. Waiting, it goes where the student
  goes on to in the lesson's app (another of its windows, or the lesson's own showing another
  tab: retargetSwitch). Titles are the screen's words: the log says why and counts, never one.
*/
const APP_FOLLOW_MS = 1_500;
const SWITCH_SETTLE_MS = 1_500;
const SWITCH_RETRY_MS = 300;
const SWITCH_RETRIES = 2;
const SWITCH_MIN_ROWS = 3;
const SWITCH_EMPTY_RETRY_MS = 1_000;
const SWITCH_EMPTY_GIVE_UP_MS = 8_000;
const SWITCH_MIN_WORDS = 25;
/** A switch waiting for words reads again once the student's scroll there has stopped this long. */
const SWITCH_SCROLL_MS = 400;
/** A browser's page that is a document whatever it says: a file by its extension, or a page of a
 *  slides or documents app by the name its title carries. Matched, never logged. */
const DOCUMENT_TITLE = /\.(pdf|pptx?|key|docx?|xlsx?|od[pts]|epub)\b|\b(google (slides|docs|sheets)|powerpoint|keynote|word|excel|canva|prezi)\b/i;
/** The other titles a lesson keeps as its document's own (Lesson.titles), the latest. */
const OWN_TITLES = 8;

/** Another document seen (beginSwitch) and being read (switchRead): when it was seen (Date.now()),
 *  why, and the window to read, with its app's process and name. Left waiting with nothing
 *  started (waitSwitch): the other window's title then (`waiting`, which docIdentity.ts
 *  identVerdict reads again by), and what it waits for: words of the page's own, the student back
 *  in that app, secure input off, or the lesson's own window back on the screen. Taken to another
 *  app the student stayed in (maybeFollowApp), `from`: what it was reading in the lesson's app, read
 *  again as they come back there (onFront). Whether the lesson was playing is the page's to
 *  remember (`play` is never kept here). */
type Switching = {
  at: number;
  why: SwitchWhy;
  target: number;
  pid: number;
  app: string;
  waiting?: string;
  waitingFor?: "words" | "student" | "secure" | "screen";
  from?: { why: SwitchWhy; target: number };
  play?: never;
};

interface Lesson {
  run: number;
  window: number;
  pid: number;
  app: string;
  /** The read app's bundle id ("" when it had none): Back to {app} opens it. */
  bundle: string;
  mode: ScreenMode;
  /** The first way that moved the window in this run, kept for the rest of it. */
  way: Way | null;
  /**
   * One turn or read of the window at a time: two at once would post into each other.
   * Per lesson, so a new pick never waits behind the last one's turn (a student's own,
   * waited on for minutes).
   */
  queue: Promise<unknown>;
  /** The wait for the student's own turn going on, if any: given up when the lesson ends, and
   *  for the page's next request (the lesson has moved on, back to a page read already). */
  waiting: AbortController | null;
  /** The window read and its words (screen points), as of its latest read, moved with the window
   *  by every move of it since (followFrame), the window's frame taken as it is at a resize (its
   *  words wait for a read): where the board goes beside them (placeBoardFor). */
  frame: Rect;
  text: Rect | null;
  /** Where its run put the lesson's window (boardHost.ts overlayHome): over which display, that
   *  display's bounds, and over all of it or its work area. A read of the window wanting it
   *  elsewhere starts the run afresh there (rehomeSoon). */
  home: OverlayHome;
  /** Its lines (screen points), as of its latest read: a tap on none of them was on no words, and
   *  a read of another document is told from the same look by them (docIdentity.ts sameLook). */
  lines: ReadonlyArray<ScreenLine>;
  /** Its title, as of its latest read: a browser's window showing a PDF ends in ".pdf", where a
   *  double click on a word is the student's (onTap, companionPlace.ts selectionKept); and what
   *  another title in the window is told from (onIdent). */
  title: string;
  /** The document's key, as of its latest read (docIdentity.ts docKeyOf). */
  doc: string;
  /** The window's latest look (screen points): its latest read, a quick one after a scroll
   *  included (screen-teach:reread fast), which `lines` leaves out. Another document is told from
   *  the same look by it as well as by `lines` (switchRead, checkTitle): after a scroll the page
   *  followed with quick reads, `lines` is the look from before it. With its app's bundle: a
   *  browser's own bars are no part of a look (docIdentity.ts bodyRows). */
  look: { frame: Rect; lines: ReadonlyArray<ScreenLine>; bundle: string };
  /** Other titles its document has shown, the latest OWN_TITLES: one that changed by itself, the
   *  same look found under the new one (keepTitle). A title among them is the lesson's own
   *  (docIdentity.ts identVerdict): a page whose title flashes a notice and back is not two. */
  titles: string[];
  /** Its app's front window as the helper last said it while that app was in front (undefined:
   *  not said yet in this run). Another window of its app is another document as it comes to the
   *  front, never because it was already there as the lesson began (onIdent). */
  top?: number;
  /** The title a quick look is being taken for (checkTitle), or null. */
  checking: string | null;
  /** Another document seen and being read, or null (Switching). */
  switching: Switching | null;
  /** When the last switch began (Date.now(), 0 before any): a read begun before then may show the
   *  other document, even when that switch was a flick. */
  switchedAt: number;
  /** When its last turn ended (Date.now(), 0 before any): a read of the window begun before then
   *  shows it as it was, and the helper says no new look while a lesson's own turn goes on. */
  turnedAt: number;
  /** The turn of its own the lesson has posted ("auto"), going on, or null: a title that numbers
   *  the pages moves with it (checkTitle). */
  moving: Promise<unknown> | null;
}

let win: BrowserWindow | null = null;
/** The page in the window has asked for its start since it last loaded. */
let pageReady = false;
let readyTimer: NodeJS.Timeout | undefined;
let runs = 0;
let lesson: Lesson | null = null;
/** What the page is to run: sent with each pick, and given again whenever it asks (a reload). */
let pending: ScreenStart | null = null;
/** The page asked for clicks (the pointer is over one of its controls). */
let interactive = false;
/** Scrolls in flight: they must reach the app below even over the page's controls. */
let scrolling = 0;
/** What the window was last told (setIgnoreMouseEvents). */
let ignoring = true;
/** The lesson is hidden (and paused) because the student is in another app (watchEvents "front"). */
let aside = false;
/** Companion mode (companion.ts), while the tutor is on: the work area the window covers, and
 *  what the page is to be told (sent again whenever the page asks: companion-state). */
let companion: { on: boolean; work: Rectangle; message: CompanionMessage } | null = null;
/** The page has asked for the companion's state since it last loaded: it listens for it. */
let pageAsked = false;
/** The last press the helper heard (companion mode), and whether the page had the clicks then:
 *  a press on its card or its dock was its own, and so is the tap that follows a moment later,
 *  whatever the page has said since (the card closes as it is clicked). */
let lastPress: { at: number; page: boolean } | null = null;
/** A tap comes at most this long after its press. */
const PRESS_TAP_MS = 2_000;
/** When the lesson's window last took or gave up the keys (want-keys), and how long another
 *  window of Tutornote's taking them then is that, not the student going to it (onOwnFocus). */
let keysMovedAt = 0;
const KEYS_MOVED_MS = 300;
/** The talk key is wanted (registerTalkKey, whether macOS gave it or another app has it), and so
 *  the talk chord is watched; and when ⌃⌥M, or one of the lesson's other ⌃⌥ keys, was last
 *  pressed (Date.now(), 0 never). */
let talkKeyOn = false;
let lastShortcutAt = 0;
/** Whether the talk chord can be used, as the helper last said (screen.ts ScreenChordState): not
 *  while VoiceOver or secure input is on, or the modifier keys look hidden from it. The page is told
 *  ("screen-teach:chord-state"), so it names ⌃⌥M then, not a chord that does nothing. */
let chordUsable = true;
/*
  The companion's card, in screen points, as the page last said after painting it
  (screen-teach:card-box), or null with no card up. The page asks for the clicks itself as the
  pointer comes over one of its controls (screen-teach:interactive), but it hears where the
  pointer is only from its own mouse moves or the cursor fed to it, up to a few hundred
  milliseconds late on a card that has just appeared under a still pointer: a click there would
  fall through to the app below. So while a card is up this side reads the cursor itself every
  CARD_WATCH_MS, and the window takes the clicks whenever it is over the card (grown by CARD_SLACK
  on every side), whatever the page has said yet (applyMouse).
*/
let cardBox: Rect | null = null;
/** The cursor is over the card now (cardBox), as last read. */
let overCard = false;
let cardWatch: NodeJS.Timeout | undefined;
const CARD_WATCH_MS = 16;
const CARD_SLACK = 4;
/*
  The last Accessibility answer (accessibilityAllowed(false)), and when. A companion pick within
  AX_KEEP_MS of it starts its lesson with that answer instead of waiting on the helper for a new
  one (a round trip on every pick), and asks again behind the lesson. Allow turning and the tutor
  going off forget it.
*/
let axAnswer: { allowed: boolean; at: number } | null = null;
const AX_KEEP_MS = 60_000;
/*
  The companion's careful read of a window (companion.ts carefulReadOf, given here by
  useCarefulReads, so this module imports nothing of it): with the tutor on, a tap on the lesson's
  window off the words it has read starts one at its release, in the accurate pass a restart from
  that tap (restartAt) would read the window in again. Vision reads one picture at a time, so a
  second read would wait for the first: the restart takes that one instead when it was begun
  within TAP_READ_FRESH_MS before the page asked, after the lesson's last turn ended, and the
  window has not scrolled or changed since. Without the tutor, none.
*/
let carefulRead: (window: number, since: number) => Promise<ScreenRead> | null = () => null;
const TAP_READ_FRESH_MS = 2_000;
/*
  Another document (APP_FOLLOW_MS above): what the helper last said of the watched window (null
  from a helper that says nothing of it, when a tap whose verdict saw the title change is how the
  lesson hears of a tab), the app last in front (its pid, from "front"), the student's stay in
  another app being timed (followApp), and the run a switch started with when that switch was seen
  (its page's start is logged against it).
*/
let lastIdent: ScreenIdent | null = null;
/** The run whose window the helper spoke of before its page was ready (onIdent): judged as that
 *  page says its lesson is up (screen-teach:started), from the helper's latest word, since the
 *  helper says nothing again until something changes. */
let identLate: number | null = null;
let frontPid: number | null = null;
let appFollow: { pid: number; at: number; timer: NodeJS.Timeout } | null = null;
let switchedRun: { run: number; at: number } | null = null;
/** The page has said it hears of another document (screen-teach:hears-switching, as it listens on
 *  screen-teach:switching) since it last loaded. A page older than that never stops for a switch,
 *  nor holds a switched run until Play: no switch is begun for it (beginSwitch), and its lesson
 *  goes on as before. */
let pageHearsSwitching = false;
/** A switch waiting for words whose window the student scrolls (onScroll): read again once the
 *  scroll has stopped SWITCH_SCROLL_MS (a wheel's new look is no "changed"). */
let switchScroll: NodeJS.Timeout | undefined;
/** The other window a switch waiting for words has the helper watch for a new look (observeSwitch),
 *  or null. */
let switchObserved: number | null = null;

/*
  The lesson's board in a window of its own: a real Mac window, with its own traffic lights,
  that the student can move and resize beside the app being read. The page opens it itself,
  empty and hidden, when it loads (window.open("", BOARD_FRAME)), and draws GuideBoard into it
  from its own document, so the board's state stays with the lesson. That is the one popup the
  page may open (ensureWindow). The page says what the board is to do (screen-teach:board): shown
  or not, zoomed or not, and its colour. This side owns the window itself: its chrome, its
  place, showing and hiding it with the lesson (syncBoard), and its red light, which hides it and
  tells the page (screen-teach:board-control), as the board's own close does.
  The popup's page (the guest) is not given a window of Electron's making: it is taken as it is
  made (createWindow) into a view of a window of this module's own (the host, a BaseWindow), so the
  same page, with everything on it, can be moved into another window without a reload.
  It has two homes. Its own window, as above (place "float"), or a Board tab of Tutornote's main
  window (place "tab"): windows.ts holds the tab's slot, and tells this module through appEvents
  what the student does with the tab. Where it goes is decided once per lesson run, at the run's
  first drawing (decide, boardHost.ts boardPlaceFor): the tab when the main window is there to hold
  it and lies clear of what is read, else its own window; Pop out keeps it in its own window until
  the student chooses Open in Tutornote. Before each move the board's page is marked with its place
  (data-board-place), so its head never drags the main window. The page hears where its board is
  (screen-teach:board-place) once it has asked (screen-teach:board-place-now): a page that never
  asks is older than the tab, and its board only ever floats.
  A Mac app older than this has no such bridge, and a page that cannot open the window draws
  the board in the lesson's window, as before.
*/
const BOARD_FRAME = "tutornote-board";
/** The board: the page the lesson opened (its contents, in its view), the window it floats in, and
 *  where it is now. */
interface Board {
  contents: WebContents;
  view: WebContentsView;
  host: BaseWindow;
  place: BoardWhere;
}
let board: Board | null = null;
/** The student's choices for the board (screen-board.json): read at install, saved as they change. */
let prefs: BoardPrefs = { place: "tab", zoom: 0 };
/** The run whose first drawing chose the board's place. */
let decidedRun = -1;
/** The Board tab is in the bar for this lesson (the board in it, or away in its own window). */
let inBar = false;
/** The board was up at the last syncBoard. */
let boardUp = false;
/** Something new went up on the board (a new `drawn`) since the last syncBoard. */
let freshDrawing = false;
let lastDrawn: { run: number; drawn: number } | null = null;
/** The page loaded now has asked screen-teach:board-place-now: it knows tabs (an older one never asks). */
let pageKnowsPlace = false;
/** The lesson is aside because Tutornote, on the Board tab, covers what is read. */
let covering = false;
/** The main window was last put in front (showInactive, or its focus), and no other app since. */
let mainOnTop = false;
/** What the page was last told of the board's place, and what the Window menu last showed. */
let lastPlaceSent = "";
let lastMenuPlace: BoardWhere | null = null;
/** The board page's title, for its tab and its window. */
let boardTitleNow = "Board";
/** The host is unmaximized as the board moves into its tab: that tells the page nothing. */
let quietZoom = false;
/** The move into the tab in flight (its number), or 0: the board's page is being marked first. */
let docking = 0;
let dockings = 0;
let mainFocusTimer: NodeJS.Timeout | undefined;
let mainBlurTimer: NodeJS.Timeout | undefined;
/** A focus change of the main window is judged this long after it (a tab bar click selects a tab
 *  just after the window takes the keys), its blur this long after; a page is marked for a move
 *  within this long, or moved anyway. */
const MAIN_FOCUS_SETTLE_MS = 120;
const MAIN_BLUR_SETTLE_MS = 150;
const MARK_TIMEOUT_MS = 300;
/** The page's last word on the board: something is on it (shown), and it is zoomed (full). */
let boardWanted = false;
let boardFull = false;
/** The run that said so: an older lesson's board never shows over this one. */
let boardRun = -1;
/** The run the board was last placed for: it is placed once per lesson, then left where it is. */
let placedRun = -1;
/** The board's own colour (the page's card colour), behind it while it loads and resizes. */
let boardColor = "#ffffff";
/** ⌘Q: the board's close goes ahead then, as every window's does (windows.ts does the same). */
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});
/** When a scroll over the board was last left out (logged once in a while, not per wheel tick). */
let scrollDropLogged = 0;
/** What the board's window was last told (setIgnoreMouseEvents): its own, as it takes every click
 *  of its own but while a scroll is posted (applyMouse). */
let boardIgnoring = false;
/*
  Where the board's window was a moment ago. The helper sends a tap only once the button is up and
  it has taken a picture of the window read (helpers/screen/main.swift, installWatch): by then the
  click may have hidden the board (its red light) or changed its size (Make smaller, the green
  light), and the point pressed is no longer on it. A tap where the board showed within
  BOARD_LEFT_MS is the board's all the same (onTap), never a move of the lesson.
*/
const BOARD_LEFT_MS = 1_000;
/** A move or a change of size of the board's window is told to the page once it has stopped this long. */
const BOARD_MOVED_MS = 150;
let boardWas: Array<{ bounds: Rectangle; until: number }> = [];
/** The board's bounds as last seen: what a move or resize of it has just left. */
let boardAt: Rectangle | null = null;
/*
  The student closed the board (closeBoardHere) a moment ago, and the page has not said since that
  it is down. A page whose board was zoomed answers the close with its own change of size, sent at
  once with the board still up (its sender keeps a hide back for BOARD_HIDE_GRACE_MS, 700 ms, in the
  web app's boardWindow.ts), and that would bring the empty board straight back. So for
  CLOSE_HOLD_MS, or until the page says show: false, a show for that run is kept (boardWanted) but
  not acted on (syncBoard); when the hold is over, the board comes up if something is on it by then.
*/
const CLOSE_HOLD_MS = 1_200;
let closeHold: { run: number; timer: NodeJS.Timeout } | null = null;

const live = (): BrowserWindow | null => (win && !win.isDestroyed() ? win : null);
const liveBoard = (): Board | null => (board && !board.contents.isDestroyed() && !board.host.isDestroyed() ? board : null);

const fromLesson = (event: { sender: WebContents }): boolean => {
  const w = live();
  return Boolean(w && event.sender === w.webContents);
};

/** Clicks reach the page only where it asked for them (or over the companion's card: cardBox), and
 *  never while a scroll is posted below it. Nor the board's window while one is: the lesson's own
 *  turn posts its wheel at a point (or the pointer's) that the board can lie over, beside the words,
 *  over their right edge or zoomed over them all, and the wheel must reach the app being read, not
 *  scroll the board. */
function applyMouse(): void {
  const b = liveBoard();
  const boardIgnore = scrolling > 0;
  // (only its own window: never the main window, with the board in a tab of it)
  if (b && b.place === "float" && boardIgnore !== boardIgnoring) {
    boardIgnoring = boardIgnore;
    b.host.setIgnoreMouseEvents(boardIgnore);
  }
  const w = live();
  const ignore = !((interactive || overCard) && scrolling === 0);
  if (!w || ignore === ignoring) return;
  ignoring = ignore;
  w.setIgnoreMouseEvents(ignore, { forward: FORWARD_MOVES });
}

/*
  Windows: no forwarded mouse moves. Electron forwards them to a window that lets clicks through
  with a low-level mouse hook on this process's own thread, and Windows makes every move of the
  mouse, in every app, wait for that thread to take it: whenever this thread is busy (a read
  coming in, a lesson's work), the student's own cursor stutters (the founder, 2026-11-03: "mouse
  movement has to be very slick"). The screen helper says the cursor instead, from Raw Input, which
  sits in nobody's way (screen.ts cursorStream), for as long as the window is shown, and the page
  takes it as the Mac app's feed (onCursor). Over the page's own things (its dock, a card), the
  window takes the mouse and has its own moves as any window does.
*/
const FORWARD_MOVES = process.platform !== "win32";

/** The helper's cursor, said to the page while the window is shown (Windows: FORWARD_MOVES). */
function cursorToPage(p: Point): void {
  const w = live();
  if (!w || !w.isVisible()) return;
  const local = localPoint(p);
  if (local) sendToPage("screen-teach:cursor", local);
}

/** The companion's card is up at `box` (screen points), or no longer (null): the cursor is read
 *  every CARD_WATCH_MS while it is, and the window takes the clicks over it (applyMouse). */
function setCardBox(box: Rect | null): void {
  cardBox = box;
  clearInterval(cardWatch);
  cardWatch = undefined;
  if (box) {
    cardWatch = setInterval(watchCard, CARD_WATCH_MS);
    watchCard();
  } else if (overCard) {
    overCard = false;
    applyMouse();
  }
}

function watchCard(): void {
  const box = cardBox;
  if (!box) return;
  const p = screen.getCursorScreenPoint();
  const over =
    p.x >= box.x - CARD_SLACK && p.x <= box.x + box.w + CARD_SLACK && p.y >= box.y - CARD_SLACK && p.y <= box.y + box.h + CARD_SLACK;
  if (over === overCard) return;
  overCard = over;
  applyMouse();
}

/** Whether Accessibility lets the helper turn pages now, asked of it; the answer is kept for the
 *  next companion pick (axAnswer). */
async function turningAllowed(): Promise<boolean> {
  const allowed = await accessibilityAllowed(false);
  axAnswer = { allowed, at: Date.now() };
  return allowed;
}

/** A fresh read of the lesson's window: where the board goes from now on. */
function noteRead(current: Lesson, read: ScreenRead): void {
  current.frame = read.frame;
  current.text = textBox(read.lines);
  current.lines = read.lines;
  current.look = { frame: read.frame, lines: read.lines, bundle: read.bundle };
  current.title = read.title;
  current.doc = docKeyOf(read);
  boardBeside(current);
}

/** Whether Tutornote's window covers what is read may have changed (a read, a move of the window
 *  read): a board in its tab there, with the student in the app being read, moves out beside
 *  them; the page hears where its board is. */
function boardBeside(current: Lesson): void {
  const b = liveBoard();
  if (b && lesson === current && boardTabDocked() && leaveCoveredTab(b, current)) syncBoard();
  else sendPlace();
}

/*
  The board's window. Hidden until syncBoard shows it, and never shown with show() or focused
  from here: showInactive leaves the app being read in front (its menu bar stays), so nothing
  pauses because the board came up. Its first click counts (acceptFirstMouse), so a button on it
  works at once.
  It floats at the "floating" level, under the lesson's window (+1): the pointer, the caption and
  the lesson's dock still draw over it. Full screen would take it to a Space of its own, away from
  the app being read: the green light zooms it to the work area instead (fullscreenable: false).
  Minimizing it to the Dock would leave the lesson drawing on a board nobody sees, so the yellow
  light is off. Its x, y, width and height from window.open are ignored by Electron anyway:
  placeBoardFor places it.
  The page in it (the guest) has the lesson window's web preferences, which an about:blank popup
  takes as they are (context isolation, the sandbox, the preload): every call of the lesson's
  bridge checks it comes from the lesson's own window (fromLesson), so the board's copy of the
  bridge can do nothing.
*/
function hostOptions(): BaseWindowConstructorOptions {
  return {
    show: false,
    title: "Board",
    width: 620,
    height: 640,
    minWidth: BOARD_MIN.width,
    minHeight: BOARD_MIN.height,
    // The real traffic lights in the board's own 38 px head (its .guide-board-head). Windows: its
    // own title bar, with close and maximise (the page draws no buttons of its own: it counts on
    // the Mac's lights).
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 12 } } : {}),
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: true,
    fullscreenable: false,
    acceptFirstMouse: true,
    hasShadow: true,
    backgroundColor: boardColor,
  };
}

/** Windows has one always-on-top band, and the levels' order (blob over the lesson's window over
 *  the board) is the Mac's only: the board, made after the lesson's window and raised by each click
 *  on it, would cover the pointer, the caption, the dock and the card. Each time the board shows or
 *  comes forward, the lesson's window (and the blob: companion.ts) go back above it. */
function overlayAboveBoard(): void {
  if (process.platform !== "win32") return;
  const w = live();
  if (w && w.isVisible()) w.setAlwaysOnTop(true, "floating", 1);
  appEvents.emit("screen-board-raised");
}

/** The view fills its window's content (after every move into it: a view keeps the bounds it had). */
function fitHost(b: Board): void {
  const [width, height] = b.host.getContentSize();
  b.view.setBounds({ x: 0, y: 0, width, height });
}

/** The page the lesson's page just opened (createWindow): Electron wants that same page back. Only
 *  the board, from the lesson's own window, and one at a time: anything else is closed at once. */
function adoptBoard(opener: BrowserWindow, options: BrowserWindowConstructorOptions): WebContents {
  const contents = (options as { webContents: WebContents }).webContents;
  if (win !== opener || liveBoard()) {
    console.warn("[screen-teach] board window refused");
    setImmediate(() => {
      if (!contents.isDestroyed()) contents.close();
    });
    return contents;
  }
  const view = new WebContentsView({ webContents: contents });
  view.setBackgroundColor(boardColor);
  const host = new BaseWindow(hostOptions());
  host.contentView.addChildView(view);
  const b: Board = { contents, view, host, place: "float" };
  board = b;
  boardTitleNow = "Board";
  fitHost(b);
  host.on("resize", () => {
    if (board === b && b.place === "float") fitHost(b);
  });
  boardAt = host.getBounds();
  // A new window takes clicks; one made while a scroll is posted lets them through at once.
  boardIgnoring = false;
  applyMouse();
  host.setAlwaysOnTop(true, "floating", 0);
  overlayAboveBoard();
  host.on("focus", overlayAboveBoard);
  // Over a full-screen app's Space too, as the lesson's window (ensureWindow says what that costs:
  // once per window, and the board is kept for the lesson window's life).
  host.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hideFromCapture(host);
  contents.setZoomMode("isolated");
  // (the student's text size for the board, View > Zoom In: menu.ts)
  contents.setZoomLevel(prefs.zoom);
  // The lesson draws on it while the app being read is in front: a popup's page does not take
  // its opener's backgroundThrottling.
  contents.setBackgroundThrottling(false);
  contents.on("will-navigate", (event) => event.preventDefault());
  // A source link on the board opens in the browser, as links do from the app's tabs; nothing
  // from the web opens inside the app.
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  watchLessonAudio(contents);
  // The page names the board (its document's title): the window's title, for the Window menu and
  // Mission Control, and its tab's.
  contents.on("page-title-updated", (_event, title) => {
    boardTitleNow = title.slice(0, 120) || "Board";
    host.setTitle(boardTitleNow);
    setBoardTabInfo({ title: boardTitleNow });
  });
  contents.on("context-menu", (_event, params) => showBoardMenu(contents, params));
  // The board's own reset follows its page: a closed host leaves the page alive, and the page goes
  // with the lesson's window.
  contents.once("destroyed", () => {
    if (board === b) dropBoardState(b);
  });

  // Where the student leaves it, and its size, are kept for the next lesson: only after a move or
  // resize of their own (will-move and will-resize are only for those; placeBoardFor's are not),
  // and not its zoomed size.
  let studentPlaced = false;
  let saveTimer: NodeJS.Timeout | undefined;
  const placedByStudent = (): void => {
    studentPlaced = true;
  };
  const settled = (): void => {
    if (!studentPlaced) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (host.isDestroyed() || !studentPlaced) return;
      studentPlaced = false;
      if (host.isMaximized()) return;
      // Dragged out of its zoom: it is no longer zoomed, whatever the page last said.
      if (boardFull) {
        tellBoard("unzoom");
        return;
      }
      saveScreenBoard(host.getBounds());
    }, 400);
  };
  host.on("will-move", placedByStudent);
  host.on("will-resize", placedByStudent);
  host.on("moved", settled);
  host.on("resized", settled);
  // Where it was, at each move or change of size while it shows (boardWas): a tap that comes in
  // after the change, made where it was, is still the board's.
  // And the page hears where it is now (its place's bounds) once a move or a change of size has
  // stopped for BOARD_MOVED_MS, not at every step of a drag.
  let placeTimer: NodeJS.Timeout | undefined;
  const changed = (): void => {
    if (board !== b || host.isDestroyed()) return;
    const now = host.getBounds();
    if (boardAt && host.isVisible() && !sameBounds(boardAt, now)) boardLeft(boardAt);
    boardAt = now;
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => {
      if (board === b && !host.isDestroyed()) sendPlace();
    }, BOARD_MOVED_MS);
  };
  host.on("move", changed);
  host.on("resize", changed);
  // The green light (or Window > Zoom). The page hears of a zoom only when it is not the one it
  // asked for itself (applyBoardFull), so its own "make smaller" never comes back as the student's.
  // (not the quiet unzoom as the board moves into its tab: toTab)
  host.on("maximize", () => {
    if (quietZoom) return;
    changed();
    if (!boardFull) tellBoard("zoom");
  });
  host.on("unmaximize", () => {
    if (quietZoom) {
      quietZoom = false;
      return;
    }
    changed();
    if (boardFull) tellBoard("unzoom");
  });
  // The red light (or ⌘W, menu.ts) hides it and closes what is on it, as the board's own close
  // does; the board stays on, and the next thing the lesson puts up brings it back. A close the
  // page made itself (window.close()) would bypass this, so the page never closes it.
  host.on("close", (event) => {
    if (quitting || board !== b || !live()) return;
    event.preventDefault();
    closeBoardHere();
  });
  host.on("closed", () => {
    clearTimeout(saveTimer);
    clearTimeout(placeTimer);
    // Closed for real while its page lives on (a quit then called off leaves the close allowed):
    // the page goes too, so the lesson's page opens a new board instead of drawing on one with no
    // window (its destroyed handler drops the rest).
    if (board === b && !contents.isDestroyed()) contents.close();
  });
  sendPlace();
  console.log("[screen-teach] board ready");
  return contents;
}

/** Out of the main window and its tab, and the host destroyed. */
function teardownBoard(b: Board): void {
  docking = 0;
  if (boardTabDocked()) undockBoardView();
  hideBoardTab();
  if (!b.host.isDestroyed()) b.host.destroy();
}

/** The board's page is gone (with the lesson's window, or a reload): its tab and its window go with it. */
function dropBoardState(b: Board): void {
  teardownBoard(b);
  board = null;
  placedRun = -1;
  boardAt = null;
  decidedRun = -1;
  inBar = false;
  boardUp = false;
  covering = false;
  lastPlaceSent = "";
  noteMenuPlace();
}

/** Tell the page what the student did with the board's window. */
function tellBoard(control: "close" | "zoom" | "unzoom"): void {
  live()?.webContents.send("screen-teach:board-control", control);
}

/** The student closed the board (its red light, ⌘W, its tab's ×): it hides, or its tab folds away,
 *  and the page closes what is on it. Where it was is kept: the next drawing brings it back there. */
function closeBoardHere(): void {
  boardWanted = false;
  holdAfterClose();
  noteBoardPlace();
  const b = liveBoard();
  if (b) {
    docking = 0;
    if (boardTabDocked()) undockBoardView();
    hideBoardTab();
    inBar = false;
    homeView(b);
    if (b.host.isVisible()) b.host.hide();
  }
  tellBoard("close");
  boardUp = false;
  sendPlace();
  console.log("[screen-teach] board closed by the student");
}

/** Keep the page's shows for this run back for a moment, the student having closed the board
 *  (closeHold). */
function holdAfterClose(): void {
  releaseHold();
  if (!lesson) return;
  const timer = setTimeout(() => {
    if (closeHold?.timer !== timer) return;
    closeHold = null;
    syncBoard();
  }, CLOSE_HOLD_MS);
  closeHold = { run: lesson.run, timer };
}

function releaseHold(): void {
  if (closeHold) clearTimeout(closeHold.timer);
  closeHold = null;
}

const sameBounds = (a: Rectangle, b: Rectangle): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** `bounds` is where the board's window was until now: still the board's for a tap a moment more. */
function boardLeft(bounds: Rectangle): void {
  const now = Date.now();
  boardWas = boardWas.filter((was) => was.until > now);
  const last = boardWas[boardWas.length - 1];
  if (last && sameBounds(last.bounds, bounds)) last.until = now + BOARD_LEFT_MS;
  else boardWas.push({ bounds, until: now + BOARD_LEFT_MS });
}

/** The board's window, if it shows, is about to hide or change size: where it is now goes on
 *  counting for a moment. */
function noteBoardPlace(): void {
  const host = liveBoard()?.host;
  if (host?.isVisible()) boardLeft(host.getBounds());
}

/** Close the board, when it is up (⌘W with the board's window in front, or on its tab: menu.ts). */
export function closeScreenBoard(): void {
  const b = liveBoard();
  if (b && (boardTabDocked() || b.host.isVisible())) closeBoardHere();
}

/** The board's window is zoomed as the page last said. Only while it shows: macOS shows a hidden
 *  window it zooms, so a zoom asked for meanwhile waits for syncBoard to show it. Only its own
 *  window: in a tab the board already fills Tutornote's. */
function applyZoom(): void {
  const b = liveBoard();
  if (!b || b.place !== "float") return;
  const host = b.host;
  if (boardFull && host.isVisible() && !host.isMaximized()) {
    noteBoardPlace();
    host.maximize();
    overlayAboveBoard();
  } else if (!boardFull && host.isMaximized()) {
    // (Make smaller on a zoomed board: the button pressed is no longer on it once it is smaller)
    noteBoardPlace();
    host.unmaximize();
    overlayAboveBoard();
  }
}

function applyBoardFull(full: boolean): void {
  boardFull = full;
  applyZoom();
}

/** The display that holds most of a window read. */
const displayFor = (f: Rect): Display =>
  screen.getDisplayMatching({
    x: Math.round(f.x),
    y: Math.round(f.y),
    width: Math.max(1, Math.round(f.w)),
    height: Math.max(1, Math.round(f.h)),
  });

/** The board beside the words read, on the display that holds their window (as the lesson's own
 *  window is: openScreenTeach), or where the student left it last. */
function placeBoardFor(b: BaseWindow, current: Lesson): void {
  const f = current.frame;
  const display = displayFor(f);
  b.setBounds(placeBoard({ work: display.workArea, text: current.text, frame: f, saved: loadScreenBoard() }));
}

/** What the lesson reads, as boardHost.ts weighs it against the main window. */
function reading(current: Lesson): Reading {
  const display = displayFor(current.frame);
  return { words: current.text, frame: current.frame, displayId: display.id, full: fullScreenFrame(current.frame, display.bounds) };
}

/**
 * The one place the board is shown, hidden or moved. It is up exactly while the page has
 * something on it for this lesson, the page is running, and the lesson itself is on screen (not
 * aside while the student is in another app, nor while another document seen in its place is
 * read: Lesson.switching), but not the moment after the student closed it (closeHold). Run at
 * each change of any of those, so a show the
 * page sent early (before it was ready, or while aside) is kept, and happens when it can.
 * Where it goes is decided the first time it is up in a run (decide). Its own window shows and
 * hides as above; in its tab it stays through every one of those (the page shows a quiet line on
 * it while there is nothing on it). The tab folds away with the lesson.
 */
function syncBoard(): void {
  const b = liveBoard();
  if (!b) return;
  const w = live();
  if (!lesson || !w || !pageReady) return foldBoard(b, !lesson ? "the lesson ended" : "the lesson's page is not ready");
  const why = !w.isVisible()
    ? "the lesson is not on screen"
    : lesson.switching
      ? "another document is on screen"
      : aside
        ? "the student is in another app"
        : boardRun !== lesson.run || !boardWanted
          ? "nothing on it"
          : closeHold?.run === lesson.run
            ? "the student has just closed it"
            : "";
  const up = !why;
  // Something new on it: a new drawing, or the board coming up.
  const fresh = freshDrawing || (up && !boardUp);
  freshDrawing = false;
  if (up && decidedRun !== lesson.run) decide(b, lesson);
  // (an older page's board only ever floats: no tab for it, not even an away one)
  if (up && pageKnowsPlace) inBar = true;
  if (b.place === "tab") {
    if (up && !boardTabDocked() && !docking) {
      if (!toTab(b, "quiet")) toFloat(b);
    } else if (fresh && boardTabDocked()) {
      // (the student still in the app being read, with Tutornote's window now over its words: the
      // tab can't be seen, and the board moves out beside them, as when they leave the window)
      if (!(up && leaveCoveredTab(b, lesson))) onFreshInTab(up);
    }
  }
  const host = b.host;
  if (b.place === "float") {
    if (up && !host.isVisible()) {
      if (placedRun !== lesson.run) {
        placeBoardFor(host, lesson);
        placedRun = lesson.run;
      }
      host.showInactive();
      overlayAboveBoard();
      boardAt = host.getBounds();
      applyZoom();
      // (a window made by this module raises no browser-window-created: companion.ts hears it here)
      appEvents.emit("screen-board-shown");
      console.log(`[screen-teach] board shown (run ${lesson.run})`);
    } else if (!up && host.isVisible()) {
      noteBoardPlace();
      host.hide();
      console.log(`[screen-teach] board hidden: ${why}`);
    }
  }
  // (in its own window, its tab stays in the bar as an away tab that brings it back)
  if (inBar && !boardTabDocked() && b.place === "float") showBoardTab({ title: boardTitleNow, surface: boardColor, away: true });
  boardUp = up;
  sendPlace();
}

/** The board leaves the bar (the lesson ended, or its page is not running): its tab folds away and
 *  its window hides. Where it was is kept for the next run's decision. */
function foldBoard(b: Board, why: string): void {
  const was = inBar || boardTabDocked() || b.host.isVisible();
  docking = 0;
  if (boardTabDocked()) undockBoardView();
  hideBoardTab();
  inBar = false;
  covering = false;
  homeView(b);
  if (b.host.isVisible()) {
    noteBoardPlace();
    b.host.hide();
  }
  boardUp = false;
  sendPlace();
  if (was) console.log(`[screen-teach] board folded: ${why}`);
}

/** Where this run's board goes, at its first drawing (boardHost.ts boardPlaceFor). A board in its tab
 *  stays there when the rule still says so. */
function decide(b: Board, current: Lesson): void {
  decidedRun = current.run;
  const d = boardPlaceFor({ pref: prefs.place, pageKnowsPlace, main: mainWindowLook(), reading: reading(current) });
  console.log(`[screen-teach] board in ${d.where === "tab" ? "its tab" : "its own window"} (run ${current.run}): ${d.why}`);
  if (d.where === "float" && b.place === "tab") toFloat(b);
  else if (d.where === "tab") b.place = "tab";
}

/** The board's view back in its own window (shown or not), filling it, and seen there: it may come
 *  back hidden (the main window hides it while another tab shows, and a view keeps that). */
function homeView(b: Board): void {
  if (!b.host.contentView.children.includes(b.view)) b.host.contentView.addChildView(b.view);
  fitHost(b);
  b.view.setVisible(true);
}

/** Mark the board's page with where it is going (data-board-place: its CSS keys the drag region on
 *  it), before it goes: a press on its head in the first frame in a tab must never drag the main
 *  window. Within MARK_TIMEOUT_MS, or the move goes ahead anyway. */
function markPlace(b: Board, where: BoardWhere): Promise<void> {
  if (b.contents.isDestroyed()) return Promise.resolve();
  const mark = b.contents
    .executeJavaScript(`document.documentElement.setAttribute("data-board-place", ${JSON.stringify(where)}); 0`, false)
    .then(() => undefined);
  const cap = new Promise<void>((resolve) => setTimeout(resolve, MARK_TIMEOUT_MS));
  return Promise.race([mark, cap]).catch(() => undefined);
}

/** The board into its own window, at once, with everything on it (hidden: syncBoard shows it beside
 *  the words when it is up). Its tab stays in the bar as an away tab. */
function toFloat(b: Board): void {
  docking = 0;
  b.place = "float";
  covering = false;
  if (boardTabDocked()) undockBoardView();
  void markPlace(b, "float");
  homeView(b);
  // (placed beside the words at its next show)
  placedRun = -1;
  boardIgnoring = scrolling > 0;
  b.host.setIgnoreMouseEvents(boardIgnoring);
  if (inBar) showBoardTab({ title: boardTitleNow, surface: boardColor, away: true });
  sendPlace();
  console.log("[screen-teach] board in its own window");
}

/**
 * The board into its tab of the main window: its window hides at once (unzoomed quietly: the page
 * keeps its own idea of full), its page is marked, then the view moves. "quiet": as the lesson puts
 * something up, never taking the keys; "focus": the student's Open in Tutornote, which brings the
 * window forward with the board's keys. False when it cannot go (an older page, no lesson, or for
 * "quiet" no window there to hold it).
 */
function toTab(b: Board, how: "quiet" | "focus"): boolean {
  if (!pageKnowsPlace || !lesson) return false;
  if (how === "quiet" && !mainCanHold(mainWindowLook())) return false;
  if (boardTabDocked() || docking) return true;
  b.place = "tab";
  noteBoardPlace();
  if (b.host.isMaximized()) {
    quietZoom = true;
    b.host.unmaximize();
    // (the unmaximize event may come once the zoom has run: it clears this, or this does)
    setTimeout(() => (quietZoom = false), 1_000).unref();
  }
  if (b.host.isVisible()) b.host.hide();
  const gen = ++dockings;
  docking = gen;
  void markPlace(b, "tab").then(() => {
    if (docking !== gen || board !== b || b.place !== "tab" || !lesson || !liveBoard()) return;
    docking = 0;
    const main = how === "focus" ? bringMainForward() : mainCanHold(mainWindowLook()) ? getMainWindow() : null;
    b.host.contentView.removeChildView(b.view);
    if (!main || !dockBoardView(b.view)) {
      toFloat(b);
      syncBoard();
      return;
    }
    inBar = true;
    showBoardTab({ title: boardTitleNow, surface: boardColor, away: false });
    if (how === "focus") {
      selectBoardTab({ focus: true });
      b.contents.focus();
    } else onFreshInTab(true);
    sendPlace();
    console.log(`[screen-teach] board in its tab${how === "focus" ? ", for the student" : ""}`);
  });
  return true;
}

/**
 * Something new went up on the board in its tab. With the student in Tutornote: a dot on the tab,
 * when another tab shows. With the student in the app being read (`raise`): the Board tab is
 * selected and the window ordered in front without the keys (that app keeps its menu bar and its
 * keys), where it lies clear of the words, as it did when the board was put there.
 */
function onFreshInTab(raise: boolean): void {
  const main = getMainWindow();
  if (!main || !boardTabDocked()) return;
  if (main.isFocused()) {
    if (!boardTabActive()) setBoardTabInfo({ dot: true });
    return;
  }
  if (!raise || !lesson || coversReading(mainWindowLook(), reading(lesson))) return;
  if (!boardTabActive()) selectBoardTab({ focus: false });
  if (main.isVisible() && !main.isMinimized()) {
    // (in front without the keys, as explain.ts gives the window back; on Windows showInactive
    // leaves a window that is already shown where it is, so it is raised instead)
    if (process.platform === "win32") main.moveTop();
    else main.showInactive();
    mainOnTop = true;
  }
}

/** Where the board is, for the page (screen-teach:board-place), or null with no board: in its own
 *  window over the lesson window, that window's frame in the lesson window's points too (boardPlaceMsg). */
function placeNow(): BoardPlace | null {
  const b = liveBoard();
  if (!b) return null;
  const app = lesson?.bundle && lesson.app ? lesson.app.slice(0, 60) : "";
  const w = live();
  return boardPlaceMsg({
    where: b.place,
    canMove: b.place === "tab" || !mainWindowLook().signIn,
    covering,
    app,
    floating: b.place === "float" && b.host.isVisible() ? b.host.getBounds() : null,
    lesson: w ? w.getBounds() : null,
  });
}

/** Tell the page where the board is, when that changed (and the Window menu). */
function sendPlace(): void {
  noteMenuPlace();
  const p = placeNow();
  const key = JSON.stringify(p);
  if (key === lastPlaceSent) return;
  lastPlaceSent = key;
  if (p) live()?.webContents.send("screen-teach:board-place", p);
}

/** The Window menu's board item follows boardPlaceNow (menu.ts rebuilds it). */
function noteMenuPlace(): void {
  const now = boardPlaceNow();
  if (now === lastMenuPlace) return;
  lastMenuPlace = now;
  appEvents.emit("board-place-changed");
}

/**
 * The main window has had the keys a moment (MAIN_FOCUS_SETTLE_MS): the student went to it. On a
 * page there, they are somewhere other than the lesson, which steps aside; on the Board tab they
 * are at the lesson's board, which goes on, unless the window lies over what is read: then it
 * steps aside too (covering, with a line on the board), until they go back to the app being read.
 */
function judgeMain(): void {
  const m = getMainWindow();
  if (!lesson || !m || !m.isFocused()) return;
  mainOnTop = true;
  if (!boardTabActive()) {
    covering = false;
    stepAside(true);
    sendPlace();
    return;
  }
  covering = coversReading(mainWindowLook(), reading(lesson));
  stepAside(covering);
  sendPlace();
}

/** The main window gave up the keys a moment ago (MAIN_BLUR_SETTLE_MS) with the board in its tab:
 *  if the student can no longer see the tab there, the board moves to its own window. */
function onMainLeft(): void {
  const b = liveBoard();
  if (!b || !lesson || b.place !== "tab" || Date.now() - keysMovedAt < KEYS_MOVED_MS) return;
  if (leaveCoveredTab(b, lesson)) syncBoard();
  else sendPlace();
}

/** The board in its tab, with the student out of the main window: when that window can't show it
 *  to them (it covers what is read, or can no longer hold it: boardHost.ts leavesTab), it moves to
 *  its own window, for the caller's syncBoard to show beside the words. True when it moved. */
function leaveCoveredTab(b: Board, current: Lesson): boolean {
  if (b.place !== "tab") return false;
  const f = BaseWindow.getFocusedWindow();
  const otherOwnFocused = Boolean(f && f !== getMainWindow());
  if (!leavesTab({ main: mainWindowLook(), reading: reading(current), otherOwnFocused })) return false;
  toFloat(b);
  return true;
}

/** Pop out: the board into its own window beside the words, with the keys; later lessons too. */
function popOut(): void {
  prefs.place = "window";
  saveBoardPrefs({ place: "window" });
  const b = liveBoard();
  if (!b) return;
  if (b.place === "tab") {
    toFloat(b);
    // (the student's own move to the board: the lesson is theirs again, wherever they pressed it)
    if (aside) stepAside(false);
  }
  syncBoard();
  // (the board's page too: its own window gives the keys to no page by itself, and the page was
  // the main window's to focus a moment ago)
  if (b.host.isVisible()) {
    b.host.focus();
    b.contents.focus();
  }
  console.log("[screen-teach] board popped out by the student");
}

/** Open in Tutornote: the board into its tab, the window forward with the board's keys; Pop out is forgotten. */
function openInTutornote(): void {
  const b = liveBoard();
  if (!b || !pageKnowsPlace || !lesson || mainWindowLook().signIn) return;
  prefs.place = "tab";
  saveBoardPrefs({ place: "tab" });
  decidedRun = lesson.run;
  inBar = true;
  toTab(b, "focus");
}

/** ⌥⌘B and the menus' Pop Out Board / Show Board in Tutornote. */
export function toggleBoardPlace(): void {
  const b = liveBoard();
  if (!b || !lesson) return;
  if (boardTabDocked() || b.place === "tab") popOut();
  else openInTutornote();
}

/** Where the lesson's board is, while it has a tab in the bar (the Window menu's item), or null. */
export const boardPlaceNow = (): BoardWhere | null => (inBar ? (liveBoard()?.place ?? null) : null);

/** Back to {app}: the app being read in front again (the student's click in Tutornote, which can
 *  hand the front on). */
function backToApp(): void {
  // (Windows: the helper brings the window being read forward; Tutornote, in front for the click,
  // may hand the front to it)
  if (process.platform === "win32") {
    if (lesson) bringWindowForward(lesson.window);
    return;
  }
  const bundle = lesson?.bundle;
  if (!bundle || !/^[\w.-]{1,255}$/.test(bundle)) return;
  execFile("/usr/bin/open", ["-b", bundle], (error) => {
    if (error) console.warn(`[screen-teach] could not bring ${bundle} back: ${error.message}`);
  });
}

/** The board's page while the board has the keys (menu.ts: its zoom, its developer tools). */
export const screenBoardContents = (): WebContents | undefined => (boardHasKeys() ? liveBoard()?.contents : undefined);

/** The board's text size, as menu.ts just set it: kept for later lessons. */
export function rememberBoardZoom(level: number): void {
  const zoom = clampBoardZoom(level);
  if (zoom === prefs.zoom) return;
  prefs.zoom = zoom;
  saveBoardPrefs({ zoom });
}

/** The board's right-click menu (in its tab or its own window): each item only where it applies. */
function showBoardMenu(contents: WebContents, params: ContextMenuParams): void {
  const b = liveBoard();
  if (!b || b.contents !== contents) return;
  const groups: MenuItemConstructorOptions[][] = [];
  const selected = params.selectionText.trim();
  const words: MenuItemConstructorOptions[] = [];
  if (selected && selected.length <= 60 && !/[\r\n]/.test(params.selectionText)) {
    words.push({ label: BOARD_COPY.lookUp(selected), click: () => contents.showDefinitionForSelection() });
  }
  // (explicit calls, not roles: the board's page need not be the key window's first responder)
  if (params.isEditable) {
    words.push(
      { label: "Cut", enabled: params.editFlags.canCut, click: () => contents.cut() },
      { label: "Copy", enabled: params.editFlags.canCopy, click: () => contents.copy() },
      { label: "Paste", enabled: params.editFlags.canPaste, click: () => contents.paste() },
      { label: "Select All", click: () => contents.selectAll() },
    );
  } else if (selected) {
    words.push({ label: "Copy", click: () => contents.copy() });
  }
  groups.push(words);
  if (params.mediaType === "image" && params.hasImageContents) {
    groups.push([{ label: "Copy Image", click: () => contents.copyImageAt(params.x, params.y) }]);
  }
  if (/^https?:/i.test(params.linkURL)) {
    const url = params.linkURL;
    groups.push([
      { label: "Open Link in Browser", click: () => openExternal(url) },
      { label: "Copy Link", click: () => void clipboard.writeText(url).catch(() => undefined) },
    ]);
  }
  const copyPicture = async (): Promise<void> => {
    const image = await contents.capturePage();
    if (image.isEmpty()) return;
    await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })]);
  };
  groups.push([{ label: BOARD_COPY.copyPicture, click: () => void copyPicture().catch(() => undefined) }]);
  const place = placeNow();
  const moves: MenuItemConstructorOptions[] = [];
  if (b.place === "tab" || (pageKnowsPlace && place?.canMove)) {
    moves.push({ label: b.place === "tab" ? BOARD_COPY.popOut : BOARD_COPY.showIn, click: () => toggleBoardPlace() });
  }
  moves.push({ label: BOARD_COPY.close, click: () => closeScreenBoard() });
  groups.push(moves);
  const items = groups
    .filter((g) => g.length > 0)
    .flatMap((g, i) => (i === 0 ? g : [{ type: "separator" } as MenuItemConstructorOptions, ...g]));
  const owner = boardTabDocked() ? getMainWindow() : b.host;
  if (!owner) return;
  Menu.buildFromTemplate(items).popup({ window: owner, frame: params.frame ?? undefined });
}

/** Whether `p` (screen points) is on the board's window while it shows, or, `recently`, where it
 *  showed a moment ago (boardWas: a tap comes in late). */
function overBoard(p: Point, recently = false): boolean {
  const on = (r: Rectangle): boolean => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
  const host = liveBoard()?.host;
  if (host && host.isVisible() && on(host.getBounds())) return true;
  if (!recently) return false;
  const now = Date.now();
  return boardWas.some((was) => was.until > now && on(was.bounds));
}

/** Whether `p` (screen points) is on the main window while it is in front: it has the keys (the
 *  student's own click, which the lesson steps aside for only MAIN_FOCUS_SETTLE_MS later, board
 *  or not), or the board in its tab put it there (its raise). A click there was Tutornote's, as
 *  one on the board's own window is (the helper sees past Tutornote's windows). */
function overMain(p: Point): boolean {
  const m = getMainWindow();
  if (!m || !m.isVisible() || m.isMinimized() || !(m.isFocused() || (mainOnTop && boardTabDocked()))) return false;
  const r = m.getBounds();
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

/** Give up the board's window with the page that drew it (its reload, its window gone): the next
 *  page opens a fresh one, and says itself what is on it. */
function destroyBoard(): void {
  const b = board;
  board = null;
  placedRun = -1;
  boardWanted = false;
  boardFull = false;
  boardAt = null;
  decidedRun = -1;
  inBar = false;
  boardUp = false;
  covering = false;
  releaseHold();
  if (!b) return;
  // (its tab and its window first: a page closed in a window that stays would leave it blank)
  teardownBoard(b);
  if (!b.contents.isDestroyed()) b.contents.close();
  noteMenuPlace();
}

function ensureWindow(bounds: Rectangle): BrowserWindow {
  const kept = live();
  if (kept) {
    const b = kept.getBounds();
    if (b.x !== bounds.x || b.y !== bounds.y || b.width !== bounds.width || b.height !== bounds.height) kept.setBounds(bounds);
    return kept;
  }
  const created = new BrowserWindow({
    ...bounds,
    show: false,
    // A panel (a non-activating window, as Spotlight's is): a click on its dock, a chip or the
    // companion's card never makes Tutornote the app in front, and when it takes the keys (focus)
    // the app being read stays in front, so they go back there once it gives them up
    // (screen-teach:want-keys). A plain window with focusable false still brings Tutornote
    // forward on a click (Electron 44 only keeps it from taking the keys).
    // (Windows has no panel: a tool window stays out of the taskbar and Alt+Tab)
    type: process.platform === "win32" ? "toolbar" : "panel",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // It takes keys when the student clicks into it (a question typed to the tutor), and
    // its first click counts, so the board's buttons work in one.
    focusable: true,
    acceptFirstMouse: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // It speaks while another app is in front, and starts speaking without a click.
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
      spellcheck: false,
      zoomFactor: 1,
      additionalArguments: [
        `--anothernotes-version=${app.getVersion()}`,
        "--anothernotes-screen-teach=1",
        ...(nativeSpeechAvailable() ? ["--anothernotes-speech=1"] : []),
      ],
    },
  });
  const contents = created.webContents;
  // Zoom is shared by every page of one origin: a tab zoomed from the View menu would scale
  // this one too, and every box it draws would be off.
  contents.setZoomMode("isolated");
  // The page's own console in the app's log, as windows.ts has the tabs' ([voice], [tapcard]).
  contents.on("console-message", (details) => console.log(`[web:${details.level}:screen] ${details.message}`));
  created.setAlwaysOnTop(true, "floating", 1);
  // Over a full-screen app's Space too: Kindle is often read in full-screen Chrome. To float there
  // Electron briefly turns the app into a background one, which hides its Dock icon for a moment
  // each time this is called (electron.d.ts, skipTransformProcessType); the window is kept and
  // reused, so that is once per window. Skipping the transform would keep the icon steady but the
  // lesson would never show over a full-screen app.
  created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hideFromCapture(created);
  created.setIgnoreMouseEvents(true, { forward: FORWARD_MOVES });
  // (Windows: the helper's cursor while it is shown, in place of forwarded moves)
  if (!FORWARD_MOVES) {
    created.on("show", () => cursorStream(true));
    created.on("hide", () => cursorStream(false));
    created.on("closed", () => cursorStream(false));
  }
  ignoring = true;
  interactive = false;
  pageReady = false;
  contents.on("will-navigate", (event) => event.preventDefault());
  // No popups, but one: the board's own window, which the page opens empty, under its name, to
  // draw the board into. Its page is taken into a window of this module's (adoptBoard), and goes
  // with this window (outlivesOpener: false).
  contents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === "about:blank" && frameName === BOARD_FRAME && !liveBoard()) {
      return {
        action: "allow",
        outlivesOpener: false,
        overrideBrowserWindowOptions: { show: false },
        createWindow: (options) => adoptBoard(created, options),
      };
    }
    if (frameName === BOARD_FRAME) console.warn("[screen-teach] board window refused");
    return { action: "deny" };
  });
  // A reload (only this side ever loads the page: every navigation of the page's own is refused
  // above, though it starts first, so those have an initiator and are left alone). The board goes
  // as the reload starts, not once it has loaded: by then the new page has already asked for the
  // board by its name, and been handed the old one as it closes, and opens none of its own.
  contents.on("did-start-navigation", (details) => {
    if (win === created && details.isMainFrame && !details.isSameDocument && !details.initiator) destroyBoard();
  });
  contents.on("did-navigate", () => {
    if (win !== created) return;
    // (what the page before said about its board is void: the new one says it afresh)
    boardWanted = false;
    boardFull = false;
    pageReady = false;
    pageAsked = false;
    // (the new page says itself whether it knows the board's tab, and another document)
    pageKnowsPlace = false;
    pageHearsSwitching = false;
    lastPlaceSent = "";
    // A page loaded afresh (a reload) has its controls under no pointer yet: clicks go through
    // until it says otherwise. (Nor a card: the new page has none.)
    interactive = false;
    setCardBox(null);
    applyMouse();
  });
  contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    // -3 is a load stopped by another (a reload): not a failure.
    if (!isMainFrame || code === -3 || win !== created) return;
    console.warn(`[screen-teach] the lesson page did not load: ${code} ${description}`);
    failLesson("The lesson couldn't open. Please try again.");
    dropWindow();
  });
  contents.on("render-process-gone", (_event, details) => {
    if (win !== created) return;
    console.warn(`[screen-teach] the lesson page stopped: ${details.reason}`);
    failLesson(process.platform === "win32" ? "The lesson stopped. Click the tutor button to start again." : "The lesson stopped. Press ⌃⌥E to start again.");
    dropWindow();
  });
  created.on("closed", () => {
    if (win !== created) return;
    win = null;
    pageReady = false;
    setCardBox(null);
    destroyBoard();
    closeScreenTeach();
    // (the companion, if on, has lost its window: companion.ts turns it off)
    companion = null;
    appEvents.emit("screen-teach-gone");
  });
  watchLessonAudio(contents);
  void created.loadURL(`${APP_ORIGIN}${ROUTE}`);
  win = created;
  return created;
}

/** Give up on the window, its page having failed: the next pick makes a new one. */
function dropWindow(): void {
  const w = live();
  win = null;
  pageReady = false;
  setCardBox(null);
  // (the board shares its page's process and its life)
  destroyBoard();
  w?.destroy();
  // (the companion, if on, has lost its window too)
  companion = null;
  appEvents.emit("screen-teach-gone");
}

/** The lesson's Control+Option keys are the Mac's: on Windows Ctrl+Alt is AltGr on many keyboards
 *  (Ctrl+Alt+Right would take AltGr+Right from every app), so there the dock's buttons and mic are
 *  the way in until Windows keys are chosen. */
const CTRL_ALT_KEYS = process.platform === "darwin";

function registerShortcuts(): void {
  for (const [accelerator, command] of CTRL_ALT_KEYS ? SHORTCUTS : []) {
    if (globalShortcut.isRegistered(accelerator)) continue;
    const pressed = (): void => {
      // (its Control and Option let go just after are no chord tap: onChord)
      lastShortcutAt = Date.now();
      live()?.webContents.send("screen-teach:command", command);
    };
    if (!globalShortcut.register(accelerator, pressed)) {
      console.warn(`[screen-teach] ${accelerator} is taken by another app`);
    }
  }
  registerTalkKey();
}

function unregisterShortcuts(): void {
  for (const [accelerator] of SHORTCUTS) {
    if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);
  }
  // (the companion's dock has a mic of its own while the tutor is on)
  if (!companion?.on) unregisterTalkKey();
}

/** The talk key and the talk chord, on together and off together (TALK_SHORTCUT): the chord is
 *  watched even when another app has taken ⌃⌥M, since it is then the only way in. */
function registerTalkKey(): void {
  if (!talkKeyOn) {
    talkKeyOn = true;
    chordWatch(true);
  }
  if (!CTRL_ALT_KEYS || globalShortcut.isRegistered(TALK_SHORTCUT)) return;
  const pressed = (): void => {
    // A tap of the mic, as a chord "tap" is (the page's tap rule); its own Control and Option let
    // go just after are no chord tap (onChord).
    lastShortcutAt = Date.now();
    console.log(`[screen-teach] talk key ${TALK_SHORTCUT}: a tap`);
    live()?.webContents.send("screen-teach:talk");
  };
  if (!globalShortcut.register(TALK_SHORTCUT, pressed)) {
    console.warn(`[screen-teach] ${TALK_SHORTCUT} is taken by another app`);
  }
}

function unregisterTalkKey(): void {
  if (talkKeyOn) {
    talkKeyOn = false;
    chordWatch(false);
  }
  if (globalShortcut.isRegistered(TALK_SHORTCUT)) globalShortcut.unregister(TALK_SHORTCUT);
}

/**
 * The talk chord (screen.ts ScreenChord), while the talk key is on: to the lesson's page as it
 * comes ("screen-teach:chord", {kind, ms}), which decides what it is (a tap: one question, or an
 * interrupt, or talk mode off; a hold: talk mode on; down, up, cancel: the hold's ring) and drops
 * it while the student is not with the lesson. Never dropped here for Tutornote's main window
 * having the keys: the chord is the student's, wherever they are. A "tap" just after ⌃⌥M, or one
 * of the lesson's ⌃⌥ keys, is that key's (TALK_KEY_CHORD_MS). Only its kind and time go to the
 * page; why and which keys, to the log.
 */
function onChord(chord: ScreenChord): void {
  const w = live();
  if (!talkKeyOn || !w || !pageReady) return;
  const about = [chord.why, chord.keys].filter(Boolean).join(", ");
  const said = `[screen-teach] chord ${chord.kind} ${chord.ms} ms${about ? ` (${about})` : ""}`;
  if (chord.kind === "tap" && Date.now() - lastShortcutAt < TALK_KEY_CHORD_MS) {
    console.log(`${said}: dropped, a Control+Option shortcut was just pressed`);
    return;
  }
  console.log(said);
  w.webContents.send("screen-teach:chord", { kind: chord.kind, ms: chord.ms });
}

/**
 * Whether the talk chord can be used (screen.ts ScreenChordState), as the helper says it: kept for
 * a page that loads later (told again at screen-teach:ready), and to the page now when it changed
 * ("screen-teach:chord-state", {on}), so its talk key reads ⌃⌥M while the chord cannot work
 * (VoiceOver, secure input, keys hidden from the helper). A page older than it never listens.
 */
function onChordState(state: ScreenChordState): void {
  if (state.on === chordUsable) return;
  chordUsable = state.on;
  console.log(`[screen-teach] chord ${state.on ? "usable" : `not usable (${state.why ?? "?"}): ${TALK_SHORTCUT} is the way in`}`);
  const w = live();
  if (w && pageReady) w.webContents.send("screen-teach:chord-state", { on: chordUsable });
}

/**
 * Teach the window just read, from where the student clicked (both in screen points).
 * A lesson already on screen starts again from this one.
 */
export async function openScreenTeach(read: ScreenRead, click: Point, opts?: ScreenTeachOptions): Promise<void> {
  const run = ++runs;
  // The display that holds most of the window being read, and the part of it the lesson's window
  // covers: its work area, or all of it for a window in native full screen (boardHost.ts).
  const display = displayFor(read.frame);
  const area = overlayArea(display, read.frame);
  // (a companion pick: the answer from under a minute ago, and a new one asked behind the lesson)
  const kept = companion?.on && axAnswer && Date.now() - axAnswer.at < AX_KEEP_MS ? axAnswer.allowed : null;
  const canTurn = kept ?? (await turningAllowed());
  if (kept !== null) void turningAllowed();
  if (run !== runs) return; // a newer pick
  // (another document's run, asked for before that wait: not when its switch is over by now, nor
  // with the student gone on to another app, where a run playing aloud would be behind their back)
  if (opts?.still && !opts.still()) return;
  const w = ensureWindow(area);
  // The companion's window, moved with it (a pick made on another display while the tutor is on,
  // or over a window in full screen, or out of one).
  const movedCompanion = Boolean(companion?.on && !sameBounds(companion.work, area));
  // Where macOS really put it: the boxes are made local to this.
  const b = w.getBounds();
  const mode: ScreenMode = PAGE_APPS.has(read.bundle) ? "page" : "scroll";
  // (the last lesson's wait for the student, if any, is over; and its stay in another app timed:
  // the helper says again which app is in front as this window is watched)
  lesson?.waiting?.abort();
  clearAppFollow();
  lesson = {
    run,
    window: read.window,
    pid: read.pid,
    app: read.app,
    bundle: read.bundle,
    mode,
    way: null,
    queue: Promise.resolve(),
    waiting: null,
    frame: read.frame,
    text: textBox(read.lines),
    home: overlayHome(display, read.frame),
    lines: read.lines,
    title: read.title,
    doc: docKeyOf(read),
    look: { frame: read.frame, lines: read.lines, bundle: read.bundle },
    titles: [],
    checking: null,
    switching: null,
    switchedAt: 0,
    turnedAt: 0,
    moving: null,
  };
  // The page and companion.ts hear where the companion's window is now, as for a move of its own
  // (once this lesson is the one on: companion.ts keeps the window on the lesson's display then).
  if (movedCompanion && companion) {
    companion.work = area;
    companion.message = { ...companion.message, overlay: overlayRect(w) };
    sendCompanion();
    appEvents.emit("screen-teach-moved");
  }
  pending = {
    run,
    overlay: { x: b.x, y: b.y, w: b.width, h: b.height },
    read: toLocal(read, b),
    click: { x: click.x - b.x, y: click.y - b.y },
    canTurn,
    mode,
    // Companion mode: the card's pick, a quiet start after the first, and the page's ground.
    // While the tutor is on, every lesson is the companion's (a pick made meanwhile too).
    ...(opts?.choice ? { choice: opts.choice } : {}),
    ...(opts?.quiet ? { quiet: true } : {}),
    ...(opts?.companion || companion?.on ? { companion: true } : {}),
    ...(typeof read.ground === "number" && Number.isFinite(read.ground) ? { ground: read.ground } : {}),
    // (the tapped row's words, and whether the read is older than the window's look now)
    ...(opts?.row ? { row: opts.row } : {}),
    ...(opts?.stale ? { stale: true } : {}),
    // (another document, seen where the last run was teaching: switchRead)
    ...(opts?.switched ? { switched: true } : {}),
    // (the same document, where its window went: rehome)
    ...(opts?.rehomed ? { rehomed: true } : {}),
  };
  console.log(
    `[screen-teach] run ${run}: ${read.app} (${read.bundle || "no bundle id"}), ${mode}, turning ${canTurn ? "allowed" : "not allowed"}` +
      (pending.companion ? `, companion${pending.choice ? ` ${pending.choice}` : ""}${pending.quiet ? ", quiet" : ""}${pending.stale ? ", stale" : ""}` : "") +
      (pending.switched ? ", switched" : "") +
      (pending.rehomed ? ", rehomed" : ""),
  );
  // (companion.ts keeps its glance of this window as read here)
  appEvents.emit("screen-teach-read", read);
  // The student's taps on that window, and the app in front (installScreenTeach's listeners).
  aside = false;
  // (a pick is the student with the lesson: a page last told they were away hears they are back)
  if (pageReady) w.webContents.send("screen-teach:present", true);
  // The last lesson's board goes with it; this one's comes up when its page has put something on it.
  boardWanted = false;
  releaseHold();
  watchWindow(read.window);
  // The window's new looks (a page or a slide the student turned, a key, a scroll bar) reach the
  // lesson with the companion off too (onLessonChanged): the companion watches it itself while on.
  // (and no longer a window the last run's switch waited on: observeSwitch). In a page app, a page
  // a wheel or a swipe turns is said as one a key turns: nothing follows it from the scroll.
  switchObserved = null;
  observePaged(mode === "page" ? [read.window] : []);
  if (!companion?.on) observeWindows([read.window]);
  registerShortcuts();
  w.webContents.setAudioMuted(false);
  liveBoard()?.contents.setAudioMuted(false);
  // (its app may not be the last lesson's: Back to {app})
  sendPlace();
  clearTimeout(readyTimer);
  if (pageReady) {
    w.webContents.send("screen-teach:start", pending);
    w.showInactive();
    syncBoard();
    return;
  }
  syncBoard();
  // Shown when the page asks for its start (screen-teach:ready); a page that never does
  // (it did not load, or the app's copy of the web app has no such page) ends the lesson.
  readyTimer = setTimeout(() => {
    if (lesson?.run === run && !pageReady) {
      console.warn("[screen-teach] the lesson page never said it was ready");
      failLesson("The lesson couldn't open. Please try again.");
      dropWindow();
    }
  }, READY_TIMEOUT_MS);
}

/** End the lesson, if one is on: the page stops, the window hides (and is kept). True when one was on. */
function endLesson(): boolean {
  clearTimeout(readyTimer);
  if (!lesson) return false;
  lesson.waiting?.abort();
  lesson = null;
  pending = null;
  aside = false;
  clearTimeout(homing?.timer);
  homing = null;
  clearAppFollow();
  unwatchWindow();
  // (the companion, if on, goes on watching the window under the cursor: refreshObserve)
  switchObserved = null;
  observePaged([]);
  if (!companion?.on) observeWindows([]);
  unregisterShortcuts();
  interactive = false;
  scrolling = 0;
  boardWanted = false;
  covering = false;
  const w = live();
  if (w) {
    w.webContents.send("screen-teach:command", "close");
    // Hidden, it must not go on talking whatever the page does with "close".
    w.webContents.setAudioMuted(true);
    // (nor a clip playing on the board)
    liveBoard()?.contents.setAudioMuted(true);
    applyMouse();
    // With the companion on, the window stays: the tutor goes on following the cursor.
    if (!companion?.on) w.hide();
  }
  syncBoard();
  return true;
}

/** Close the lesson on screen (its own Close, or "Explain on screen" closing). */
export function closeScreenTeach(): void {
  // A lesson still opening (openScreenTeach waiting on the helper) is dropped too.
  runs++;
  if (endLesson()) appEvents.emit("screen-teach-closed");
}

function failLesson(text: string): void {
  if (endLesson()) appEvents.emit("screen-teach-failed", text);
}

export const screenTeachOpen = (): boolean => lesson !== null;

/** The board has the keys: its own window is the key window, or the main window is, on its tab. */
function boardHasKeys(): boolean {
  const b = liveBoard();
  if (!b) return false;
  return b.place === "float" ? b.host.isFocused() : boardTabDocked() && boardTabActive() && Boolean(getMainWindow()?.isFocused());
}

/** The lesson's window, or its board's, has the keys (the student clicked into it): the app's
 *  menus are not for the main window's tab then (menu.ts). */
export const screenTeachFocused = (): boolean => Boolean(lesson && (live()?.isFocused() || boardHasKeys()));

/** The board's window has the keys: ⌘W closes the board, not the lesson (menu.ts). */
export const screenBoardFocused = (): boolean => Boolean(lesson && boardHasKeys());

/** The ways to try, in order, until one moves the window. Kindle Cloud Reader is a page app inside a browser. */
const waysFor = (mode: ScreenMode): Way[] =>
  mode === "page"
    ? [
        { how: "key", key: "right" },
        { how: "key", key: "pagedown" },
      ]
    : [{ how: "scroll" }, { how: "key", key: "pagedown" }, { how: "key", key: "right" }];

/** `unlessMoved`: post nothing when the window has moved since its last read (the student's own move). */
async function move(way: Way, req: ScreenTurnRequest, base: Pick<ScreenTurn, "window" | "pid" | "at">, timeoutMs: number, unlessMoved: boolean) {
  const forward = req.dir === "forward";
  if (way.how === "key") {
    const key = forward ? way.key : BACK_KEY[way.key];
    return turnWindow({ ...base, how: "key", key, count: req.pages, timeoutMs: timeoutMs + KEY_GAP_MS * (req.pages - 1), unlessMoved });
  }
  const by = req.scrollBy > 0 ? req.scrollBy : DEFAULT_SCROLL;
  scrolling++;
  applyMouse();
  try {
    return await turnWindow({ ...base, how: "scroll", dy: forward ? by : -by, timeoutMs, unlessMoved });
  } finally {
    scrolling = Math.max(0, scrolling - 1);
    applyMouse();
  }
}

function reasonOf(e: unknown): "no_access" | "no_permission" | "window_gone" | "failed" {
  const code = e instanceof ScreenReadError ? e.code : "";
  if (code === "no_access" || code === "no_permission" || code === "window_gone") return code;
  return code === "no_window" ? "window_gone" : "failed";
}

const sameWay = (a: Way, b: Way): boolean => a.how === b.how && (a.how !== "key" || (b.how === "key" && a.key === b.key));

/** `waiting`: a manual turn's, to give its wait up with (Lesson.waiting). */
async function turn(req: ScreenTurnRequest, waiting: AbortController | null): Promise<ScreenTurnResult> {
  const current = lesson;
  const shown = live();
  const started = Date.now();
  // (another document seen meanwhile, or being read: what the window shows is no page of this
  // run's, even once the switch turned out a flick; the turn already posted is never taken as one)
  const stale = (): boolean =>
    !current || lesson !== current || current.run !== req.run || !live() || current.switching !== null || current.switchedAt >= started;
  if (!current || !shown || stale()) return { ok: false, reason: "stale" };
  const origin = shown.getBounds();
  const base = { window: current.window, pid: current.pid, at: { x: origin.x + req.at.x, y: origin.y + req.at.y } };
  try {
    let how: "scroll" | "key" | "manual";
    let canTurn: boolean | undefined;
    // (the deciding move's wait for the window to settle, for the log: turnReadLine)
    let settleMs = 0;
    if (req.how === "manual") {
      // Post nothing: wait for the student to turn the page, or scroll, themselves (one made
      // already since the last read counts: unlessMoved).
      const moved = await turnWindow({ ...base, how: "manual", timeoutMs: MANUAL_WAIT_MS, unlessMoved: req.unlessMoved }, waiting?.signal);
      settleMs = moved.settleMs;
      if (stale()) return { ok: false, reason: "stale" };
      // Not turned in time: the lesson stops there, and its next play waits for them again.
      // Not "failed", which the page shows as a page it could not read.
      if (!moved.changed) return { ok: false, reason: "end" };
      how = "manual";
      // (Accessibility switched on meanwhile: the next turn can be the app's own)
      canTurn = await turningAllowed();
    } else {
      if (!(await turningAllowed())) return stale() ? { ok: false, reason: "stale" } : { ok: false, reason: "no_access" };
      // The way that worked before first, then the others: a key that has stopped working (the
      // focus moved in the app) is not yet the end of the book.
      const kept = current.way;
      const ways = kept ? [kept, ...waysFor(current.mode).filter((w) => !sameWay(w, kept))] : waysFor(current.mode);
      let won: Way | null = null;
      let theirs = false;
      // Some key was pressed while the app was not in front: it may never have reached it.
      let unsure = false;
      for (const [i, way] of ways.entries()) {
        if (stale()) return { ok: false, reason: "stale" };
        const moved = await move(way, req, base, way === kept ? TURN_TIMEOUT_MS : TRY_TIMEOUT_MS, i === 0 && req.unlessMoved);
        settleMs = moved.settleMs;
        if (moved.moved) {
          theirs = true;
          break;
        }
        if (moved.changed) {
          won = way;
          break;
        }
        if (moved.front === false) unsure = true;
      }
      if (stale()) return { ok: false, reason: "stale" };
      if (theirs) {
        // The student had turned or scrolled it themselves: that is this turn.
        how = "manual";
      } else if (!won) {
        // Nothing moved the window. The end of the book or the document, in an app that has
        // been turned before and was in front for the keys; else it can't be told from keys
        // that never arrived, and the student turns this page.
        return { ok: false, reason: unsure || !kept ? "stuck" : "end" };
      } else {
        if (!kept || !sameWay(won, kept)) console.log(`[screen-teach] ${current.app} turns by ${won.how === "key" ? `the ${won.key} key` : "scrolling"}`);
        current.way = won;
        // A key that turns it makes it a page app, whatever it was taken for (and so the helper
        // says a page its wheel or a swipe turns, as for Kindle: observePaged).
        if (won.how === "key") {
          current.mode = "page";
          observePaged([current.window]);
        }
        how = won.how;
      }
    }
    // (where the window is now, dragged while it was read: readNow; its times and counts, which
    // readNow's toLocal leaves out, logged from the helper's own answer)
    const answer = await readWindow(current.window);
    console.log(turnReadLine(current.run, answer, settleMs, Date.now() - started));
    const read = readNow(answer);
    // (not taken as the lesson's read when stale: another document's title would be its own then)
    if (stale()) return { ok: false, reason: "stale" };
    // (its window gone over another display, or full screen or back: the run starts afresh there,
    // and this read, in the old overlay's points, is no use to this one: rehomeSoon)
    const away = awayFromHome(current, read.frame);
    if (away) {
      rehomeSoon(current, away);
      return { ok: false, reason: "stale" };
    }
    noteRead(current, read);
    const w = live();
    if (stale() || !w) return { ok: false, reason: "stale" };
    appEvents.emit("screen-teach-read", read);
    return { ok: true, how, mode: current.mode, read: toLocal(read, w.getBounds()), ...(canTurn === undefined ? {} : { canTurn }) };
  } catch (e) {
    // (a wait for the student given up for the page's next request: nothing to answer)
    if (stale() || (e instanceof ScreenReadError && e.code === "cancelled")) return { ok: false, reason: "stale" };
    console.warn(`[screen-teach] turn failed: ${e instanceof ScreenReadError ? e.code : (e as Error).message}`);
    return { ok: false, reason: reasonOf(e) };
  }
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A turn request from the page, checked field by field, or null. */
function turnRequestOf(value: unknown): ScreenTurnRequest | null {
  const r = (value ?? {}) as Record<string, unknown>;
  const at = (r.at ?? {}) as Record<string, unknown>;
  if (!finite(r.run) || (r.dir !== "forward" && r.dir !== "back") || !finite(at.x) || !finite(at.y)) return null;
  return {
    run: r.run,
    dir: r.dir,
    scrollBy: finite(r.scrollBy) ? Math.min(Math.abs(r.scrollBy), 20_000) : 0,
    pages: finite(r.pages) ? Math.max(1, Math.min(Math.round(r.pages), 50)) : 1,
    at: { x: at.x, y: at.y },
    how: r.how === "manual" ? "manual" : "auto",
    unlessMoved: r.unlessMoved === true,
  };
}

/** After the lesson's turns and reads so far. */
function queued<T>(current: Lesson, job: () => Promise<T>): Promise<T> {
  const result = current.queue.then(job);
  current.queue = result.catch(() => undefined);
  return result;
}

/**
 * A tap on the page being read. The window let it through to that app, which got it; the helper
 * heard it (screen.ts watchEvents). Over the lesson's own controls it was the lesson's click, not
 * a tap on the page. If the window has moved since it was last read (the student scrolled it),
 * what the lesson holds is no longer where it was: the window is read again and the lesson starts
 * afresh from the tap, as a new pick does. Otherwise the page goes on from the paragraph there.
 */
/** The page decides what a tap is (ScreenTeachPage): a paragraph it has read, followed to
 *  wherever the student scrolled it, or words it has not read yet (`moved`: the window changed
 *  since its last read), which start the lesson again from there (screen-teach:pick-at). With the
 *  companion on it heard the release first (companion.ts onRelease), and may have opened its card
 *  then: `id` ties this verdict to it. */
function onTap(tap: ScreenTap): void {
  const current = lesson;
  const w = live();
  if (!current || !w || tap.window !== current.window || aside || !w.isVisible()) return;
  // (companion mode: a click on the page's own card or dock, whatever it has said since. A verdict
  // for a release (`id`) goes by its press alone, as the release did (companion.ts onRelease): by
  // now the cursor may be over a card the page painted at that release, and the tap was still
  // on the page being read)
  if (pressWasThePage() || (interactive && tap.id === undefined)) return;
  // The helper sees past Tutornote's own windows: a click on the board where it lies over the
  // page being read was the board's, not a tap on the words under it. Where it was a moment ago
  // too: the tap comes in after the click, which may have hidden the board or made it smaller.
  if (overBoard(tap, true) || overMain(tap)) {
    console.log("[screen-teach] tap on the board left out");
    return;
  }
  // A plain click that did something in the app (a link, a button, a page turned by its margin)
  // was the app's: the lesson notices the new look by itself (screen-teach:changed). An Option
  // click is always the tutor's. A double click selects words: the app's too, but in a reader or
  // a browser's PDF (selectionKept), where selecting a word is how the student points at it: a
  // lesson tap there, which the page takes as one that did nothing in the app. A card the page
  // opened at the release goes at once (companion-withdraw).
  const kept = selectionKept({ words: tap.words, bundle: current.bundle, title: current.title });
  if (!kept && ((tap.acted && !tap.alt) || tap.words === "select")) {
    console.log(`[screen-teach] tap acted in ${current.app}: left to the app${tapNumbers(tap)}`);
    if (companion?.on && tap.id !== undefined) {
      w.webContents.send("screen-teach:companion-withdraw", { id: tap.id, why: tap.words ?? "acted", window: tap.window });
    }
    // The window's title changed under the tap (the student clicked another tab): another document.
    // The helper's ident says so first, and decides by the title itself; from a helper that says
    // nothing of the window's document, this is how the lesson hears of it.
    if (tap.words === "title" && lastIdent?.window !== current.window) {
      beginSwitch(current, "tap", { window: current.window, pid: current.pid, app: current.app });
    }
    return;
  }
  if (kept) console.log(`[screen-teach] tap in ${current.app}: a lesson tap${tapNumbers(tap)} (selection in a reader: kept)`);
  const b = w.getBounds();
  w.webContents.send("screen-teach:tap", {
    run: current.run,
    x: tap.x - b.x,
    y: tap.y - b.y,
    moved: tap.moved,
    acted: kept ? false : tap.acted,
    alt: tap.alt,
    ...(tap.id !== undefined ? { id: tap.id } : {}),
  });
}

/** Read the window again (or take the companion's careful read from the tap: carefulRead) and
 *  start the lesson afresh from `at` (screen points), as a new pick does. The page asks only for
 *  a tap its own targeting placed on words (tapTarget: a margin beside a line counts, a picture
 *  does not), so any read with lines will do; one with none (a window still drawing) changes
 *  nothing. */
function restartAt(current: Lesson, at: Point, why: string): void {
  console.log(`[screen-teach] ${why}: reading it again from there`);
  const asked = Date.now();
  // (after the lesson's turns so far: the careful read taken at the tap, if it still stands for
  // the window as it is now, else a read now; one that failed is read again)
  void queued(current, () => {
    const taken = carefulRead(current.window, Math.max(current.turnedAt, asked - TAP_READ_FRESH_MS));
    if (taken) console.log("[screen-teach] starting from the companion's read taken at the tap");
    return taken ? taken.catch(() => readWindow(current.window)) : readWindow(current.window);
  }).then(
    (read) => {
      // (another document seen there since it was asked, or being read: the switch's run is the
      // one to start, on what the switch reads, and this read may show either document)
      if (lesson !== current) return;
      if (current.switching || current.switchedAt >= asked) {
        console.log("[screen-teach] the read after a tap left out: another document came up meanwhile");
        return;
      }
      // (with the companion on, quietly: no new greeting or start sound in the middle of its session)
      if (read.lines.length) void openScreenTeach(read, at, companion?.on ? { companion: true, quiet: true } : undefined);
      else console.log("[screen-teach] no words in the window: the lesson goes on");
    },
    (e: unknown) => console.warn(`[screen-teach] read after a tap failed: ${e instanceof ScreenReadError ? e.code : (e as Error).message}`),
  );
}

/**
 * The student scrolling the page being read: the lesson's marks move with its words at once, as
 * over a PDF in the app (the page corrects the distance by reading the window again once the
 * scroll stops). Not while a turn of the lesson's own is posted: that move is the turn's. A switch
 * waiting for words in the window scrolled reads it again once the scroll has stopped
 * (SWITCH_SCROLL_MS): the helper says no new look that a wheel explains.
 */
function onScroll(scroll: ScreenScroll): void {
  const current = lesson;
  const w = live();
  const s = current?.switching;
  if (current && s?.waitingFor === "words" && scroll.window === s.target) {
    clearTimeout(switchScroll);
    switchScroll = setTimeout(() => {
      if (current.switching === s) readAgain(current, "the student scrolled it");
    }, SWITCH_SCROLL_MS);
  }
  if (!current || !w || scroll.window !== current.window || aside || scrolling > 0 || !w.isVisible()) return;
  // (sideways too, a pan across a zoomed page: the page goes with it as it does up and down. A page
  // a swipe turns, in an app that turns by the page, is said as a new look: observePaged)
  if (scroll.dy === 0 && scroll.dx === 0) return;
  // Scrolling the board, over the page being read, moves the board, not the page's words (a
  // scroll comes with no point: the pointer is where it was made).
  const cursor = screen.getCursorScreenPoint();
  if (overBoard(cursor) || overMain(cursor)) {
    const now = Date.now();
    if (now - scrollDropLogged > 2_000) console.log("[screen-teach] scroll on the board left out");
    scrollDropLogged = now;
    return;
  }
  // (`lines`: a mouse wheel's, by which the page learns how far a line moves this app; 0 for a
  // trackpad's points)
  w.webContents.send("screen-teach:scroll", { run: current.run, dy: scroll.dy, dx: scroll.dx, lines: scroll.lines });
}

/**
 * Another app came to the front (`pid`). The lesson belongs over the window it reads: while the
 * student is in another app it steps aside, hidden and paused, and comes back (playing again if
 * it was playing) when they return to that app.
 *
 * Tutornote itself coming to the front says nothing by itself: its main window stays open now
 * (it no longer hides for a lesson), and the student going to their notes there is going
 * elsewhere, while their click on the lesson's own window or its board is not. So which of its
 * windows takes the keys decides (onOwnFocus).
 *
 * The student staying in the other app on a reading window there is another document: the lesson
 * follows them to it (followApp). Back in the lesson's app before a switch there has been read,
 * it is no switch after all; but for one that was taken there from another document in the
 * lesson's app (Switching.from, which may still be in front): that is read again (switchBack).
 * Back in the app of a switch that waited for them (they went on elsewhere as it was read:
 * waitSwitch), it is read again.
 */
function onFront(pid: number): void {
  frontPid = pid;
  if (pid !== process.pid) mainOnTop = false;
  const current = lesson;
  const s = current?.switching;
  if (current && s?.why === "app" && pid === current.pid) {
    if (s.from) switchBack(current, s.from);
    else cancelSwitch(current, "back", "the student is back in its app");
  } else if (current && s?.waitingFor === "student" && pid === s.pid) readAgain(current, "the student is back");
  followApp(pid);
  if (pid === process.pid) return;
  stepAside(pid !== lesson?.pid);
}

/** A window of Tutornote's took the keys (app "browser-window-focus"): the main window, or the
 *  pick's panel, is somewhere other than the lesson; the lesson's own window (a question typed
 *  to the tutor) or its board changes nothing. Nor does the main window taking them as the
 *  lesson's window takes or gives them up (want-keys): macOS may hand them on that way. */
function onOwnFocus(focused: BrowserWindow): void {
  // (the board's own window is no BrowserWindow, and raises no browser-window-focus)
  if (focused === live()) return;
  if (Date.now() - keysMovedAt < KEYS_MOVED_MS) return;
  // The main window: judged a moment later, by the tab it shows then (a click on the Board tab
  // selects it just after the window takes the keys).
  if (focused === getMainWindow()) {
    clearTimeout(mainFocusTimer);
    mainFocusTimer = setTimeout(judgeMain, MAIN_FOCUS_SETTLE_MS);
    return;
  }
  stepAside(true);
}

/** The student went somewhere other than the lesson's app (`away`), or came back to it. */
function stepAside(away: boolean): void {
  const current = lesson;
  const w = live();
  if (!current || !w || !pageReady) return;
  const ours = !away;
  // With the companion on, the window stays up (the tutor keeps following the cursor over the
  // other app, and its card may want clicks there): the page hides the lesson's marks and dock
  // itself (screen-teach:aside), and on the way back it reads the window again before it plays
  // on, so no "resume". Either way the page hears whether the student is with the lesson
  // (screen-teach:present): its mics follow that, not the window's focus.
  if (!ours && !aside) {
    aside = true;
    w.webContents.send("screen-teach:command", "pause");
    w.webContents.send("screen-teach:present", false);
    if (companion?.on) {
      w.webContents.send("screen-teach:aside", true);
    } else {
      interactive = false;
      applyMouse();
      w.hide();
    }
    // (the board steps aside with it, and comes back with it)
    syncBoard();
  } else if (ours && aside) {
    aside = false;
    covering = false;
    // (its window went over another display while the student was away: its run starts afresh
    // there now)
    if (homing?.lesson === current && !homing.timer) rehome(homing);
    sendPlace();
    w.webContents.send("screen-teach:present", true);
    if (companion?.on) {
      syncBoard();
      w.webContents.send("screen-teach:aside", false);
      return;
    }
    w.showInactive();
    syncBoard();
    w.webContents.send("screen-teach:command", "resume");
  }
}

/*
  Another document (APP_FOLLOW_MS, above, says the whole of it).
*/

/** A window the student reads in, in another app: a reader's (Kindle, Books, Preview), or a
 *  browser's showing a PDF (its title ends in ".pdf", as companionPlace.ts selectionKept says). */
const readingWindow = (bundle: string, title: string): boolean => isReaderApp(bundle) || (isBrowserApp(bundle) && /\.pdf$/i.test(title.trim()));

function clearAppFollow(): void {
  if (appFollow) clearTimeout(appFollow.timer);
  appFollow = null;
}

/** `pid` came to the front: the student's stay there is timed when it is another app than the
 *  lesson's (not Tutornote), and the lesson follows them once they have stayed APP_FOLLOW_MS on a
 *  reading window there (maybeFollowApp). */
function followApp(pid: number): void {
  clearAppFollow();
  const current = lesson;
  if (!current || pid === current.pid || pid === process.pid) return;
  appFollow = { pid, at: Date.now(), timer: setTimeout(maybeFollowApp, APP_FOLLOW_MS) };
}

/** The lesson follows the student to the reading window of the app they have stayed in for
 *  APP_FOLLOW_MS ("app"), as the helper last said that window (ScreenIdent.other): at the stay's
 *  end, or as they come to such a window later in the same stay. Never a private app's (nor one
 *  under secure input, which the helper does not say), never a window that is not one to read in
 *  (that is a step aside, as before), nor a sheet, a panel or a popup of that app over its
 *  document (no title of its own, or smaller than a document's window: SWITCH_MIN_W by
 *  SWITCH_MIN_H points). A switch being read is left to finish; one that waits (waitSwitch: the
 *  student went on from it to this app) is taken there instead, and reads that window. */
function maybeFollowApp(): void {
  const current = lesson;
  const f = appFollow;
  const s = current?.switching ?? null;
  if (!current || !f || !pageReady || (s && s.waiting === undefined) || frontPid !== f.pid || f.pid === current.pid) return;
  // (a timer can fire a millisecond early by the clock, and no ident may come again while the
  // student sits still there: what is left of the stay is waited out, never dropped)
  const left = APP_FOLLOW_MS - (Date.now() - f.at);
  if (left > 0) {
    clearTimeout(f.timer);
    f.timer = setTimeout(maybeFollowApp, left + 10);
    return;
  }
  const other = lastIdent?.window === current.window ? lastIdent.other : null;
  if (!other || other.pid !== f.pid || isPrivateApp(other.bundle) || !readingWindow(other.bundle, other.title)) return;
  if (!other.title.trim() || !other.frame || other.frame.w < SWITCH_MIN_W || other.frame.h < SWITCH_MIN_H) return;
  clearAppFollow();
  if (s) {
    // (the page was told of the switch as it began, and stays stopped: only where it reads moves.
    // Back in the lesson's app, what it was reading there is read again: onFront)
    if (s.why !== "app") s.from = { why: s.why, target: s.target };
    s.why = "app";
    s.target = other.window;
    s.pid = other.pid;
    s.app = other.app || "another app";
    readAgain(current, `the student stayed in ${s.app}`);
    return;
  }
  beginSwitch(current, "app", { window: other.window, pid: other.pid, app: other.app || "another app" });
}

/** The student is back in the lesson's app from the one a switch was taken to (maybeFollowApp),
 *  which began in that app (`from`: another tab or window of it, perhaps still in front): that one
 *  is read again, as at first, the page left stopped as it is (a read of the other app's window
 *  still going is dropped: the switch is another one now). */
function switchBack(current: Lesson, from: { why: SwitchWhy; target: number }): void {
  const was = current.switching;
  if (lesson !== current || !was) return;
  const mine: Switching = { at: was.at, why: from.why, target: from.target, pid: current.pid, app: current.app };
  current.switching = mine;
  console.log(`[screen-teach] run ${current.run}: the student is back in its app: reading its other document again (${from.why})`);
  live()?.webContents.send("screen-teach:switching", { run: current.run, on: true, why: "reading" });
  observeSwitch(current);
  readSwitch(current, mine, Date.now());
}

/*
  The lesson's window moved (docIdentity.ts frameMove: dragged by its title bar, Cmd dragged from
  behind, put elsewhere by a window manager), its size kept. No pixel of it changed, only where it
  is, so the helper says no new look for it, and until the next read the lesson's pointer and
  marks stayed where its words had been (the founder, 2026-10-28: the tutor over another app
  "should be very accurate in the way it points at things" and "super responsive"). The helper
  says where it is on every ident tick while it goes (IDENT_MS), and everything the lesson holds of
  it moves by as much at once: its frame, words, lines and latest look here (a tap is judged on
  them, a sheet hangs from that frame: docIdentity.ts sheetOf), the page's stand-in and marks
  (screen-teach:moved {run, dx, dy}, the move since the last one said: a page older than it
  listens for none, and goes by its next read as before), and companion.ts's glance of the window
  (screen-teach-window-moved). Once it is still (MOVE_SETTLE_MS), the board's place is weighed
  again, as after a read, and the drag is logged once, by its numbers.
  Onto another display, into native full screen or out of it, or its display's bounds changed
  (boardHost.ts displayChanged), every point the page holds is in the old overlay's points, which
  no move can mend: the run starts afresh where the window is, quietly (rehome), once its frame
  has been still HOME_SETTLE_MS, since a drag across displays passes over both; dragged back
  meanwhile, it goes on. A read that finds it there (a turn's, the page's reread) is not passed
  on, and starts it so too; so does a display rearranged or gone (installScreenTeach). Not while
  another document seen there is read (its run is put where it is), nor while the student is in
  another app (as they come back: stepAside) or secure input is on (as it goes off: onIdent).
*/
const MOVE_SETTLE_MS = 300;
const HOME_SETTLE_MS = 500;
/** Where the window went, it is read this many times at most while it shows no words (still
 *  drawing). */
const HOME_TRIES = 2;
/** One drag of the lesson's window, its moves summed as they come, for its log line. */
let dragging: { run: number; dx: number; dy: number; steps: number; timer: NodeJS.Timeout } | null = null;
/** The run to start afresh where its window went, and why (for the log): due once its frame has
 *  been still HOME_SETTLE_MS (`timer`), or, with none, as the student comes back to it (aside). */
type Homing = { lesson: Lesson; why: string; tries: number; timer?: NodeJS.Timeout };
let homing: Homing | null = null;

const movedBox = <T extends Point>(box: T, dx: number, dy: number): T => ({ ...box, x: box.x + dx, y: box.y + dy });
const movedLines = (lines: ReadonlyArray<ScreenLine>, dx: number, dy: number): ScreenLine[] =>
  lines.map((line) => (line.words ? { ...movedBox(line, dx, dy), words: line.words.map((word) => movedBox(word, dx, dy)) } : movedBox(line, dx, dy)));

/** Two frames of the lesson's window are of another size (docIdentity.ts MOVE_SAME_SIZE): a resize,
 *  no move. */
const otherSize = (a: Rect, b: Rect): boolean => Math.abs(a.w - b.w) > MOVE_SAME_SIZE || Math.abs(a.h - b.h) > MOVE_SAME_SIZE;

/** The helper says where the lesson's window is now (an ident): a move of it moves the lesson with
 *  it, and a frame that wants the lesson's window elsewhere starts the run afresh there (above). */
function followFrame(current: Lesson, ident: ScreenIdent): void {
  const now = identFrame(ident);
  if (!now) return;
  const move = frameMove(current.frame, ident);
  if (move) moveLesson(current, move.dx, move.dy);
  // (resized: no move, its page laid out afresh, which only a read can tell; but its next drag is
  // measured from the size and place it has now, not from its last careful read's: a resize may
  // bring only a quick read, and every drag after it was taken for another resize and followed by
  // nothing. Its words, lines and look wait for a read)
  else if (otherSize(now, current.frame)) current.frame = { x: now.x, y: now.y, w: now.w, h: now.h };
  const away = awayFromHome(current, now);
  if (away) rehomeSoon(current, away);
  else if (homing?.lesson === current) {
    // (back where its run put the lesson's window before it was due: the lesson goes on there)
    clearTimeout(homing.timer);
    homing = null;
  }
}

/** Everything the lesson holds of its window moves by (dx, dy) points, as the window did (above). */
function moveLesson(current: Lesson, dx: number, dy: number): void {
  current.frame = movedBox(current.frame, dx, dy);
  current.text = current.text ? movedBox(current.text, dx, dy) : null;
  current.lines = movedLines(current.lines, dx, dy);
  current.look = { frame: movedBox(current.look.frame, dx, dy), lines: movedLines(current.look.lines, dx, dy), bundle: current.look.bundle };
  // (a page that loads again, a reload, is given its run's start where the window is now: toLocal
  // takes an origin off every box, so less the move is the move added)
  if (pending?.run === current.run) pending = { ...pending, read: toLocal(pending.read, { x: -dx, y: -dy }), click: movedBox(pending.click, dx, dy) };
  live()?.webContents.send("screen-teach:moved", { run: current.run, dx, dy });
  appEvents.emit("screen-teach-window-moved", { window: current.window, dx, dy });
  const was = dragging?.run === current.run ? dragging : null;
  clearTimeout(dragging?.timer);
  const drag = { run: current.run, dx: (was?.dx ?? 0) + dx, dy: (was?.dy ?? 0) + dy, steps: (was?.steps ?? 0) + 1 };
  dragging = {
    ...drag,
    timer: setTimeout(() => {
      dragging = null;
      console.log(`[screen-teach] run ${drag.run}: its window moved ${Math.round(drag.dx)},${Math.round(drag.dy)} points (${drag.steps} steps)`);
      if (lesson === current) boardBeside(current);
    }, MOVE_SETTLE_MS),
  };
}

/** A read of the lesson's window where the window is now: one taken before a move the helper has
 *  said since (its latest ident: frameMove; a read takes a few hundred milliseconds, a drag goes on
 *  meanwhile) is moved by as much, its words where they are in the window, which a move changes
 *  none of. Else, once the window is still, nothing would put the lesson right until its next
 *  read. (A read newer than the ident is moved back to where that says, and the next ident, a
 *  moment later, moves it on.) */
function readNow(read: ScreenRead): ScreenRead {
  const i = lastIdent;
  if (!i || i.window !== read.window) return read;
  const move = frameMove(read.frame, i);
  return move ? toLocal(read, { x: -move.dx, y: -move.dy }) : read;
}

/** Why the lesson's window, now at `frame` (screen points), wants its overlay elsewhere than its
 *  run put it (boardHost.ts displayChanged), for the log; or null when it does not. */
function awayFromHome(current: Lesson, frame: Rect): string | null {
  const display = displayFor(frame);
  if (!displayChanged(current.home, display, frame)) return null;
  if (display.id !== current.home.displayId) return "its window went to another display";
  return fullScreenFrame(frame, display.bounds) !== current.home.full ? "its window went into full screen or out of it" : "its display changed";
}

/** The run starts afresh where its window went once its frame has been still HOME_SETTLE_MS
 *  (rehome; each new word of it waits again). Not while another document seen there is read. */
function rehomeSoon(current: Lesson, why: string): void {
  if (lesson !== current || current.switching) return;
  clearTimeout(homing?.timer);
  const tries = homing?.lesson === current ? homing.tries : 0;
  const mine: Homing = { lesson: current, why, tries };
  mine.timer = setTimeout(() => rehome(mine), HOME_SETTLE_MS);
  homing = mine;
}

/** Read the lesson's window where it went, and start its run afresh from there, quietly (no
 *  greeting, no start sound), at its first words (docIdentity.ts firstBodyPoint), as a run on
 *  another document starts: the page's place in the lesson is its own, and the Mac app knows
 *  none of it. It is the same run to the student (ScreenStart.rehomed): a page that knows it
 *  plays it on only if the one before was playing, so a lesson paused, a run standing on a new
 *  document's first words (a chat, a form: nothing asked of the server until Play) or a held tutor
 *  is never started by the green button or a display unplugged. A wait for the student's own turn
 *  is given up (that run is over). Read back where its run put the overlay after all, the lesson
 *  goes on; with no words there yet, read again a moment later (HOME_TRIES). Nothing is read while
 *  secure input is on (a password field has the keys), and nothing starts behind the student's
 *  back: in another app, or under secure input, by the time it is read, it waits for them
 *  (`homing` kept with no timer: stepAside, onIdent). */
function rehome(mine: Homing): void {
  if (homing !== mine) return;
  const current = mine.lesson;
  mine.timer = undefined;
  if (lesson !== current || current.switching) {
    homing = null;
    return;
  }
  // (the student in another app: as they come back, stepAside; secure input on: as it goes off,
  // onIdent)
  if (aside || lastIdent?.secure) return;
  homing = null;
  // (back where it was by the helper's latest word: a read that found it away was older)
  const said = lastIdent?.window === current.window ? identFrame(lastIdent) : null;
  if (said && !awayFromHome(current, said)) return;
  console.log(`[screen-teach] run ${current.run}: ${mine.why}: reading it again there`);
  current.waiting?.abort();
  const asked = Date.now();
  void queued(current, () => readWindow(current.window)).then(
    (taken) => {
      if (lesson !== current) return;
      const read = readNow(taken);
      if (current.switching || current.switchedAt >= asked) {
        console.log("[screen-teach] the read where its window went left out: another document came up meanwhile");
        return;
      }
      if (!awayFromHome(current, read.frame)) {
        console.log(`[screen-teach] run ${current.run}: its window is back where it was: the lesson goes on`);
        return;
      }
      if (!read.lines.length) {
        if (mine.tries + 1 >= HOME_TRIES) {
          console.log(`[screen-teach] run ${current.run}: no words where its window went: the lesson goes on`);
          return;
        }
        const again: Homing = { lesson: current, why: mine.why, tries: mine.tries + 1 };
        again.timer = setTimeout(() => rehome(again), HOME_SETTLE_MS);
        homing = again;
        return;
      }
      // (gone to another app meanwhile, or a password field took the keys: started as they come
      // back, or as it goes off, never behind their back; asked again after the wait for the
      // Accessibility answer, just before it starts: `still`)
      const canStart = (): boolean => {
        if (lesson !== current || current.switching) return false;
        if (!aside && !lastIdent?.secure) return true;
        if (homing?.lesson !== current) homing = { lesson: current, why: mine.why, tries: mine.tries };
        console.log(`[screen-teach] run ${current.run}: ${mine.why}: it starts there once the student is back`);
        return false;
      };
      if (!canStart()) return;
      void openScreenTeach(read, firstBodyPoint(read), { quiet: true, rehomed: true, ...(companion?.on ? { companion: true } : {}), still: canStart });
    },
    (e: unknown) => console.warn(`[screen-teach] read where its window went failed: ${e instanceof ScreenReadError ? e.code : (e as Error).message}`),
  );
}

/** A display rearranged, its resolution changed, or gone: the lesson's run starts afresh where its
 *  window is now when its display's bounds are no longer those its run began on, or its window is
 *  on another display now (as macOS moves a window off a display unplugged, the ident says so
 *  too). Told by the home its run kept (awayFromHome), so the ident that follows says the same,
 *  and never by the lesson's window's own bounds, which macOS may set otherwise than asked: no run
 *  is started again and again. */
function homeAfterDisplays(): void {
  const current = lesson;
  if (!current || !live() || !pageReady) return;
  const why = awayFromHome(current, current.frame);
  if (why) rehomeSoon(current, why);
}

/** The helper's word on the lesson's window (screen.ts ScreenIdent): another document in it or in
 *  front of it starts a switch, a title changed in its digits alone is looked at (checkTitle), the
 *  lesson's own back again cancels a switch, and one waiting reads again at another title there,
 *  or reads where the student went on to in the lesson's app instead (docIdentity.ts
 *  identVerdict), or as secure input goes off or the lesson's window is back on the screen (closed
 *  meanwhile, the lesson ends); and another app's reading window may be followed
 *  (maybeFollowApp). Before the lesson's page is ready, nothing is acted on: it is judged once the
 *  page's lesson is up (identLate). The front window it says is kept as the baseline of the next
 *  (Lesson.top). */
function onIdent(ident: ScreenIdent): void {
  lastIdent = ident;
  const current = lesson;
  if (!current || ident.window !== current.window) return;
  if (!pageReady) {
    identLate = current.run;
    return;
  }
  // (its window moved: the lesson moves with it first, so a sheet is judged against where the
  // window is now; and over another display, the run starts afresh there: once secure input is
  // off, for one that waited on it, rehome)
  followFrame(current, ident);
  if (!ident.secure && homing?.lesson === current && !homing.timer) rehome(homing);
  const before = current.top;
  // (a popup or a sheet in front moves no baseline: a window it hid coming back is no new one)
  if (ident.top !== null && (ident.top === current.window || anotherWindow(current, ident))) current.top = ident.top;
  const verdict = identVerdict(identLessonOf(current, before, current.switching), ident);
  if (verdict?.act === "cancel") cancelSwitch(current, "back", "back to its own document");
  else if (verdict?.act === "switch") beginSwitch(current, verdict.why, { window: verdict.target, pid: current.pid, app: current.app });
  else if (verdict?.act === "check") checkTitle(current, ident.title);
  else if (verdict?.act === "reread") readAgain(current, "another title there");
  else if (verdict?.act === "retarget") retargetSwitch(current, verdict.why, verdict.target);
  if (current.switching?.waitingFor === "secure" && !ident.secure) readAgain(current, "secure input is off");
  if (current.switching?.waitingFor === "screen") {
    if (ident.onScreen) readAgain(current, "its window is back on the screen");
    // (no title and off the screen: no longer listed, closed, and no other of its windows to go to)
    else if (!ident.title) {
      console.log(`[screen-teach] run ${current.run}: its window was closed: the lesson ends`);
      closeScreenTeach();
      return;
    }
  }
  maybeFollowApp();
}

/** What docIdentity.ts identVerdict is to know of the lesson: `top`, its app's front window said
 *  before, and the switch going on. */
const identLessonOf = (current: Lesson, top: number | undefined, switching: IdentLesson["switching"]): IdentLesson => ({
  window: current.window,
  app: current.app,
  title: current.title,
  titles: current.titles,
  frame: current.frame,
  top,
  switching,
});

/** Another document of the lesson's app that the helper last said the student has gone on to,
 *  from the one the switch `mine` reads (identVerdict's "retarget", as for a switch that waits),
 *  or null. */
function goneOnTo(current: Lesson, mine: Switching): { why: "title" | "window"; target: number } | null {
  if (lastIdent?.window !== current.window) return null;
  const verdict = identVerdict(identLessonOf(current, current.top, { why: mine.why, target: mine.target, waiting: "" }), lastIdent);
  return verdict?.act === "retarget" ? verdict : null;
}

/** The lesson's window settled into a new look (screen.ts "changed": a page or a slide the student
 *  turned by a key or a click, a scroll bar dragged), observed for every lesson (openScreenTeach),
 *  the companion on or off: its page follows it (screen-teach:changed). Not while another document
 *  seen there is read: that new look is the next run's. A switch waiting for words in this window,
 *  or in the other window it waits on (observed meanwhile: waitSwitch), a page that was still
 *  coming or a slide stepped on by a key, reads it again. */
function onLessonChanged(changed: ScreenChanged): void {
  const current = lesson;
  const w = live();
  if (!current || !w || !pageReady) return;
  if (current.switching) {
    if (current.switching.waitingFor === "words" && changed.window === current.switching.target) readAgain(current, "a new look");
    return;
  }
  if (changed.window !== current.window) return;
  w.webContents.send("screen-teach:changed", { run: current.run, window: changed.window });
}

/** The lesson's own ⌃⌥ keys (SHORTCUTS, the talk key) pressed this long ago or less: the key the
 *  helper says went down is one of theirs, no move of the page being read. */
const SHORTCUT_KEYED_MS = 600;

/** A key went down in the lesson's app, in front (screen.ts "keyed": the first of a run, then one
 *  at most every KEY_RUN_S while keys keep coming; never which key, never one of the lesson's own
 *  turn). The page it may have turned or scrolled is said once still (onLessonChanged); the page
 *  hears of the key at once (screen-teach:keyed), so its ink stops claiming words that may have
 *  moved (the founder, 2026-10-28: the tutor over another app should be "super responsive" and
 *  "very accurate in the way it points at things"). Not while aside or while another document
 *  seen there is read, nor for the lesson's own keys, nor for keys typed into the lesson's own
 *  window or its board (a question to the tutor: the app being read stays in front, a panel's
 *  way, and the helper cannot tell where a key went), nor the one that gave the keys back. */
function onLessonKeyed(keyed: ScreenKeyed): void {
  const current = lesson;
  const w = live();
  if (!current || !w || !pageReady || aside || current.switching || keyed.window !== current.window) return;
  if (Date.now() - lastShortcutAt < SHORTCUT_KEYED_MS) return;
  if (screenTeachFocused() || Date.now() - keysMovedAt < KEYS_MOVED_MS) return;
  w.webContents.send("screen-teach:keyed", { run: current.run });
}

/**
 * The lesson's window retitled in its digits alone ("Lecture 3.pdf" to "Lecture 4.pdf", or a page
 * that numbers itself as it goes): another document or the same one is told by its look. A quick
 * read (fast), outside the lesson's queue, with nothing stopped, the board left up and the page
 * told nothing; a look unlike the lesson's (docIdentity.ts sameDocument against its last read and
 * its latest look, a page still blank included) is another document, which starts a switch
 * ("title") as a title in other letters does, and the same look keeps the lesson, which takes the
 * title as its own (keepTitle). The lesson is taken as it was when the title changed: a read of
 * its own that comes in meanwhile (a turn, the page's reread) may hold the other document already,
 * its title with it. But for a turn of its own going on (Lesson.moving): a title that numbers the
 * pages changes with it, so the look is taken once that turn has read the window, and judged
 * against that read (a tab changed in its digits alone during the turn passes for its page then).
 * Once per title; never while secure input is on (the ident that says it is off asks again).
 * Logged by counts, never the title.
 */
function checkTitle(current: Lesson, title: string): void {
  if (current.checking === title || lastIdent?.secure || !pageHearsSwitching) return;
  current.checking = title;
  const asked = Date.now();
  const turning = current.moving;
  const then = { title: current.title, looks: [{ frame: current.frame, lines: current.lines, bundle: current.bundle }, current.look] };
  void (turning ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => readWindow(current.window, { fast: true }))
    .then(
      (read) => {
        if (current.checking === title) current.checking = null;
        if (lesson !== current || current.switching || current.switchedAt >= asked) return;
        const was = turning ? { title: current.title, looks: [current, current.look] } : then;
        if (titleChange(was.title, read.title, current.app) === "none") return;
        const seen = sameDocument(was.looks, read);
        const said = `${Math.round(seen.share * 100)}% of its ${seen.rows} rows the same`;
        if (seen.same) {
          console.log(`[screen-teach] run ${current.run}: the title's numbers changed, ${said}: the same document`);
          if (current.title === was.title) {
            current.title = read.title;
            current.doc = docKeyOf(read);
          }
          keepTitle(current, was.title);
          return;
        }
        console.log(`[screen-teach] run ${current.run}: the title's numbers changed, ${said}: another document`);
        beginSwitch(current, "title", { window: current.window, pid: current.pid, app: current.app });
      },
      (e: unknown) => {
        if (current.checking === title) current.checking = null;
        console.warn(`[screen-teach] run ${current.run}: a look at the window's new title failed: ${e instanceof ScreenReadError ? e.code : (e as Error).message}`);
      },
    );
}

/** The lesson's document showed `was` before its title now, the same look under both: `was` is
 *  kept among its own titles (Lesson.titles), so the title going back to it is no switch. */
function keepTitle(current: Lesson, was: string): void {
  if (titleChange(was, current.title, current.app) === "none" || current.titles.includes(was)) return;
  current.titles = [...current.titles, was].slice(-OWN_TITLES);
}

/**
 * Another document is on screen where `current` teaches (`why`), in the window `to`: once per
 * switch. The wait for the student's own turn is given up, the page hears it at once
 * (screen-teach:switching {run, on: true, why}: the voice, the marks, the open mic stop, and it
 * remembers whether the lesson was playing), the board goes (syncBoard), and the other document is
 * read (switchRead). Not for a page that has not said it hears of it (pageHearsSwitching): it
 * would teach on over the other document, and play the other document's run at once whatever it
 * shows. Never its title in the log: the app, why, and counts.
 */
function beginSwitch(current: Lesson, why: SwitchWhy, to: { window: number; pid: number; app: string }): void {
  const w = live();
  if (current.switching || lesson !== current || !w || !pageReady) return;
  if (!pageHearsSwitching) {
    console.log(`[screen-teach] run ${current.run}: another document in ${to.app} (${why}), but the lesson page does not hear of one: rebuild the renderer`);
    return;
  }
  const mine: Switching = { at: Date.now(), why, target: to.window, pid: to.pid, app: to.app };
  current.switching = mine;
  current.switchedAt = mine.at;
  current.waiting?.abort();
  clearAppFollow();
  console.log(`[screen-teach] run ${current.run}: another document in ${to.app} (${why}), reading it`);
  w.webContents.send("screen-teach:switching", { run: current.run, on: true, why });
  syncBoard();
  readSwitch(current, mine, mine.at);
}

/** Read the other document of `mine` (switchRead), its wait for words counted from `since`; a read
 *  that throws ends the switch, and the lesson goes on, as after a flick. */
function readSwitch(current: Lesson, mine: Switching, since: number): void {
  void switchRead(current, mine, since).catch((e: unknown) => {
    console.warn(`[screen-teach] run ${current.run}: reading the other document failed: ${(e as Error).message}`);
    cancelSwitch(current, "failed", "it could not be read");
  });
}

/** The switch `mine` waits, with nothing started (`what`; `title`: the other window's then, `said`
 *  to the log, never a title): the lesson stays stopped and its board away, as they are for the
 *  read, and the page hears what it waits for (screen-teach:switching {run, on: true, why: "wait
 *  words", "wait student", "wait secure" or "wait screen"}; a page that knows only one "on" per
 *  switch takes it for the one it has). The other document is read again (readAgain) as what it
 *  waits for comes: words of the page's own (another title there: onIdent; a new look of the
 *  window waited on, which is watched for one meanwhile: onLessonChanged, observeSwitch; a scroll
 *  of it: onScroll), the student back in its app (onFront), secure input off, the lesson's own
 *  window back on the screen (onIdent). The student gone on to another document of the lesson's
 *  app, or staying in another app on a reading window, takes it there (retargetSwitch,
 *  maybeFollowApp): what the helper said last is judged again now, since it says nothing again
 *  until something changes. A flick back to the lesson's own document still ends it as one
 *  (cancelSwitch). */
function waitSwitch(current: Lesson, mine: Switching, what: "words" | "student" | "secure" | "screen", title: string, said: string): void {
  if (lesson !== current || current.switching !== mine) return;
  mine.waiting = title;
  mine.waitingFor = what;
  console.log(`[screen-teach] run ${current.run}: ${said}: the lesson waits`);
  live()?.webContents.send("screen-teach:switching", { run: current.run, on: true, why: `wait ${what}` });
  observeSwitch(current);
  if (lastIdent?.window === current.window) onIdent(lastIdent);
  else maybeFollowApp();
}

/** The switch that waits (waitSwitch) reads the other document again (`said`: why, to the log);
 *  the page hears it is read (screen-teach:switching {run, on: true, why: "reading"}). */
function readAgain(current: Lesson, said: string): void {
  const mine = current.switching;
  if (lesson !== current || !mine || mine.waiting === undefined) return;
  mine.waiting = undefined;
  mine.waitingFor = undefined;
  console.log(`[screen-teach] run ${current.run}: ${said}: reading the other document again`);
  live()?.webContents.send("screen-teach:switching", { run: current.run, on: true, why: "reading" });
  readSwitch(current, mine, Date.now());
}

/** The switch that waits goes where the student has gone on to in the lesson's app (docIdentity.ts
 *  identVerdict "retarget": another document's window in front, or the lesson's own window showing
 *  another tab), and reads it there (readAgain). */
function retargetSwitch(current: Lesson, why: "title" | "window", target: number): void {
  const mine = current.switching;
  if (lesson !== current || !mine || mine.waiting === undefined) return;
  mine.why = why;
  mine.target = target;
  mine.pid = current.pid;
  mine.app = current.app;
  readAgain(current, `another document in ${current.app} in front (${why})`);
}

/** With the companion off the helper watches the lesson's own window for a new look
 *  (openScreenTeach); a switch waiting for words in another window has it watch that one too, so
 *  a page drawn late there, or a slide stepped on by a key, is read (onLessonChanged). With the
 *  companion on it watches the one under the cursor itself (companion.ts refreshObserve). */
function observeSwitch(current: Lesson): void {
  if (lesson !== current) return;
  const s = current.switching;
  const other = !companion?.on && s?.waitingFor === "words" && s.target !== current.window ? s.target : null;
  if (other === switchObserved) return;
  switchObserved = other;
  if (!companion?.on) observeWindows(other === null ? [current.window] : [current.window, other]);
}

/** The switch is over without a new run (`code` to the page, `said` to the log): the lesson goes
 *  on where it was (the page plays it on if it was playing), and its board comes back. */
function cancelSwitch(current: Lesson, code: "back" | "same" | "failed", said: string): void {
  if (!current.switching || lesson !== current) return;
  current.switching = null;
  console.log(`[screen-teach] run ${current.run}: ${said}: the lesson goes on`);
  live()?.webContents.send("screen-teach:switching", { run: current.run, on: false, why: code });
  observeSwitch(current);
  syncBoard();
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the other document of a switch (`mine`) in its window, once it is still: the helper's
 * wait for two thumbnails in a row that agree (a wait, not a turn: the watch for a new look is not
 * kept quiet by it, so a slide the student changes next is seen at once), SWITCH_SETTLE_MS at
 * most; then an accurate read, again SWITCH_RETRIES times SWITCH_RETRY_MS apart while it has fewer
 * than SWITCH_MIN_ROWS rows of the page's own, and every SWITCH_EMPTY_RETRY_MS while it has none
 * (a browser's bars are no page: its tab strip and address row are in every read of it), until
 * SWITCH_EMPTY_GIVE_UP_MS after `since`. Outside the lesson's queue: the wait for the student's
 * turn there was given up, and a turn going on is stale by now. Dropped as soon as the switch is
 * (a flick, a new run, the lesson's end). Nothing is read while secure input is on (waitSwitch).
 * The lesson's own window with the same look again (docIdentity.ts sameDocument against its last
 * read and its latest look) is the same document: the lesson takes the read and goes on
 * (cancelSwitch). A browser's page with too little of its own to teach, or the student gone on to
 * another app, waits (waitSwitch). Else a new run starts on it, quietly, at its first words
 * (openScreenTeach, switched), unless the switch is over or the student has gone by the time it
 * would start.
 */
async function switchRead(current: Lesson, mine: Switching, since: number): Promise<void> {
  const to = { window: mine.target, pid: mine.pid };
  const ours = (): boolean => lesson === current && current.switching === mine;
  // (the student gone on to another app than the one read; or to Tutornote's own windows, but for
  // the lesson's window and its board: their notes there, where the lesson has stepped aside)
  const away = (): boolean => frontPid !== null && frontPid !== to.pid && (frontPid !== process.pid || aside);
  const f = current.frame;
  let still: ScreenTurned | null = null;
  try {
    still = await turnWindow({
      window: to.window,
      pid: to.pid,
      how: "manual",
      at: { x: f.x + f.w / 2, y: f.y + f.h / 2 },
      timeoutMs: SWITCH_SETTLE_MS,
      still: true,
      // (a helper older than `still` waits for a change instead: from the look of the window's last
      // read, which it has moved from by now, it answers as soon as it is still)
      unlessMoved: true,
    });
  } catch {
    // (a window that went is said by the read below)
  }
  if (!ours()) return;
  const readOnce = async (): Promise<ScreenRead | null> => {
    // (a password field has the keys, somewhere: what shows is not read until it is off)
    if (lastIdent?.secure) {
      waitSwitch(current, mine, "secure", "", "secure input is on");
      return null;
    }
    try {
      return await readWindow(to.window);
    } catch (e) {
      if (!ours()) return null;
      const code = e instanceof ScreenReadError ? e.code : (e as Error).message;
      // Another window that went (closed as soon as it came): back to the lesson's document. The
      // lesson's own gone from the screen for now (another Space, the Dock), showing another
      // document as it went: the lesson stays stopped, and reads it as the helper says it is back
      // (or goes where the student went on to in its app; closed, the lesson ends: onIdent). From
      // a helper that says nothing of the window, back to the lesson's document, as nothing would
      // say that. Its own window unreadable otherwise: the lesson cannot go on there with what it
      // last read, and ends.
      const offScreen = code === "window_gone" || code === "no_window";
      if (to.window !== current.window || (offScreen && lastIdent?.window !== current.window)) {
        cancelSwitch(current, "failed", `the other ${to.window === current.window ? "document" : "window"} could not be read (${code})`);
      } else if (offScreen) {
        waitSwitch(current, mine, "screen", "", `its window is off the screen (${code})`);
      } else {
        console.warn(`[screen-teach] run ${current.run}: the other document could not be read (${code}): the lesson ends`);
        closeScreenTeach();
      }
      return null;
    }
  };
  let read = await readOnce();
  if (!read || !ours()) return;
  let tries = 0;
  while (bodyRows(read).length < SWITCH_MIN_ROWS && tries < SWITCH_RETRIES) {
    tries++;
    await pause(SWITCH_RETRY_MS);
    if (!ours()) return;
    read = await readOnce();
    if (!read || !ours()) return;
  }
  // (a page still coming: none of its own words yet, whatever bars are around it)
  while (!bodyRows(read).length && Date.now() - since < SWITCH_EMPTY_GIVE_UP_MS) {
    await pause(SWITCH_EMPTY_RETRY_MS);
    if (!ours()) return;
    read = await readOnce();
    if (!read || !ours()) return;
  }
  const rows = bodyRows(read);
  const words = rows.reduce((n, row) => n + row.key.split(" ").length, 0);
  const seen = to.window === current.window ? sameDocument([current, current.look], read) : null;
  console.log(
    `[screen-teach] run ${current.run}: the other document read ${Date.now() - mine.at} ms after it was seen: ` +
      `${read.lines.length} lines (${rows.length} rows, ${words} words of the page's own)${tries ? `, read ${tries + 1} times` : ""}` +
      (still ? `, still after ${still.settleMs} ms${still.still === false ? " (not still in time)" : ""}` : "") +
      `, text ${read.ocrMs} ms` +
      (seen ? `, ${Math.round(seen.share * 100)}% of its rows the same as before` : ""),
  );
  // (the student gone on meanwhile to another document of the lesson's app: that is read instead)
  const gone = goneOnTo(current, mine);
  if (gone) {
    mine.why = gone.why;
    mine.target = gone.target;
    mine.pid = current.pid;
    mine.app = current.app;
    console.log(`[screen-teach] run ${current.run}: another document in ${current.app} in front (${gone.why}): reading that one`);
    readSwitch(current, mine, Date.now());
    return;
  }
  if (!read.lines.length) {
    console.log(`[screen-teach] run ${current.run}: no words in the other document: the lesson ends`);
    closeScreenTeach();
    return;
  }
  if (seen?.same) {
    // (a title that changed by itself: the same document, its title the window's now, and the
    // one it had its own still)
    const was = current.title;
    noteRead(current, read);
    keepTitle(current, was);
    appEvents.emit("screen-teach-read", read);
    cancelSwitch(current, "same", "the same document after all");
    return;
  }
  // A browser's page with nothing of its own, or too little to teach (a new tab, a search page),
  // but for a document's (a deck's title slide may say five words): the lesson waits for
  // something to read.
  const documentPage = readingWindow(read.bundle, read.title) || DOCUMENT_TITLE.test(read.title);
  if (isBrowserApp(read.bundle) && (!rows.length || (words < SWITCH_MIN_WORDS && !documentPage))) {
    waitSwitch(current, mine, "words", read.title, `little to read in the other document (${rows.length} rows, ${words} words)`);
    return;
  }
  if (away()) {
    waitSwitch(current, mine, "student", read.title, "the student went on to another app");
    return;
  }
  // (openScreenTeach takes the next run at once, before anything it waits for: its page's start is
  // logged against when this switch was seen)
  switchedRun = { run: runs + 1, at: mine.at };
  await openScreenTeach(read, firstBodyPoint(read), { companion: companion?.on, quiet: true, switched: true, still: () => ours() && !away() });
  // (not started: the student went on to another app as it was about to)
  if (ours() && away()) waitSwitch(current, mine, "student", read.title, "the student went on to another app");
}

/*
  Companion mode (companion.ts drives it; the window and the lesson stay this module's).
*/

/*
  The lesson's window stops taking the keys, and goes on taking clicks without coming to the front.
  On a Mac that is setFocusable(false). On Windows that alone costs every click after the first
  time: once a window has been focusable, setFocusable(false) makes Chromium answer each press on it
  "do not activate, and eat the message" (HWNDMessageHandler::OnMouseActivate), so the page hears a
  mouse-up with no mouse-down, and no click at all. Off and on again, or after a question typed
  into it, the tutor's card, dock and buttons did nothing (the founder, 2026-10-31: "I am not able
  to explain or ask a question"), while taps on the app below went on opening cards. So on Windows
  the window stays activatable, which keeps its presses, and WS_EX_NOACTIVATE, set by the helper
  (Electron couples the two), keeps a click from bringing it forward: as a window made afresh is.
*/
const NO_ACTIVATE_MS = 50;

function stopTakingKeys(w: BrowserWindow): void {
  w.setFocusable(false);
  if (process.platform !== "win32") return;
  w.setFocusable(true);
  // (a focusable window is back in the taskbar on Windows: this one stays out)
  w.setSkipTaskbar(true);
  // (a moment on: the helper reads the window's style and writes it back, and the callers go on
  // to change that style themselves, its always-on-top among them, which a write begun before
  // theirs would undo)
  const id = windowIdOf(w.getMediaSourceId());
  setTimeout(() => {
    if (!w.isDestroyed()) noActivateWindow(id);
  }, NO_ACTIVATE_MS);
}

/** The companion's rectangle message for the window as it is now. */
const overlayRect = (w: BrowserWindow): Rect => {
  const b = w.getBounds();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
};

/** Tell the page the companion's state, when it listens: once it has asked for it (companion-state)
 *  it has its listener, and the first-time tip and the hop from the blob are spent. */
function sendCompanion(): void {
  const w = live();
  if (!w || !companion || !(pageReady || pageAsked)) return;
  w.webContents.send("screen-teach:companion", companion.message);
  if (pageAsked) companion.message = { on: companion.message.on, overlay: companion.message.overlay, first: false };
}

/**
 * The companion is on: the window over `work` (the work area of the cursor's display), up for as
 * long as the tutor is, never taking the keys. `from`: the blob's centre in screen points, where
 * the tutor hops out from. `first`: the first time ever (the page shows its tip).
 */
export function showCompanionOverlay(work: Rectangle, from: Point, first: boolean): void {
  const w = ensureWindow(work);
  if (w.isFocusable()) {
    if (process.platform === "win32" && w.isVisible()) {
      // (Windows gives the keys of a window made unfocusable to the first window shown below it,
      // the board during a lesson: out of the always-on-top band for that moment, that is the window
      // already in front; then back above the board, and the blob above it)
      w.setAlwaysOnTop(false);
      stopTakingKeys(w);
      overlayAboveBoard();
    } else {
      stopTakingKeys(w);
    }
  }
  const overlay = overlayRect(w);
  companion = { on: true, work, message: { on: true, overlay, from: { x: from.x - overlay.x, y: from.y - overlay.y }, first } };
  sendCompanion();
  // (a page still loading is shown as it says it is ready)
  if (pageReady && !w.isVisible()) w.showInactive();
  // A lesson from a pick that had stepped aside (the window hidden, the student in another app)
  // shows again with the tutor: its marks and dock stay aside in the page until they come back.
  if (pageReady && lesson && aside) {
    w.webContents.send("screen-teach:aside", true);
    w.webContents.send("screen-teach:present", false);
  }
  // The talk chord and ⌃⌥M: the companion dock's mic, with no lesson on too.
  registerTalkKey();
}

/** The cursor went to another display (no lesson on): the window follows it. Every point the page
 *  holds from before is off by the move; companion.ts sends its glances again. */
export function moveCompanionOverlay(work: Rectangle): void {
  if (!companion?.on) return;
  const w = ensureWindow(work);
  companion.work = work;
  companion.message = { on: true, overlay: overlayRect(w), first: false };
  sendCompanion();
}

/** The companion is off (its tutor has flown home): the window hides, unless a lesson is on, and
 *  takes keys again for a lesson started without it. */
export function hideCompanionOverlay(): void {
  companion = null;
  setCardBox(null);
  // (a lesson on screen keeps ⌃⌥M and the chord; they go with the lesson then)
  if (!lesson) unregisterTalkKey();
  const w = live();
  if (!w) return;
  w.setFocusable(true);
  // (Windows puts a focusable window back in the taskbar and Alt+Tab: this one stays out)
  if (process.platform === "win32") w.setSkipTaskbar(true);
  if (lesson) return;
  interactive = false;
  applyMouse();
  w.hide();
  syncBoard();
}

/** The work area the window covers while the tutor is on (the cursor's display, or the lesson's),
 *  or null with the tutor off. */
export const companionArea = (): Rectangle | null => (companion?.on ? companion.work : null);

/** The lesson's board window, if there is one and the board is in it (the companion counts it as
 *  Tutornote's own). */
export const boardWindow = (): BaseWindow | null => {
  const b = liveBoard();
  return b && b.place === "float" ? b.host : null;
};

/** The lesson's see-through window, if there is one (never counted as Tutornote's own: it covers
 *  the whole display, and every click goes through it). */
export const overlayWindow = (): BrowserWindow | null => live();

/** A point in screen points as the page's own (its window's top left off), or null without one. */
export function localPoint(p: Point): Point | null {
  const w = live();
  if (!w) return null;
  const b = w.getBounds();
  return { x: p.x - b.x, y: p.y - b.y };
}

/** A point of the page's own in screen points, or null without the window. */
export function screenPoint(p: Point): Point | null {
  const w = live();
  if (!w) return null;
  const b = w.getBounds();
  return { x: p.x + b.x, y: p.y + b.y };
}

/** A read in the page's own points, or null without the window. */
export function localRead(read: ScreenRead): ScreenRead | null {
  const w = live();
  return w ? toLocal(read, w.getBounds()) : null;
}

/** Send the page something (companion.ts): only once it has loaded, else it is dropped (the page
 *  asks for what it needs as it starts: companion-state). */
export function sendToPage(channel: string, payload: unknown): void {
  const w = live();
  if (w && pageReady) w.webContents.send(channel, payload);
}

/** The lesson on screen: its run, the window it reads and that window's app, or null. */
export function screenTeachLesson(): { run: number; window: number; app: string } | null {
  return lesson ? { run: lesson.run, window: lesson.window, app: lesson.app } : null;
}

/** The call came from the lesson's own page. */
export const fromScreenTeachPage = (event: { sender: WebContents }): boolean => fromLesson(event);

/** The page has the clicks now (the pointer is over its card, its dock, its board, as it says, or
 *  over the card as this side reads the cursor: cardBox): a press then is the page's, not one on
 *  the app below. */
export const overlayInteractive = (): boolean => interactive || overCard;

/** Where a restart from a tap on the lesson's window finds the companion's careful read of it
 *  (companion.ts, at install): `source(window, since)`, a read begun at `since` or later that still
 *  shows the window as it is, or null. */
export function useCarefulReads(source: (window: number, since: number) => Promise<ScreenRead> | null): void {
  carefulRead = source;
}

/** The tutor went off (companion.ts turnOff): its card's box and the kept Accessibility answer go. */
export function companionWentOff(): void {
  setCardBox(null);
  axAnswer = null;
}

/** The last press (a moment ago) was on the page's own controls: so is the tap it makes. */
export const pressWasThePage = (): boolean => Boolean(companion?.on && lastPress?.page && Date.now() - lastPress.at < PRESS_TAP_MS);

/** The helper heard the mouse go down (screen.ts "press"). With the companion off it says one only
 *  on the lesson's window, and the page hears it here (screen-teach:press, as companion.ts tells
 *  it while the tutor is on): a click in Kindle's or Books' margin turns the page on its release,
 *  and what the lesson wrote on the page before hides at once, not once the new look is still and
 *  said (the founder, 2026-10-28: "super responsive"). Not on the page's own controls, nor while
 *  aside or hidden. */
function onPress(press: ScreenPress): void {
  lastPress = { at: Date.now(), page: overlayInteractive() };
  const current = lesson;
  const w = live();
  if (companion?.on || !current || !w || !pageReady || aside || press.window !== current.window || overlayInteractive() || !w.isVisible()) return;
  const b = w.getBounds();
  w.webContents.send("screen-teach:press", { window: press.window, x: press.x - b.x, y: press.y - b.y });
}

export function installScreenTeach(): void {
  prefs = loadBoardPrefs();
  watchEvents.on("tap", onTap);
  watchEvents.on("scroll", onScroll);
  watchEvents.on("front", onFront);
  // Which document the lesson's window shows (another one: beginSwitch), and its new looks, which
  // its page follows (with the companion on or off).
  watchEvents.on("ident", onIdent);
  watchEvents.on("changed", onLessonChanged);
  // (and a key pressed in its app, before the new look it may bring is still)
  watchEvents.on("keyed", onLessonKeyed);
  // The talk chord, while the talk key is on (registerTalkKey), and whether it can be used.
  watchEvents.on("chord", onChord);
  watchEvents.on("chordState", onChordState);
  app.on("browser-window-focus", (_event, focused) => onOwnFocus(focused));
  // (before companion.ts's own listener: it asks pressWasThePage of the same press's tap)
  watchEvents.on("press", onPress);
  // (Windows: the cursor, from the helper, while the window is shown: FORWARD_MOVES)
  watchEvents.on("cursor", cursorToPage);
  // A display rearranged, its resolution changed, or unplugged: the lesson's window may be over
  // the wrong part of the screen now (homeAfterDisplays). A work area alone changing (the Dock, the
  // menu bar) moves nothing.
  screen.on("display-metrics-changed", (_event, _display, changed: string[]) => {
    if (changed.includes("bounds") || changed.includes("rotation")) homeAfterDisplays();
  });
  screen.on("display-removed", () => homeAfterDisplays());

  /*
    The Board tab (windows.ts tells of it through appEvents; it imports nothing from here).
  */
  // The student left the main window: judged a moment later (onMainLeft).
  app.on("browser-window-blur", (_event, blurred) => {
    if (blurred !== getMainWindow()) return;
    clearTimeout(mainBlurTimer);
    mainBlurTimer = setTimeout(onMainLeft, MAIN_BLUR_SETTLE_MS);
  });
  // Its ×, its middle click, ⌘W on it.
  appEvents.on("board-tab-close", () => {
    if (liveBoard()) closeBoardHere();
  });
  // The away tab chosen (the board is in its own window): Open in Tutornote.
  appEvents.on("board-tab-open", () => openInTutornote());
  // The Board tab shown, or another tab instead, by the student: where they are now is judged as
  // for a focus of the window. A tab that left because the board was closed, popped out or folded
  // is not the student going elsewhere (the lesson goes on), so that is not judged.
  appEvents.on("board-tab-selection", (e: { active: boolean; undocked: boolean }) => {
    if (e.undocked || !lesson || !getMainWindow()?.isFocused()) return sendPlace();
    clearTimeout(mainFocusTimer);
    mainFocusTimer = setTimeout(judgeMain, MAIN_FOCUS_SETTLE_MS);
  });
  // The main window minimized, hidden or closing (not for ⌘Q): the board moves to its own window.
  appEvents.on("board-host-leaving", () => {
    const b = liveBoard();
    if (b?.place === "tab" && !quitting) {
      toFloat(b);
      syncBoard();
    }
  });
  // The main window made again (closed, then the Dock): its bar starts empty, and a board floating
  // for this lesson has its away tab there again.
  appEvents.on("main-window-created", () => {
    const b = liveBoard();
    if (inBar && b?.place === "float") showBoardTab({ title: boardTitleNow, surface: boardColor, away: true });
  });
  // The main window moved or resized: over what is read now, or not.
  appEvents.on("main-window-bounds", () => {
    if (getMainWindow()?.isFocused() && boardTabActive()) judgeMain();
    else sendPlace();
  });
  // Signing out: the lesson ends, the tutor turns off, and the lesson's page goes with its board.
  appEvents.on("main-signed-out", () => {
    if (!live()) return;
    closeScreenTeach();
    dropWindow();
  });
  // Where the board is, now: asking it is how the page says it knows the board's tab.
  ipcMain.handle("screen-teach:board-place-now", (event): BoardPlace | null => {
    if (!fromLesson(event)) throw new Error("not allowed");
    pageKnowsPlace = true;
    lastPlaceSent = "";
    return placeNow();
  });
  // The page listens for another document where it teaches (its bridge's onSwitching): switches
  // are begun for it from now on (pageHearsSwitching).
  ipcMain.on("screen-teach:hears-switching", (event) => {
    if (fromLesson(event)) pageHearsSwitching = true;
  });
  // The board's own Pop out or Open in Tutornote (the student's click on it).
  ipcMain.on("screen-teach:board-move", (event, value: unknown) => {
    const to = boardMoveOf(value);
    if (!fromLesson(event) || !to || !lesson || !liveBoard()) return;
    if (to === "tab") openInTutornote();
    else popOut();
  });
  ipcMain.on("screen-teach:back-to-app", (event) => {
    if (fromLesson(event)) backToApp();
  });

  // A tap the page found no paragraph under (words it has not read: the student scrolled to
  // them): the lesson starts afresh from there.
  ipcMain.on("screen-teach:pick-at", (event, value: unknown) => {
    const current = lesson;
    const w = live();
    const p = (value ?? {}) as Record<string, unknown>;
    if (!fromLesson(event) || !current || !w || p.run !== current.run || !finite(p.x) || !finite(p.y)) return;
    const b = w.getBounds();
    restartAt(current, { x: b.x + p.x, y: b.y + p.y }, "tap on words not read yet");
  });

  ipcMain.handle("screen-teach:ready", (event) => {
    if (!fromLesson(event)) throw new Error("not allowed");
    pageReady = true;
    clearTimeout(readyTimer);
    const w = live();
    // (a page loaded afresh while the student is in another app: away, not with the lesson)
    if (lesson && aside) w?.webContents.send("screen-teach:present", false);
    // (and whether the talk chord can be used, for a page that names its talk key)
    w?.webContents.send("screen-teach:chord-state", { on: chordUsable });
    if ((pending || companion?.on) && w && !w.isVisible()) w.showInactive();
    syncBoard();
    // (and the companion's state again, for a page that listens before it asks)
    sendCompanion();
    // A page that never asks for the companion's state is older than the companion: the tutor
    // shows nothing over other apps then, and only a rebuilt renderer will.
    if (companion?.on) {
      const page = w;
      setTimeout(() => {
        if (companion?.on && !pageAsked && live() === page && pageReady) {
          console.warn("[companion] the lesson page does not know the companion: rebuild the renderer (scripts/build-renderer.sh)");
        }
      }, 4_000).unref();
    }
    return pending;
  });

  // Companion mode: what the page is to show of the companion, as it starts (a reload included),
  // or null when the companion is off. Asked for next to ready (a page older than the companion
  // never asks).
  ipcMain.handle("screen-teach:companion-state", (event): CompanionMessage | null => {
    if (!fromLesson(event)) throw new Error("not allowed");
    pageAsked = true;
    const message = companion?.message ?? null;
    if (companion) companion.message = { on: companion.message.on, overlay: companion.message.overlay, first: false };
    // (companion.ts tells this page again what the cursor is over)
    appEvents.emit("screen-teach-companion-asked");
    return message;
  });

  // Companion mode: the page has a text field in use (a question typed to the tutor), and the window
  // takes the keys until it says otherwise; the rest of the time it never does, so the student's
  // arrow keys reach the app being read. A panel takes them without bringing Tutornote to the front
  // (Electron's focus skips that for one), so the app being read stays the one in front. Giving them
  // back takes more than setFocusable(false), which only keeps the window from taking them again
  // (Electron 44 knows no way to give them up): blur does, by ordering the window out and back in
  // behind the others at its level (the floating level, where it is alone but for explain.ts's
  // panel), and the keys go back to the app in front.
  ipcMain.on("screen-teach:want-keys", (event, on: unknown) => {
    const w = live();
    if (!fromLesson(event) || !w || typeof on !== "boolean" || !companion?.on) return;
    keysMovedAt = Date.now();
    if (process.platform === "win32") {
      // Windows hands the keys, as a window gives them up, to the first window shown below it: the
      // board or the blob, never the app being read. Out of the always-on-top band for that moment,
      // the window below is the app being read; the helper brings the lesson's window forward too.
      // A focusable window is back in the taskbar on Windows: this one stays out.
      if (on) {
        w.setFocusable(true);
        w.setSkipTaskbar(true);
        w.focus();
      } else if (w.isFocusable()) {
        // (only when the lesson's window has the keys: the board, if the student went on to it,
        // keeps them, and nothing is brought forward)
        const had = w.isFocused();
        const b = liveBoard();
        const boardKeys = Boolean(b && b.place === "float" && b.host.isFocused());
        if (!boardKeys) w.setAlwaysOnTop(false);
        stopTakingKeys(w);
        overlayAboveBoard();
        if (had && lesson) bringWindowForward(lesson.window);
      }
      return;
    }
    w.setFocusable(on);
    if (on) w.focus();
    else if (w.isFocused()) w.blur();
  });

  // What the page's board is doing (boardStateOf): up or not, zoomed or not, for which run, and
  // its colour. The board's window follows it (syncBoard), for the lesson on screen only.
  ipcMain.on("screen-teach:board", (event, value: unknown) => {
    const s = boardStateOf(value);
    if (!fromLesson(event) || !lesson || !s || s.run !== lesson.run) return;
    boardRun = s.run;
    boardWanted = s.show;
    // (the page has had its board down since the student closed it: its next show is a new one)
    if (!s.show && closeHold?.run === s.run) releaseHold();
    if (s.background && s.background !== boardColor && opaqueColor(s.background)) {
      boardColor = s.background;
      const b = liveBoard();
      b?.host.setBackgroundColor(boardColor);
      b?.view.setBackgroundColor(boardColor);
      // (the Board tab's fill, which runs into the board's head)
      setBoardTabInfo({ surface: boardColor });
    }
    // Something new went up on it (a page older than the count sends none).
    if (s.show && s.drawn !== undefined && (lastDrawn?.run !== s.run || lastDrawn.drawn !== s.drawn)) {
      lastDrawn = { run: s.run, drawn: s.drawn };
      freshDrawing = true;
    }
    // (in a tab, a zoom has no effect on any window: applyZoom)
    applyBoardFull(s.full);
    syncBoard();
  });

  ipcMain.handle("screen-teach:turn", (event, value: unknown): Promise<ScreenTurnResult> => {
    if (!fromLesson(event)) throw new Error("not allowed");
    const req = turnRequestOf(value);
    if (!req) return Promise.resolve({ ok: false, reason: "failed" });
    const current = lesson;
    if (!current || current.run !== req.run) return Promise.resolve({ ok: false, reason: "stale" });
    // The page asks for one move at a time, but never waits in line for the student: a wait for
    // their turn still going (or still to start) is for a move the lesson no longer wants.
    current.waiting?.abort();
    const waiting = req.how === "manual" ? new AbortController() : null;
    current.waiting = waiting;
    return queued(current, () => {
      const going: Promise<ScreenTurnResult> = turn(req, waiting).finally(() => {
        current.turnedAt = Date.now();
        if (current.moving === going) current.moving = null;
      });
      // (the lesson's own move, posted: a title that numbers the pages changes with it, checkTitle)
      if (req.how === "auto") current.moving = going;
      return going;
    }).finally(() => {
      if (current.waiting === waiting) current.waiting = null;
    });
  });

  // `opts.fast`: a quick check of where the words are now (after a scroll), not words to teach:
  // the board's place and the companion's glance keep the last accurate read.
  ipcMain.handle("screen-teach:reread", (event, run: unknown, opts: unknown): Promise<ScreenRead | null> => {
    if (!fromLesson(event)) throw new Error("not allowed");
    const current = lesson;
    if (!current || current.run !== run) return Promise.resolve(null);
    const fast = (typeof opts === "object" && opts !== null ? (opts as { fast?: unknown }).fast : false) === true;
    // (from the page's ask: its wait behind the lesson's other work counts, for the log)
    const called = Date.now();
    return queued(current, async () => {
      // (another document seen there since, or being read: no read of this run's)
      const asked = Date.now();
      if (current.switching) return null;
      try {
        // (where the window is now, dragged while it was read: readNow; its times and counts
        // logged from the helper's own answer, as for a turn)
        const answer = await readWindow(current.window, fast ? { fast: true } : undefined);
        console.log(rereadLine(current.run, answer, fast, Date.now() - called));
        const read = readNow(answer);
        if (current.switching || current.switchedAt >= asked) return null;
        // (its window gone over another display, or full screen or back: the run starts afresh
        // there, and the page gets nothing in the old overlay's points: rehomeSoon)
        const away = lesson === current ? awayFromHome(current, read.frame) : null;
        if (away) {
          rehomeSoon(current, away);
          return null;
        }
        if (!fast) noteRead(current, read);
        else if (lesson === current) {
          // (a quick one is the window's latest look all the same: another document is told by it.
          // Not one taken as another title came up, before the helper said so: that look is the
          // other document's, and would pass it for the lesson's own)
          if (["none", "weak"].includes(titleChange(current.title, read.title, current.app))) {
            current.look = { frame: read.frame, lines: read.lines, bundle: read.bundle };
          }
          // (and its window's size, whatever it shows: a careful read begun before a resize may
          // have set the old one after its last ident, and a drag is measured from it: followFrame)
          if (otherSize(read.frame, current.frame)) current.frame = { ...read.frame };
        }
        const w = live();
        if (lesson === current && w && !fast) appEvents.emit("screen-teach-read", read);
        return lesson === current && w ? toLocal(read, w.getBounds()) : null;
      } catch (e) {
        console.warn(`[screen-teach] read again failed: ${e instanceof ScreenReadError ? e.code : (e as Error).message}`);
        return null;
      }
    });
  });

  ipcMain.handle("screen-teach:allow-turning", async (event): Promise<boolean> => {
    if (!fromLesson(event)) throw new Error("not allowed");
    // (switched on in System Settings, or not: the next pick asks afresh)
    axAnswer = null;
    const allowed = await accessibilityAllowed(true);
    if (allowed && pending) pending.canTurn = true;
    return allowed;
  });

  ipcMain.on("screen-teach:started", (event) => {
    if (!fromLesson(event) || !lesson) return;
    appEvents.emit("screen-teach-started");
    // (a run started for another document: how long after it was seen the new lesson is up)
    if (switchedRun?.run === lesson.run) {
      console.log(`[screen-teach] run ${lesson.run} ready ${Date.now() - switchedRun.at} ms after the switch was seen`);
      switchedRun = null;
    }
    // (the helper spoke of the window before the page was ready, and says nothing again until
    // something changes: what it last said is judged now, against the read the run started on)
    if (identLate === lesson.run) {
      identLate = null;
      if (lastIdent?.window === lesson.window) onIdent(lastIdent);
    }
  });

  ipcMain.on("screen-teach:interactive", (event, on: unknown) => {
    if (!fromLesson(event) || typeof on !== "boolean" || on === interactive) return;
    interactive = on;
    applyMouse();
  });

  // The companion's card after each paint ({x, y, w, h}, the page's own points), or null once it
  // has gone: the window takes the clicks over it from now on (cardBox).
  ipcMain.on("screen-teach:card-box", (event, value: unknown) => {
    const w = live();
    if (!fromLesson(event) || !w) return;
    if (value === null) return setCardBox(null);
    const box = (value ?? {}) as Record<string, unknown>;
    if (!finite(box.x) || !finite(box.y) || !finite(box.w) || !finite(box.h) || box.w < 0 || box.h < 0) return;
    const b = w.getBounds();
    setCardBox({ x: box.x + b.x, y: box.y + b.y, w: box.w, h: box.h });
  });

  ipcMain.on("screen-teach:open-settings", (event, which: unknown) => {
    if (!fromLesson(event) || (which !== "screen" && which !== "accessibility")) return;
    void shell.openExternal(SETTINGS_URLS[which]);
  });

  // A link in the lesson (a sticky wall's) opens in the main window, as any route of the app.
  ipcMain.on("screen-teach:open-in-main", (event, where: unknown) => {
    if (!fromLesson(event) || typeof where !== "string" || where.length > 2048 || !where.startsWith("/")) return;
    let url: URL;
    try {
      url = new URL(where, APP_ORIGIN);
      if (originOf(url.href) !== APP_ORIGIN) return;
    } catch {
      return;
    }
    getMainWindow()?.show();
    navigateTo(`${url.pathname}${url.search}${url.hash}`);
  });

  // Only the lesson on screen: a close sent as the page heard "close" must not drop the
  // next pick's lesson while it opens.
  ipcMain.on("screen-teach:close", (event) => {
    if (fromLesson(event) && lesson) closeScreenTeach();
  });
}
