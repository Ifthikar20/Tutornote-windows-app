import { app, dialog, type BrowserWindow } from "electron";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyCallback, consumesPending } from "./authCallback";
import { API_URL, APP_ORIGIN, BUNDLED, SITE_ORIGIN } from "./config";
import { openExternal } from "./links";
import { focusMainWindow, openAfterSignIn } from "./windows";

/*
  Signing in through the browser.

  Google refuses to sign in inside an Electron window, and the browser is where the
  student is signed in already, so the app sends them there and takes the session back
  through a link only it can use:

    1. beginBrowserSignIn: mint a `state` and a PKCE secret, open
       https://tutornote.ai/desktop/sign-in?state&challenge&scheme in the system browser.
    2. The browser signs in as usual and asks the API for a one-time code bound to the
       challenge, then opens tutornote://auth/callback?code&state (the scheme this app
       named: a page from before it knew the name opens the old anothernotes:// one).
    3. The OS hands that link to this app (open-url on macOS, argv elsewhere).
       handleDeepLink checks the state and navigates the window to the API's exchange
       with the code and the secret; the API sets the refresh cookie for this window and
       lands on /auth/callback, exactly as a Google sign-in lands in the browser.

  The secret never leaves this process, so a link seen on the way is worthless.

  Each step is written to the sign-in log (userData/logs/sign-in.log: what happened and why a
  link was turned away - never a code, a state or the secret), so a sign-in that never comes
  back can be traced on the PC as well as in the server's logs.
*/

export const PROTOCOL = "tutornote";
/** The scheme the web's /desktop/sign-in opened before it took the app's own (`scheme`): still
 *  taken until that page is live everywhere, so a sign-in never breaks in between. */
const LEGACY_PROTOCOL = "anothernotes";
const SCHEMES = [PROTOCOL, LEGACY_PROTOCOL];
const PENDING_TTL_MS = 10 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
/** The sign-in log is started over past this size (the one before kept as .old). */
const LOG_MAX_BYTES = 256 * 1024;

interface Pending {
  state: string;
  verifier: string;
  startedAt: number;
}

let pending: Pending | null = null;

const b64url = (bytes: Buffer): string => bytes.toString("base64url");

/** One line in the sign-in log, and on the console. Never throws: a log that can't be written is
 *  no reason to stop a sign-in. */
export function authLog(line: string): void {
  console.log(`[tutornote] sign-in: ${line}`);
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    const file = path.join(dir, "sign-in.log");
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* (the console has it) */
  }
}

const isOurLink = (raw: string): boolean => SCHEMES.some((s) => raw.startsWith(`${s}://`));

/** Open the browser on the sign-in page, remembering what only this app knows. */
export function beginBrowserSignIn(): void {
  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  pending = { state, verifier, startedAt: Date.now() };
  const url = new URL("/desktop/sign-in", SITE_ORIGIN);
  url.searchParams.set("state", state);
  url.searchParams.set("challenge", challenge);
  url.searchParams.set("scheme", PROTOCOL);
  authLog(`browser sign-in started at ${url.origin}${url.pathname}; waiting for ${PROTOCOL}://auth/callback`);
  openExternal(url.toString());
}

export function cancelBrowserSignIn(): void {
  if (pending) authLog("browser sign-in cancelled");
  pending = null;
}

/** The tutornote:// (and old anothernotes://) links among a process's arguments (Windows and Linux
 *  hand them over that way). */
export function deepLinksIn(argv: string[]): string[] {
  return argv.filter(isOurLink);
}

/** The API's exchange URL for an accepted callback (the bundled renderer forwards it through the
 *  app's own origin; renderer.ts brings the redirect to /auth/callback back into the bundle). */
function exchangeUrl(code: string, state: string, verifier: string): string {
  const exchange = new URL(BUNDLED ? `${APP_ORIGIN}/api/auth/desktop/exchange` : `${API_URL}/auth/desktop/exchange`);
  exchange.searchParams.set("code", code);
  exchange.searchParams.set("state", state);
  exchange.searchParams.set("code_verifier", verifier);
  return exchange.toString();
}

/** Offer to start the browser sign-in again (a callback that was this app's own but came too late,
 *  or carried a malformed code). */
function offerRestart(win: BrowserWindow): void {
  void dialog
    .showMessageBox(win, {
      type: "info",
      message: "That sign-in link has expired",
      detail: "Start again from the app: choose “Continue with your browser”, sign in there, and you'll come straight back.",
      buttons: ["Continue with your browser", "Not now"],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) beginBrowserSignIn();
    });
}

/** A link the OS delivered. Only an auth/callback that carries this sign-in's own state means
 *  anything; anything else just brings the window up, and never gives up the waiting sign-in
 *  (authCallback.ts; WHAT_TO_FIX.md WIN-06). */
export function handleDeepLink(raw: string): void {
  if (!isOurLink(raw)) return;
  let shown = raw.split("?")[0];
  try {
    const u = new URL(raw);
    shown = `${u.protocol}//${u.hostname}${u.pathname} (code ${u.searchParams.has("code") ? "yes" : "no"}, state ${u.searchParams.has("state") ? "yes" : "no"})`;
  } catch {
    /* (shown as its start) */
  }
  authLog(`link received from the system: ${shown}`);
  const win = focusMainWindow();
  const result = classifyCallback(raw, pending, Date.now(), { schemes: SCHEMES, ttlMs: PENDING_TTL_MS, token: TOKEN });
  // The waiting sign-in is given up only once a link with its own state arrives (classifyCallback).
  if (consumesPending(result)) pending = null;
  switch (result.kind) {
    case "ok":
      authLog(`callback accepted ${result.ageSeconds} s after the sign-in started: exchanging the code`);
      openAfterSignIn(exchangeUrl(result.code, result.state, result.verifier));
      return;
    case "expired":
      authLog(`callback turned away: the sign-in was started ${result.ageSeconds} s ago (it waits ${PENDING_TTL_MS / 1000} s)`);
      offerRestart(win);
      return;
    case "bad-code":
      authLog("callback turned away: its code is malformed");
      offerRestart(win);
      return;
    case "wrong-state":
      authLog("callback ignored: its state is not the one this sign-in made (the waiting sign-in is kept)");
      return;
    case "no-pending":
      authLog("callback ignored: no browser sign-in is waiting in this window (started in another copy of the app, or already used)");
      return;
    case "not-callback":
      return;
  }
}

/** Make this app the one the OS opens tutornote:// links with (and the old anothernotes:// ones,
 *  until the web's sign-in page names the scheme everywhere). */
export function registerProtocol(): void {
  for (const scheme of SCHEMES) {
    const done =
      process.defaultApp && process.argv.length >= 2
        ? // `electron .` in development: point the OS at this binary plus the project folder.
          app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])])
        : app.setAsDefaultProtocolClient(scheme);
    authLog(`${scheme}:// links ${done ? "open this app" : "could not be claimed by this app"}${process.defaultApp ? " (development run)" : ""}`);
  }
}
