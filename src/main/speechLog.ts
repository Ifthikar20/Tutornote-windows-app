/*
  The speech helper's numbers, as speech.ts writes them to the log, and the start options a
  page may send with a recogniser. Pure (no Electron), so it is tested on its own
  (scripts/tests/speechLog.test.ts).

  Every line has the local wall clock to the millisecond, the clock the web app's own [voice]
  lines and the [api] lines carry, so one question can be read end to end across them: the
  helper hearing the voice end, the page sending the question, the server answering. No line
  ever has a word the student said in it: counts, causes and times only.

    [speech] 22:04:00.020 helper started (pid 21946)
    [speech] 22:04:00.031 output: MacBook Pro Speakers (builtin, ispk): speakers
    [speech] 22:04:00.140 prepared en-US on this Mac in 112 ms
    [speech] 22:04:00.104 mic on (warm)
    [speech] 22:04:00.105 input: AirPods Pro (bluetooth), using MacBook Pro Microphone (builtin)
    [speech] 22:04:00.230 #7 start (continuous, preroll 126 ms asked)
    [speech] 22:04:00.236 #7 on this Mac (en-US), recogniser cached
    [speech] 22:04:00.237 #7 live +7 ms (mic was on, 126 ms of audio from before the start)
    [speech] 22:04:01.890 #7 first words +1660 ms
    [speech] 22:04:06.330 #7 phrase: 9 words, cut quiet, voice ended 512 ms before
    [speech] 22:04:06.951 #7 end after stop
    [speech] 22:04:31.000 audio route changed: External Microphone (usb)
    [speech] 22:05:12.400 output changed: AirPods Pro (bluetooth): headphones

  `#7` is the helper's session; `+N ms` on live and first words is from the page's start
  reaching the main process; "voice ended N ms before" is the cut less the end of the last
  voiced audio the helper heard. "output" is where the tutor's voice plays, and whether the
  microphone can hear it there (speakers) or not (headphones): the page listens only between the
  tutor's parts on speakers.
*/

/** A start's pre roll reaches back at most this far (the helper keeps 2000 ms; it feeds 1500 at most). */
export const PREROLL_MAX_MS = 1_500;
/** A pre roll older than this is a stale press, not this start's: none is asked. */
export const PREROLL_STALE_MS = 5_000;
/** A start's hints (the lesson's words for Apple's recogniser): at most this many, each this long. */
export const HINTS_MAX = 50;
export const HINT_CHARS = 40;

/** The local wall clock to the millisecond: HH:MM:SS.mmm. */
export function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * A page's options for a recogniser's start (speech:start's 4th argument), as the helper is to
 * get them. `preroll` (unix ms): kept when it is a finite time no later than now and no more
 * than PREROLL_STALE_MS ago, brought to at most PREROLL_MAX_MS back. `hints`: strings only,
 * trimmed, no empty ones, each cut to HINT_CHARS characters, at most HINTS_MAX. Anything else,
 * or nothing left, is left out.
 */
export function speechStartOptions(raw: unknown, nowMs: number): { preroll?: number; hints?: string[] } {
  const out: { preroll?: number; hints?: string[] } = {};
  if (typeof raw !== "object" || raw === null) return out;
  const { preroll, hints } = raw as { preroll?: unknown; hints?: unknown };
  if (typeof preroll === "number" && Number.isFinite(preroll) && preroll <= nowMs && nowMs - preroll <= PREROLL_STALE_MS) {
    out.preroll = Math.max(preroll, nowMs - PREROLL_MAX_MS);
  }
  if (Array.isArray(hints)) {
    const kept: string[] = [];
    for (const hint of hints) {
      if (typeof hint !== "string") continue;
      const trimmed = hint.trim();
      if (!trimmed) continue;
      kept.push(Array.from(trimmed).slice(0, HINT_CHARS).join(""));
      if (kept.length === HINTS_MAX) break;
    }
    if (kept.length) out.hints = kept;
  }
  return out;
}

const line = (at: Date, text: string): string => `[speech] ${stamp(at)} ${text}`;
const ms = (n: number): string => `${Math.round(n)} ms`;

/** What the microphone runs on (the helper's "route" event). */
export interface SpeechRoute {
  /** The Mac's default input, and its transport (builtin, bluetooth, usb, …). */
  input: string;
  transport: string;
  /** The input used (the default but for a Bluetooth headset's, when the Mac has its own). */
  using: string;
  usingTransport?: string;
  /** A change of input while it ran, not its start. */
  changed: boolean;
}

/**
 * Where the tutor's voice plays: the Mac's default output (the helper's "output" event, at its
 * start, on every change, and when asked). `transport`: builtin, bluetooth, usb, hdmi,
 * displayport, airplay, …; `source`: the built in output's data source as its four letter code
 * ("ispk" the speakers, "hdpn" the headphone jack), "" for none. `speakers`: the helper's verdict,
 * whether the microphone can hear it (headphones cannot); unsure is speakers. `changed`: a change,
 * not the first report. The page gets all but `changed` (speech:output).
 */
export interface SpeechOutput {
  name: string;
  transport: string;
  source: string;
  speakers: boolean;
  changed: boolean;
}

/** The helper's "output" event as kept and sent on: strings cut to size, `speakers` a boolean
 *  (none: not an output event this side can use, null). */
export function speechOutputOf(raw: unknown): SpeechOutput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { name, transport, source, speakers, changed } = raw as Record<string, unknown>;
  if (typeof speakers !== "boolean") return null;
  const text = (v: unknown, max: number): string => (typeof v === "string" ? Array.from(v.trim()).slice(0, max).join("") : "");
  return { name: text(name, 128), transport: text(transport, 32), source: text(source, 8), speakers, changed: changed === true };
}

/** The lines of section 5.1, each from what the helper and the page said; `at` is now. */
export const speechLine = {
  helperStarted: (at: Date, pid: number): string => line(at, `helper started (pid ${pid})`),

  prepared: (at: Date, lang: string, onDevice: boolean, took: number): string =>
    line(at, `prepared ${lang} ${onDevice ? "on this Mac" : "for Apple's server"} in ${ms(took)}`),

  mic: (at: Date, on: boolean, why?: string): string => line(at, on ? `mic on (${why === "warm" ? "warm" : "session"})` : "mic off"),

  route: (at: Date, r: SpeechRoute): string => {
    const using = `${r.using} (${r.usingTransport ?? r.transport})`;
    if (r.changed) return line(at, `audio route changed: ${using}`);
    const input = `${r.input} (${r.transport})`;
    return line(at, r.using === r.input ? `input: ${input}` : `input: ${input}, using ${using}`);
  },

  /** Where the voice plays (SpeechOutput): the device, its transport and data source (when it has
   *  one), and whether the microphone can hear it. */
  output: (at: Date, o: SpeechOutput): string => {
    const about = [o.transport || "unknown", o.source].filter(Boolean).join(", ");
    return line(at, `output${o.changed ? " changed" : ""}: ${o.name || "unknown device"} (${about}): ${o.speakers ? "speakers" : "headphones"}`);
  },

  /** A page's recogniser starting (main's speech:start); `prerollMs`: how far back its pre roll reaches. */
  start: (at: Date, id: number, continuous: boolean, prerollMs?: number): string =>
    line(at, `#${id} start (${continuous ? "continuous" : "one utterance"}${prerollMs !== undefined ? `, preroll ${ms(prerollMs)} asked` : ""})`),

  /** The helper's "ready": where the words are made, and whether the recogniser was made before. */
  ready: (at: Date, id: number, onDevice: boolean, lang: string, cached?: boolean, setupMs?: number): string =>
    line(
      at,
      `#${id} ${onDevice ? "on this Mac" : "Apple's server"} (${lang})` +
        (cached === true ? ", recogniser cached" : typeof setupMs === "number" ? `, recogniser made in ${ms(setupMs)}` : ""),
    ),

  /** The helper's "audiostart": `sinceStart` from main's speech:start; `warm`: the microphone was on. */
  live: (at: Date, id: number, sinceStart: number, warm: boolean, prerollMs: number): string =>
    line(
      at,
      `#${id} live +${ms(sinceStart)} (${warm ? "mic was on" : "mic started"}` +
        (prerollMs > 0 ? `, ${ms(prerollMs)} of audio from before the start` : "") +
        ")",
    ),

  firstWords: (at: Date, id: number, sinceStart: number): string => line(at, `#${id} first words +${ms(sinceStart)}`),

  /** One finished phrase: how many words, what cut it, and how long after the voice ended (when known). */
  phrase: (at: Date, id: number, words: number, cut: string, voiceEnded?: number): string =>
    line(at, `#${id} phrase: ${words} ${words === 1 ? "word" : "words"}, cut ${cut}${voiceEnded !== undefined ? `, voice ended ${ms(voiceEnded)} before` : ""}`),

  /** The session over: after the page's stop or abort, else with the helper's error, if any. */
  end: (at: Date, id: number, how: { endedBy?: "stop" | "abort"; error?: string } = {}): string =>
    line(at, `#${id} end${how.endedBy ? ` after ${how.endedBy}` : how.error ? `, error ${how.error}` : ""}`),
};
