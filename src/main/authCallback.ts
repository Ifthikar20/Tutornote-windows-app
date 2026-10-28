/*
  Deciding what a tutornote:// (or anothernotes://) auth callback link means, kept pure so it can
  be tested without Electron (scripts/tests/authCallback.test.ts).

  The sign-in this app started keeps a `state` to itself; the callback must carry the same one. The
  state is compared BEFORE the pending sign-in is given up, so a link from anywhere else - a web
  page firing the scheme, a stale link from another launch - cannot throw away a sign-in that is
  still in flight, nor pop the "expired" dialog. The pending sign-in is consumed only once a link
  with the right state arrives (fresh, stale, or carrying a malformed code): see WHAT_TO_FIX.md
  WIN-06 / MAC-07.
*/

export interface PendingSignIn {
  state: string;
  verifier: string;
  startedAt: number;
}

export type CallbackClass =
  /** Not an auth/callback link at all (or not a URL): nothing to do, the pending sign-in stays. */
  | { kind: "not-callback" }
  /** An auth/callback link, but no sign-in is waiting in this app: ignored, no dialog. */
  | { kind: "no-pending" }
  /** A sign-in is waiting but the link's state is not the one it made: ignored, the sign-in stays. */
  | { kind: "wrong-state" }
  /** This app's own callback, but it came too late: the sign-in is consumed; offer to start again. */
  | { kind: "expired"; ageSeconds: number }
  /** This app's own callback, in time, but the code is malformed: consumed; offer to start again. */
  | { kind: "bad-code" }
  /** This app's own callback, in time, with a usable code: consumed; exchange it. */
  | { kind: "ok"; code: string; state: string; verifier: string; ageSeconds: number };

/** Whether this outcome means the pending sign-in has been used up (the caller clears it then). */
export function consumesPending(result: CallbackClass): boolean {
  return result.kind === "expired" || result.kind === "bad-code" || result.kind === "ok";
}

export interface CallbackOptions {
  /** The schemes this app answers (the current one first). */
  schemes: readonly string[];
  /** How long a started sign-in waits for its callback (ms). */
  ttlMs: number;
  /** The shape a one-time code must have. */
  token: RegExp;
}

/** Classify a delivered link against the pending sign-in. Pure: no module state, no Electron. */
export function classifyCallback(raw: string, pending: PendingSignIn | null, now: number, opts: CallbackOptions): CallbackClass {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "not-callback" };
  }
  const isCallback = opts.schemes.some((s) => url.protocol === `${s}:`) && url.hostname === "auth" && url.pathname === "/callback";
  if (!isCallback) return { kind: "not-callback" };
  if (!pending) return { kind: "no-pending" };
  const state = url.searchParams.get("state") ?? "";
  // The state decides whether this link belongs to the waiting sign-in, before it is given up.
  if (state !== pending.state) return { kind: "wrong-state" };
  const ageSeconds = Math.round((now - pending.startedAt) / 1000);
  if (now - pending.startedAt > opts.ttlMs) return { kind: "expired", ageSeconds };
  const code = url.searchParams.get("code") ?? "";
  if (!opts.token.test(code)) return { kind: "bad-code" };
  return { kind: "ok", code, state, verifier: pending.verifier, ageSeconds };
}
