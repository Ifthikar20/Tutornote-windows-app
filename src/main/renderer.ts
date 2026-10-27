import { net, protocol } from "electron";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clock, TIMED, timeBody } from "./apiTiming";
import { API_ORIGIN, APP_ORIGIN, APP_SCHEME, CLIENT_HEADER, PROXIED_PATHS, RENDERER_DIR, SITE_ORIGIN } from "./config";
import { appEvents } from "./events";
import { serverRequest, type ServerResponse } from "./server";

/*
  The bundled renderer: the web app's production build served from the app's own origin,
  app://anothernotes, the way nginx serves it on the site.

    app://anothernotes/dashboard        -> renderer/_html/app.html  (the SPA's empty shell; any route)
    app://anothernotes/assets/x.js      -> renderer/assets/x.js
    app://anothernotes/api/notes        -> <server>/api/notes    (forwarded, with cookies)
    app://anothernotes/img/<sha>.jpg    -> <server>/img/<sha>.jpg (its redirect to the site's
                                           picture store followed here: followPicture)

  To the web app nothing changed: its API base is the relative /api, as in production,
  so its fetches are same-origin. The forwarding runs in this process (server.ts), which
  keeps the server's cookies, the refresh cookie among them, in the app's jar and sends
  them back to the server; the renderer never sees them.
*/

/** The one place the scheme's abilities are declared; must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

/** The build the bundle came from, written by scripts/build-renderer.sh. */
export function rendererBuild(): string {
  try {
    return readFileSync(path.join(RENDERER_DIR, "BUILD"), "utf8").trim();
  } catch {
    return "unknown";
  }
}

/**
 * Mirrors deploy/aws/nginx.conf in the web repo; 'self' is the app's own origin here.
 * No inline scripts: the pages' own scripts are files (theme-boot.js, maintenance.js,
 * terms.js). 'wasm-unsafe-eval' is for pdf.js's JPEG 2000 and ICC decoders. Every
 * picture the app shows is its own (/img), so img-src names no other host.
 * No Cloudflare Web Analytics hosts either: the privacy page promises no third-party
 * analytics, so the policy blocks such a beacon rather than sending it.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
  "frame-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://challenges.cloudflare.com",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Response headers that would be wrong after forwarding: the body arrives decoded. */
const DROPPED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

const isProxied = (pathname: string): boolean =>
  PROXIED_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

export function installRenderer(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    if (!isProxied(url.pathname)) return serve(url.pathname);
    if (fromAnotherSite(request)) {
      console.warn(`[api] ${request.method} ${url.pathname}: refused, made by another site's page`);
      return new Response("Forbidden", { status: 403 });
    }
    return forward(request, url);
  });
}

/**
 * A request for the server made by another site's page inside the app: a frame in the web
 * app, a provider's page on a sign-in round trip. The server is reached with the app's own
 * cookies, and the Origin header is not sent on (server.ts), so the server could not tell such
 * a request from the web app's own: it is refused here. The web app's requests carry its own
 * origin, or none (a top-level load such as the desktop sign-in's exchange).
 */
function fromAnotherSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== APP_ORIGIN) return true;
  return request.headers.get("sec-fetch-site") === "cross-site";
}

/*
  A route of the SPA gets the app's empty shell, as nginx gives it on the site
  (scripts/site-routes.mjs in the web repo: APP_SHELL). Not index.html: the build writes the
  landing page into it as real HTML, which the window would paint on every load until the
  app's code replaced it. A bundle from before that pre-render has no shell; index.html is
  the app there.
*/
const APP_SHELL = path.join(RENDERER_DIR, "_html", "app.html");
const shellFile = (): string => (existsSync(APP_SHELL) ? APP_SHELL : path.join(RENDERER_DIR, "index.html"));

/** A file of the bundle, or the app's shell for a route of the SPA. */
async function serve(pathname: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const file = path.resolve(RENDERER_DIR, `.${decoded}`);
  const inside = file === RENDERER_DIR || file.startsWith(`${RENDERER_DIR}${path.sep}`);
  const exists = inside && existsSync(file) && statSync(file).isFile();
  if (!exists && path.extname(decoded)) return new Response("Not found", { status: 404 });
  const target = exists ? file : shellFile();
  const response = await net.fetch(pathToFileURL(target).toString());
  if (target.endsWith(".html")) {
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", CSP);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

/** The server's answer to an API request, with the app's cookies, addresses rewritten to the app's origin. */
async function forward(request: Request, url: URL): Promise<Response> {
  // (the [api] line's time, and a timed answer's first byte, first words and end, count from here)
  const t0 = performance.now();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  headers["x-anothernotes-client"] = CLIENT_HEADER;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
  let response: ServerResponse;
  try {
    const target = `${API_ORIGIN}${url.pathname}${url.search}`;
    response =
      request.method === "POST" && url.pathname === REFRESH_PATH
        ? await refreshOnce(() => serverRequest(target, { method: request.method, headers, body }))
        : await serverRequest(target, { method: request.method, headers, body });
  } catch (e) {
    console.warn(`[api] ${request.method} ${url.pathname}: ${(e as Error).message}`);
    // No answer at all: fail the request the way Chromium does when offline (the page's fetch
    // rejects with a TypeError), so the web app's offline handling applies - the save line's
    // "Offline - will save when you're back", a picture's "check your connection", the notes
    // writer's retry on reconnect. protocol.handle turns Response.error() into net::ERR_FAILED.
    return Response.error();
  }
  const picture = await followPicture(request.method, url.pathname, response);
  if (picture) return picture;
  console.log(`[api] ${clock()} ${request.method} ${url.pathname} -> ${response.status} ${Math.round(performance.now() - t0)} ms`);
  // The tutor's streamed answers (apiTiming.ts): a second line as the body ends, the chunks passed
  // on as they come.
  if (TIMED.test(url.pathname) && hasBodyStatus(response.status)) {
    response = { ...response, body: timeBody(response.body, `${request.method} ${url.pathname}`, t0) };
  }
  if (response.status < 400 && changesLists(request.method, url.pathname, body)) appEvents.emit("lists-changed");
  if (response.status === 200 && request.method === "GET" && UPLOAD_STATUS.test(url.pathname)) {
    response = { ...response, body: await watchUpload(response.body) };
  }
  const out = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) out.set(name, value);
  }
  // A redirect back to the site (SSO and the desktop exchange land on /auth/callback) is
  // a redirect into the bundle; one elsewhere (accounts.google.com) stays as it is.
  const location = out.get("location");
  if (location) {
    for (const origin of new Set([SITE_ORIGIN, API_ORIGIN])) {
      if (location.startsWith(`${origin}/`) && !location.startsWith(`${origin}/api/`)) {
        out.set("location", `${APP_ORIGIN}${location.slice(origin.length)}`);
      }
    }
    const callback = signInCallbackOf(out.get("location") ?? "");
    if (callback) out.set("location", `${APP_ORIGIN}${callback}`);
  }
  return new Response(hasBodyStatus(response.status) ? response.body : null, {
    status: response.status,
    statusText: response.statusText,
    headers: out,
  });
}

/*
  A checked picture (a board's, a looked up answer's) is /img/<sha256>.jpg on the server, which may
  answer with a redirect to the same path on the site's picture store. The page loads its pictures
  from the app's own origin (img-src 'self'), so it could never follow that redirect elsewhere: it
  is followed here, without cookies and no further, and the picture is the answer to the page's
  own request, as if the server had sent it. Anything else (another path, another kind of answer,
  a store that fails or sends something other than a picture) goes back to the page as it came.
  A picture only: a raster type (an SVG can carry script, and this answer is the app's own origin,
  where a document would run with the preload's bridge), marked so it is never taken for another.
*/
const PICTURE_PATH = /^\/img\/[0-9a-fA-F]{64}\.jpg$/;
const PICTURE_TYPE = /^image\/(jpeg|png|webp|gif|avif)\b/i;
const MOVED = new Set([301, 302, 307, 308]);

async function followPicture(method: string, pathname: string, response: ServerResponse): Promise<Response | null> {
  if (method !== "GET" || !PICTURE_PATH.test(pathname) || !MOVED.has(response.status)) return null;
  let target: URL;
  try {
    target = new URL(response.headers.location ?? "");
  } catch {
    return null;
  }
  if (target.protocol !== "https:" || target.pathname !== pathname) return null;
  const head = `[api] GET ${pathname} -> ${response.status} followed`;
  try {
    const fetched = await net.fetch(target.href, { credentials: "omit", redirect: "error" });
    const type = fetched.headers.get("content-type") ?? "";
    if (fetched.status !== 200 || !PICTURE_TYPE.test(type)) {
      console.warn(`${head} -> ${fetched.status} ${type || "no type"}: not a picture`);
      void fetched.body?.cancel().catch(() => undefined);
      return null;
    }
    const headers = new Headers({ "content-type": type, "x-content-type-options": "nosniff" });
    const cache = fetched.headers.get("cache-control");
    if (cache) headers.set("cache-control", cache);
    console.log(`${head} -> 200`);
    return new Response(fetched.body, { status: 200, headers });
  } catch (e) {
    console.warn(`${head}: ${(e as Error).message}`);
    return null;
  }
}

/*
  One renewal at a time, for every page. The API replaces the refresh cookie on each
  renewal and refuses the one it replaced, and it answers a refused one by signing the
  person out. Each tab is its own copy of the web app; they take turns (a lock they
  share), but a page that closes or reloads mid-renewal gives up its turn before the
  answer, and the next page would then send the cookie that is about to be replaced.
  So renewals are joined here, where they all pass: while one is on its way, another
  waits for it and gets the same answer, and one right after it gets that answer too
  (the new access token lasts minutes; the pages share it anyway).
*/
const REFRESH_PATH = "/api/auth/refresh";
const REUSE_REFRESH_MS = 5000;
interface Buffered { status: number; statusText: string; headers: Record<string, string>; body: Uint8Array }
let renewal: Promise<Buffered> | null = null;
let renewed: { at: number; answer: Buffered } | null = null;

async function refreshOnce(send: () => Promise<ServerResponse>): Promise<ServerResponse> {
  if (renewed && Date.now() - renewed.at < REUSE_REFRESH_MS) return replay(renewed.answer, "reused");
  if (renewal) return replay(await renewal, "joined");
  renewal = (async () => {
    const response = await send();
    const bytes = new Uint8Array(await new Response(response.body).arrayBuffer());
    return { status: response.status, statusText: response.statusText, headers: response.headers, body: bytes };
  })();
  try {
    const answer = await renewal;
    if (answer.status === 200) renewed = { at: Date.now(), answer };
    return replay(answer);
  } finally {
    renewal = null;
  }
}

function replay(answer: Buffered, how?: string): ServerResponse {
  if (how) console.log(`[api] POST ${REFRESH_PATH}: ${how} the renewal in progress`);
  return {
    status: answer.status,
    statusText: answer.statusText,
    headers: { ...answer.headers },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(answer.body.slice());
        controller.close();
      },
    }),
  };
}

/**
 * Whether a request changes what the web app's lists show: its sidebar, dashboard, sticky
 * wall and folders. Only these make the app refresh the pages that are out of sight; a note's
 * text being saved, a quiz answer or a lesson's audio does not.
 */
function changesLists(method: string, pathname: string, body?: Uint8Array): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if (pathname === "/api/notes") return method === "POST";
  if (/^\/api\/notes\/[^/]+$/.test(pathname)) {
    if (method === "DELETE") return true;
    if (method !== "PATCH" || !body) return false;
    try {
      return "title" in (JSON.parse(Buffer.from(body).toString("utf8")) as object);
    } catch {
      return false;
    }
  }
  if (pathname === "/api/study-sessions/create-with-ai" || pathname === "/api/study-sessions/from-youtube") {
    return method === "POST";
  }
  if (/^\/api\/study-sessions\/[^/]+$/.test(pathname)) return method === "DELETE";
  // Sticky notes: the dashboard shows the latest six, the Sticky wall page all of them.
  if (/^\/api\/sticky-notes(\/|$)/.test(pathname)) return true;
  return /^\/api\/folders(\/|$)/.test(pathname);
}

/**
 * The web app's sign-in callback (/auth/callback#…) at whatever address the API's
 * FRONTEND_URL names, as the path after it: the desktop exchange ends there, and in the
 * app that page is the bundle's. After the rename the live API still named the old site,
 * https://anothernote.app, which forwards to the new one's front page and loses the page
 * and the sign-in with it, so the path decides here, not the host.
 */
function signInCallbackOf(location: string): string | null {
  try {
    const u = new URL(location);
    return u.protocol === "https:" && u.pathname === "/auth/callback" ? `${u.pathname}${u.search}${u.hash}` : null;
  } catch {
    return null;
  }
}

/*
  An uploaded document becomes a session after the answers, not in one: the page sends the
  file in parts, says "finish", then asks GET /study-sessions/uploads/{id} until its state is
  "done" (services/uploads.ts in the web repo). That answer, the first one with the new
  session in it, is the change the lists are told about. It is a few hundred bytes of JSON,
  so it is read whole here and handed on as it came.
*/
const UPLOAD_STATUS = /^\/api\/study-sessions\/uploads\/[^/]+$/;

async function watchUpload(body: ReadableStream<Uint8Array> | null): Promise<ReadableStream<Uint8Array> | null> {
  if (!body) return body;
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  try {
    if ((JSON.parse(Buffer.from(bytes).toString("utf8")) as { state?: unknown }).state === "done") {
      appEvents.emit("lists-changed");
    }
  } catch {
    // Not JSON: nothing to learn from it.
  }
  return new Response(bytes).body;
}

const hasBodyStatus = (status: number): boolean => status !== 204 && status !== 304 && (status < 300 || status >= 400);
