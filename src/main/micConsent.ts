/*
  The app's own question before the microphone, kept pure so it can be tested without Electron
  (scripts/tests/micConsent.test.ts; the Electron half is microphone.ts).

  In a browser a site gets the microphone only after the browser has asked. In the app the web
  app's origin got it with no question at all: Windows has no consent of its own for a desktop
  program, and macOS asks once for the whole app, so any script that ran in that origin could
  start recording (WHAT_TO_FIX.md WIN-07 / MAC-08). So the first time the app's origin asks for
  the microphone, the student is asked once, in the app, and the answer is kept in a small file
  in the app's profile folder. From then on it stands without asking: "allow" lets the request
  through (macOS then asks its own question, the first time), "deny" refuses it. The menu
  changes it (menu.ts). A file that cannot be read, or holds anything else, is no answer: the
  student is asked again.
*/

export type MicAnswer = "allow" | "deny";

/** The answer in the file's text, or null when there is none (no file, or not one of ours). */
export function answerOf(text: string | null): MicAnswer | null {
  if (!text) return null;
  try {
    const raw: unknown = JSON.parse(text);
    const answer = raw && typeof raw === "object" ? (raw as { microphone?: unknown }).microphone : undefined;
    return answer === "allow" || answer === "deny" ? answer : null;
  } catch {
    return null;
  }
}

/** The file's text for an answer, and when it was given. */
export function fileOf(answer: MicAnswer, at: Date): string {
  return `${JSON.stringify({ microphone: answer, answeredAt: at.toISOString() }, null, 2)}\n`;
}

export interface MicStore {
  /** The file's text, or null when there is none. */
  read(): string | null;
  /** Keep the file's text (may throw: the answer then holds for this run only). */
  write(text: string): void;
  now(): Date;
}

/** The question itself: the answer, or null when it was closed with none. */
export type MicAsk = () => Promise<MicAnswer | null>;

export interface MicConsent {
  /** The answer kept, or null before the student has given one. */
  answer(): MicAnswer | null;
  /** Whether the microphone may be used now: by the answer kept, else by asking (once). */
  allowed(ask: MicAsk): Promise<boolean>;
  /** A new answer (the menu's), kept. */
  set(answer: MicAnswer): void;
}

/** `changed`: told of every answer kept, the student's or the menu's (the menu redraws its tick). */
export function createMicConsent(store: MicStore, changed: (answer: MicAnswer) => void = () => undefined): MicConsent {
  let known: MicAnswer | null | undefined; // undefined: the file is not read yet
  let asking: Promise<boolean> | null = null;

  const answer = (): MicAnswer | null => {
    if (known === undefined) {
      try {
        known = answerOf(store.read());
      } catch {
        known = null;
      }
    }
    return known;
  };

  const set = (value: MicAnswer): void => {
    known = value;
    try {
      store.write(fileOf(value, store.now()));
    } catch {
      /* kept for this run; asked again at the next launch */
    }
    changed(value);
  };

  const allowed = (ask: MicAsk): Promise<boolean> => {
    const kept = answer();
    if (kept) return Promise.resolve(kept === "allow");
    // Requests that come while the question is up share it: one question, one answer. A
    // question closed with no answer refuses this time and asks again the next.
    asking ??= Promise.resolve().then(ask).then(
      (given) => {
        asking = null;
        if (given) set(given);
        return given === "allow";
      },
      () => {
        asking = null;
        return false;
      },
    );
    return asking;
  };

  return { answer, allowed, set };
}
