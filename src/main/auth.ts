import { app, dialog } from "electron";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

/** Where the API's exchange lives for this code; null when the link is not one this app is waiting
 *  for (and why, in the sign-in log). */
export function exchangeUrlFor(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    authLog("a link that is no URL was turned away");
    return null;
  }
  if (!SCHEMES.some((s) => url.protocol === `${s}:`) || url.hostname !== "auth" || url.pathname !== "/callback") return null;
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const current = pending;
  pending = null;
  if (!current) {
    authLog("callback turned away: no browser sign-in is waiting in this window (started in another copy of the app, or already used)");
    return null;
  }
  const age = Math.round((Date.now() - current.startedAt) / 1000);
  if (age * 1000 > PENDING_TTL_MS) {
    authLog(`callback turned away: the sign-in was started ${age} s ago (it waits ${PENDING_TTL_MS / 1000} s)`);
    return null;
  }
  if (state !== current.state) {
    authLog("callback turned away: its state is not the one this sign-in made");
    return null;
  }
  if (!TOKEN.test(code)) {
    authLog("callback turned away: its code is malformed");
    return null;
  }
  // With the bundled renderer the exchange goes through the app's origin (renderer.ts
  // forwards it and brings the redirect to /auth/callback back into the bundle).
  const exchange = new URL(BUNDLED ? `${APP_ORIGIN}/api/auth/desktop/exchange` : `${API_URL}/auth/desktop/exchange`);
  exchange.searchParams.set("code", code);
  exchange.searchParams.set("state", state);
  exchange.searchParams.set("code_verifier", current.verifier);
  authLog(`callback accepted ${age} s after the sign-in started: exchanging the code`);
  return exchange.toString();
}

/** A link the OS delivered. Only auth/callback means anything; anything else just brings the window up. */
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
  const exchange = exchangeUrlFor(raw);
  if (exchange) {
    openAfterSignIn(exchange);
    return;
  }
  if (new URL(raw).hostname !== "auth") return;
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
