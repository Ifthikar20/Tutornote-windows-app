import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { devValue } from "./env";

/**
 * An override read from the environment, honoured only in a development build; a packaged app
 * ignores it, so another program on the machine cannot repoint the app by setting one
 * (env.ts; WHAT_TO_FIX.md WIN-02 / MAC-02).
 */
const envOverride = (name: string): string | undefined => devValue(process.env[name], app.isPackaged);

/**
 * Where the web app and its API live: tutornote.ai, or ANOTHERNOTES_URL for a test
 * server or a local build (http://100.49.56.40/, http://localhost:8080).
 */
const DEFAULT_SITE = "https://tutornote.ai";

function resolveSite(): URL {
  const override = envOverride("ANOTHERNOTES_URL");
  if (override) {
    try {
      return new URL(override);
    } catch {
      console.warn(`[anothernotes] ignoring invalid ANOTHERNOTES_URL: ${override}`);
    }
  }
  return new URL(DEFAULT_SITE);
}

/**
 * A URL's origin as scheme://host. The URL parser reports "null" as the origin of a
 * custom scheme like app://anothernotes, so every same-origin check goes through this.
 * Throws on an invalid URL, like `new URL`.
 */
export function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

const SITE = resolveSite();
/** The server: the web app's pages in the first version, and always its API. */
export const SITE_ORIGIN = SITE.origin;
export const WEBSITE_URL = DEFAULT_SITE;

/**
 * The bundled renderer: the web app's production build, copied into renderer/ by
 * scripts/build-renderer.sh and packaged with the app. When it is there, the window loads
 * the interface from the app's own scheme, app://anothernotes, and only the API calls go
 * to the server (renderer.ts serves the files and proxies /api). When it is missing, a
 * checkout without the build, the window loads the site itself, as the first version did.
 * ANOTHERNOTES_SITE=1 forces that even with the bundle present.
 */
export const APP_SCHEME = "app";
export const RENDERER_DIR = path.join(app.getAppPath(), "renderer");
export const BUNDLED = envOverride("ANOTHERNOTES_SITE") !== "1" && existsSync(path.join(RENDERER_DIR, "index.html"));
export const APP_ORIGIN = BUNDLED ? `${APP_SCHEME}://anothernotes` : SITE_ORIGIN;
/** The first page for a signed-in user. */
export const APP_URL = `${APP_ORIGIN}${!BUNDLED && SITE.pathname !== "/" ? SITE.pathname : "/dashboard"}`;

/**
 * The API: the server's /api. ANOTHERNOTES_API_URL points at another backend, e.g. a
 * local one (http://localhost:8010/api) while the pages come from a dev server.
 */
function resolveApiUrl(): string {
  const override = envOverride("ANOTHERNOTES_API_URL");
  if (override) {
    try {
      return new URL(override).toString().replace(/\/$/, "");
    } catch {
      console.warn(`[anothernotes] ignoring invalid ANOTHERNOTES_API_URL: ${override}`);
    }
  }
  return `${SITE_ORIGIN}/api`;
}

export const API_URL = resolveApiUrl();
export const API_ORIGIN = new URL(API_URL).origin;

/**
 * Server paths the bundled renderer reaches through its own origin: the API, the
 * approved pictures (/img, served by nginx next to the API), a session's PDF behind its
 * signed link (/files, which nginx checks) and the health check. renderer.ts forwards
 * them to the server; everything else is a file of the bundle.
 */
export const PROXIED_PATHS = ["/api", "/img", "/files", "/health"];

/**
 * The site's maintenance gate: nginx answers "Back soon" (503) unless the an_preview
 * cookie holds the team key. The app keeps its own cookie jar, so it sets that cookie
 * itself from ANOTHERNOTES_PREVIEW_KEY. Once set it lives in the app's profile for 30
 * days, so the variable is needed on one launch, not every launch.
 */
export const PREVIEW_KEY = (envOverride("ANOTHERNOTES_PREVIEW_KEY") ?? "").trim();
export const PREVIEW_COOKIE = "an_preview";

/** The refresh cookie the identity API sets, scoped to /api/auth/: present means signed in. */
export const SESSION_COOKIE = "an_refresh";
export const SESSION_COOKIE_URL = `${API_URL}/auth/refresh`;

/** Sent on every request to the server so the API can tell the desktop apart. */
export const CLIENT_HEADER = `desktop/${app.getVersion()} (${process.platform})`;
