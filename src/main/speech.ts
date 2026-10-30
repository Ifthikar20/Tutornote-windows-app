import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { APP_ORIGIN } from "./config";
import { microphoneAllowed, microphoneAnswer } from "./microphone";
import { speechLine, speechOutputOf, speechStartOptions, type SpeechOutput } from "./speechLog";

/*
  Speech recognition on the Mac itself. Electron's Chromium has the Web Speech API but
  not Google's service behind it, so in the app the web app used to record clips and
  send them to the server's whisper: the first words took many seconds to show, and a
  busy server a minute. Now a page's SpeechRecognition (the preload's shim, src/preload/
  index.ts) comes here, and here it is Apple's Speech framework, in a helper process of
  ours (helpers/speech/main.swift, built by scripts/build-speech-helper.sh): on-device
  where the language's model is installed, so the words appear as they are said.

  One helper serves every page, started when the first recogniser starts (or a page warms
  or prepares, though not for a while after a helper went down by itself) and kept for
  the app's life (it closes the microphone itself a few seconds after the last session).
  Each recogniser is a session: the page's own number (`ref`, per page) maps to the
  helper's id. The helper's events go back to the page that owns the session; the
  helper dying hands every open session a "network" error, which the web app treats as
  a hiccup (a new recogniser, or the recorder).

  No helper (not macOS, not built, not in the bundle): nothing is installed, the preload
  gets no --anothernotes-speech flag, and the web app records for the server as before.

  A page about to listen can make the first words quicker: speech:prepare has the helper make
  the language's recogniser ahead (once both permissions are given; it never asks), and
  speech:warm keeps the microphone running for a few seconds (once it is allowed), so a start
  then finds it open, with the audio from just before in its ring. A start may carry a pre roll
  (the student's press, unix ms: the words said between it and the start are fed from that
  ring) and hints (the lesson's words, for Apple's recogniser to expect): speechStartOptions
  checks both before the helper gets them.

  The log has every step of a session with the wall clock to the millisecond (speechLog.ts:
  start, recogniser, live, first words, each phrase and what cut it, end), and the microphone
  going on and off and the input it uses. Never any word the student said: the events' text
  goes to the page only.

  Where the tutor's voice plays (speech:output): the helper watches the Mac's default output and
  says which device it is and whether the microphone can hear it (speakers) or not (headphones),
  as it starts and on every change. A page that asks (it listens only between the tutor's parts
  on speakers, so the tutor never hears itself) gets the latest at once, or null while none is
  known, and every change after (speech:output, sent to it) for as long as it is there. Only the
  device's name, its transport, its data source and that verdict go to the page.
*/

const HELPER = "tutornote-speech";

export function speechHelperPath(): string | null {
  if (process.platform !== "darwin") return null;
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, HELPER)]
    : [path.join(app.getAppPath(), "build", "helpers", HELPER)];
  return candidates.find((file) => existsSync(file)) ?? null;
}

export const nativeSpeechAvailable = (): boolean => speechHelperPath() !== null;

type Helper = ChildProcessByStdio<Writable, Readable, Readable>;

interface Session {
  id: number;
  ref: number;
  sender: WebContents;
}

interface HelperEvent {
  id?: unknown;
  ev?: unknown;
  text?: unknown;
  code?: unknown;
  onDevice?: unknown;
  lang?: unknown;
  /** When the helper sent it (unix ms). */
  t?: unknown;
  /** ready: the recogniser was made before; how long having it took. prepared: how long. */
  cached?: unknown;
  setupMs?: unknown;
  ms?: unknown;
  /** mic: on or off, and what started it. */
  on?: unknown;
  why?: unknown;
  /** route: the default input and the one used, with their transports; a change or a start. */
  input?: unknown;
  transport?: unknown;
  using?: unknown;
  usingTransport?: unknown;
  changed?: unknown;
  /** audiostart: the microphone was already on; ms of audio fed from before the start. */
  warm?: unknown;
  preroll?: unknown;
  /** phrase: what cut it, when, the end of the last voice heard (unix ms), how many words. */
  cut?: unknown;
  cutAt?: unknown;
  voiceEnd?: unknown;
  words?: unknown;
  /** output: the default output's name and data source, and whether it is speakers (with
   *  `transport` and `changed` above). */
  name?: unknown;
  source?: unknown;
  speakers?: unknown;
}

let helper: Helper | null = null;
let nextId = 1;
const sessions = new Map<number, Session>();

/** Where the voice plays, as the helper last said (kept across a helper going down: the device
 *  has not changed by that, and the next helper says it again as it starts), and the pages told
 *  of every change (speech:output), each until it is destroyed. */
type OutputRoute = Omit<SpeechOutput, "changed">;
let lastOutput: OutputRoute | null = null;
const outputPages = new Set<WebContents>();

/** When a helper last went down by itself (it crashed, refused to run, or could not be
 *  started; Date.now(), 0: never), and whether the app is quitting (a helper going then is no
 *  failure). The automatic calls (speech:warm every 2 s while talk mode is on, speech:prepare at
 *  a page's mount) start no helper for HELPER_RETRY_MS after such a failure: they use a running
 *  one only, so a helper that dies as it opens the microphone is not started again every 2 s
 *  with nobody asking. A student's press (speech:start) always may start one. */
const HELPER_RETRY_MS = 30_000;
let helperDownAt = 0;
let quitting = false;

/** What the log keeps of a session (by the helper's id) until the helper's "end" for it, a
 *  session the page has already dropped included (its abort is still logged): when the page's
 *  start reached here (performance.now()), what the page ended it with, the helper's error, and
 *  whether its first words were logged. Never the words. */
interface SessionLog {
  startedAt: number;
  endedBy?: "stop" | "abort";
  error?: string;
  heard: boolean;
}
const logs = new Map<number, SessionLog>();

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The page ended the session (stop, or abort: its abort, a restart of the same ref, the page going). */
function endedBy(session: Session, how: "stop" | "abort"): void {
  const log = logs.get(session.id);
  if (log && log.endedBy !== "abort") log.endedBy = how;
}

/** The 5.1 lines (speechLog.ts) for one helper event. Counts, causes and times only. */
function logEvent(ev: string, msg: HelperEvent): void {
  const at = new Date();
  const id = typeof msg.id === "number" ? msg.id : 0;
  const log = logs.get(id);
  switch (ev) {
    case "ready":
      console.log(
        speechLine.ready(at, id, msg.onDevice === true, str(msg.lang), typeof msg.cached === "boolean" ? msg.cached : undefined, typeof msg.setupMs === "number" ? msg.setupMs : undefined),
      );
      return;
    case "prepared":
      console.log(speechLine.prepared(at, str(msg.lang), msg.onDevice === true, num(msg.ms)));
      return;
    case "mic":
      console.log(speechLine.mic(at, msg.on === true, str(msg.why)));
      return;
    case "route":
      console.log(
        speechLine.route(at, {
          input: str(msg.input),
          transport: str(msg.transport),
          using: str(msg.using),
          usingTransport: typeof msg.usingTransport === "string" ? msg.usingTransport : undefined,
          changed: msg.changed === true,
        }),
      );
      return;
    case "audiostart":
      if (log) console.log(speechLine.live(at, id, performance.now() - log.startedAt, msg.warm === true, num(msg.preroll)));
      return;
    case "speechstart":
    case "interim":
    case "phrase": {
      if (!log) return;
      if (!log.heard && (ev === "speechstart" || str(msg.text).trim())) {
        log.heard = true;
        console.log(speechLine.firstWords(at, id, performance.now() - log.startedAt));
      }
      if (ev !== "phrase") return;
      const words = typeof msg.words === "number" ? msg.words : str(msg.text).split(/\s+/).filter(Boolean).length;
      const cutAt = typeof msg.cutAt === "number" ? msg.cutAt : typeof msg.t === "number" ? msg.t : Date.now();
      const voiceEnded = typeof msg.voiceEnd === "number" && msg.voiceEnd > 0 ? Math.max(0, cutAt - msg.voiceEnd) : undefined;
      console.log(speechLine.phrase(at, id, words, str(msg.cut) || "unknown", voiceEnded));
      return;
    }
    case "error":
      if (log && !log.error && typeof msg.code === "string") log.error = msg.code;
      return;
    case "end":
      if (!log) return;
      logs.delete(id);
      console.log(speechLine.end(at, id, { endedBy: log.endedBy, error: log.error }));
      return;
    default:
      return;
  }
}

function tell(session: Session, ev: string, extra: { text?: string; code?: string } = {}): void {
  if (!session.sender.isDestroyed()) session.sender.send("speech:event", { ref: session.ref, ev, ...extra });
}

/** The session is over, whatever ended it. */
function drop(session: Session): void {
  sessions.delete(session.id);
}

function command(message: Record<string, unknown>): void {
  helper?.stdin.write(`${JSON.stringify(message)}\n`);
}

/** The helper's "output": kept, logged when it is news (the first, or a device or verdict other
 *  than the last: a page's ask and a new helper say the same one again), and sent to every page
 *  that asked for it and is still there. */
function heardOutput(msg: HelperEvent): void {
  const o = speechOutputOf(msg);
  if (!o) return;
  const route: OutputRoute = { name: o.name, transport: o.transport, source: o.source, speakers: o.speakers };
  const last = lastOutput;
  const same = last !== null && last.name === route.name && last.transport === route.transport && last.source === route.source && last.speakers === route.speakers;
  lastOutput = route;
  // ("changed" once there was one before: a device switched while no helper ran is a change too)
  if (!same) console.log(speechLine.output(new Date(), { ...o, changed: o.changed || last !== null }));
  for (const page of [...outputPages]) {
    if (page.isDestroyed()) outputPages.delete(page);
    // (only while it shows the app: a sign-in round trip may have another site in it for a while)
    else if (appPage(page.getURL())) page.send("speech:output", route);
  }
}

function onLine(line: string): void {
  let msg: HelperEvent;
  try {
    msg = JSON.parse(line) as HelperEvent;
  } catch {
    console.warn(`[speech] ${line}`);
    return;
  }
  const ev = typeof msg.ev === "string" ? msg.ev : "";
  if (ev === "output") return heardOutput(msg);
  logEvent(ev, msg);
  if (ev === "ready") return;
  const session = typeof msg.id === "number" ? sessions.get(msg.id) : undefined;
  if (!session) return;
  const text = typeof msg.text === "string" ? msg.text : undefined;
  const code = typeof msg.code === "string" ? msg.code : undefined;
  if (ev === "end") drop(session);
  tell(session, ev, { text, code });
}

function helperGone(why: string): void {
  console.warn(`[speech] helper ${why}`);
  logs.clear();
  for (const session of [...sessions.values()]) {
    drop(session);
    tell(session, "error", { code: "network" });
    tell(session, "end", { text: "" });
  }
}

/** The running helper, or a new one. `auto` (warm, prepare: nobody pressed anything): none is
 *  started within HELPER_RETRY_MS of the last one going down by itself. */
function ensureHelper(auto = false): Helper | null {
  if (helper) return helper;
  if (auto && Date.now() - helperDownAt < HELPER_RETRY_MS) return null;
  const file = speechHelperPath();
  if (!file) return null;
  let child: Helper;
  try {
    child = spawn(file, [], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    helperDownAt = Date.now();
    console.warn(`[speech] could not start the helper: ${(e as Error).message}`);
    return null;
  }
  helper = child;
  readline.createInterface({ input: child.stdout }).on("line", onLine);
  readline.createInterface({ input: child.stderr }).on("line", (line) => console.warn(line));
  child.stdin.on("error", () => undefined);
  child.on("error", (e) => {
    if (helper === child) helper = null;
    if (!quitting) helperDownAt = Date.now();
    helperGone(`failed: ${e.message}`);
  });
  child.on("exit", (code, signal) => {
    if (helper === child) helper = null;
    if (!quitting) helperDownAt = Date.now();
    helperGone(`exited (${signal ?? code})`);
  });
  console.log(speechLine.helperStarted(new Date(), child.pid ?? 0));
  return child;
}

const appPage = (url: string): boolean => url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`);

function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return appPage(event.senderFrame?.url ?? "");
}

function sessionOf(sender: WebContents, ref: number): Session | undefined {
  for (const session of sessions.values()) {
    if (session.sender === sender && session.ref === ref) return session;
  }
  return undefined;
}

/** The pages' recognisers (speech:start / stop / abort), when this Mac has the helper. */
export function installSpeech(): void {
  if (!nativeSpeechAvailable()) return;
  const watched = new WeakSet<WebContents>();
  // The starts waiting for the student's answer to the app's microphone question: a stop or an
  // abort of the same page and ref meanwhile drops its start, and so does the page going.
  const asking = new Set<{ sender: WebContents; ref: number }>();
  const dropAsking = (sender: WebContents, ref: number): void => {
    for (const waiting of asking) if (waiting.sender === sender && waiting.ref === ref) asking.delete(waiting);
  };

  ipcMain.on("speech:start", (event, ref: unknown, lang: unknown, continuous: unknown, options: unknown) => {
    if (!trusted(event) || typeof ref !== "number") return;
    const sender = event.sender;
    const fail = (code: string): void => {
      sender.send("speech:event", { ref, ev: "error", code });
      sender.send("speech:event", { ref, ev: "end", text: "" });
    };
    // The helper's microphone is the app's too: the student's answer to the app's own question
    // (microphone.ts; WHAT_TO_FIX.md WIN-07 / MAC-08) holds here as for the web app's requests.
    // No refuses as a browser does ("not-allowed"); before any answer the question is put first.
    dropAsking(sender, ref);
    const answer = microphoneAnswer();
    if (answer === "deny") return fail("not-allowed");
    if (answer === null) {
      const waiting = { sender, ref };
      asking.add(waiting);
      const left = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
        if (details.isMainFrame && !details.isSameDocument) asking.delete(waiting);
      };
      sender.on("did-start-navigation", left);
      void microphoneAllowed(sender).then((allowed) => {
        const still = asking.delete(waiting);
        if (sender.isDestroyed()) return;
        sender.off("did-start-navigation", left);
        if (!still) return;
        if (allowed) begin(sender, ref, lang, continuous, options, fail);
        else fail("not-allowed");
      });
      return;
    }
    begin(sender, ref, lang, continuous, options, fail);
  });

  const begin = (
    sender: WebContents,
    ref: number,
    lang: unknown,
    continuous: unknown,
    options: unknown,
    fail: (code: string) => void,
  ): void => {
    const child = ensureHelper();
    if (!child) return fail("network");
    // A page restarting a recogniser reuses no ref; an old one with this ref is gone.
    const old = sessionOf(sender, ref);
    if (old) {
      endedBy(old, "abort");
      drop(old);
      command({ cmd: "abort", id: old.id });
    }
    const session: Session = { id: nextId++, ref, sender };
    sessions.set(session.id, session);
    if (!watched.has(sender)) {
      watched.add(sender);
      // The page going (a tab closed, a reload, another page loaded in its place) must
      // not leave the microphone open: its recognisers go with it.
      const abandon = (): void => {
        for (const s of [...sessions.values()]) {
          if (s.sender !== sender) continue;
          endedBy(s, "abort");
          drop(s);
          command({ cmd: "abort", id: s.id });
        }
      };
      sender.once("destroyed", abandon);
      sender.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) abandon();
      });
    }
    // The pre roll and the hints, checked (speechLog.ts); "+N ms" in the log counts from here.
    const now = Date.now();
    const opts = speechStartOptions(options, now);
    logs.set(session.id, { startedAt: performance.now(), heard: false });
    console.log(speechLine.start(new Date(now), session.id, continuous === true, opts.preroll !== undefined ? now - opts.preroll : undefined));
    command({
      cmd: "start",
      id: session.id,
      lang: typeof lang === "string" ? lang.slice(0, 32) : "",
      continuous: continuous === true,
      ...opts,
    });
  };

  ipcMain.on("speech:stop", (event, ref: unknown) => {
    if (!trusted(event) || typeof ref !== "number") return;
    dropAsking(event.sender, ref);
    const session = sessionOf(event.sender, ref);
    if (!session) return;
    endedBy(session, "stop");
    command({ cmd: "stop", id: session.id });
  });

  ipcMain.on("speech:abort", (event, ref: unknown) => {
    if (!trusted(event) || typeof ref !== "number") return;
    dropAsking(event.sender, ref);
    const session = sessionOf(event.sender, ref);
    if (!session) return;
    endedBy(session, "abort");
    drop(session);
    command({ cmd: "abort", id: session.id });
  });

  // A page about to listen: the microphone kept running for `ms` (at most 20 s; 0 lets it go
  // unless a session runs). The helper starts it only once it is allowed, and never asks. A
  // "let go" with no helper running has nothing to tell; nor has a warm while a helper that went
  // down by itself is given time (ensureHelper's `auto`). Nor a warm before the student said yes
  // to the app's microphone question (microphone.ts): a warm never puts it; the first start does.
  ipcMain.on("speech:warm", (event, ms: unknown) => {
    if (!trusted(event) || typeof ms !== "number" || !Number.isFinite(ms)) return;
    const wanted = Math.round(Math.min(Math.max(ms, 0), 20_000));
    if (wanted === 0 && !helper) return;
    if (wanted > 0 && microphoneAnswer() !== "allow") return;
    if (!ensureHelper(true)) return;
    command({ cmd: "warm", id: 0, ms: wanted });
  });

  // A page that will listen in `lang`: its recogniser made now (once both permissions are given;
  // never asks, opens no microphone), so its first start finds it ready.
  ipcMain.on("speech:prepare", (event, lang: unknown) => {
    if (!trusted(event) || typeof lang !== "string") return;
    if (!ensureHelper(true)) return;
    command({ cmd: "prepare", id: 0, lang: lang.slice(0, 32) });
  });

  // Where the tutor's voice plays ({name, transport, source, speakers}), now: the latest the
  // helper said, or null while none is known (no helper yet, one given time after it went down by
  // itself, or one older than this). The page asking is told of every change from now on
  // (speech:output, sent to it) until it goes; a helper is made sure of (ensureHelper's `auto`)
  // and asked to say it again. A page reloaded asks again, and is the same contents: kept once.
  ipcMain.handle("speech:output", (event): OutputRoute | null => {
    if (!trusted(event)) return null;
    const sender = event.sender;
    if (!outputPages.has(sender)) {
      outputPages.add(sender);
      sender.once("destroyed", () => outputPages.delete(sender));
    }
    if (ensureHelper(true)) command({ cmd: "output", id: 0 });
    return lastOutput;
  });

  app.on("will-quit", () => {
    quitting = true;
    const child = helper;
    helper = null;
    if (child) {
      child.stdin.end();
      setTimeout(() => child.kill(), 500).unref();
    }
  });
}
