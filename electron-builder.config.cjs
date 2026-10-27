/*
  How the app is packaged. `npm run dist` gives Tutornote-Setup-<version>.exe: a one-click
  installer that installs for this Windows user only (no admin, no UAC prompt) into
  %LOCALAPPDATA%\Programs\Tutornote, with Start menu and desktop shortcuts and its own
  uninstaller. `npm run pack` gives the unpacked app (win-unpacked\Tutornote.exe) for a quick look.

  The output goes outside OneDrive (%LOCALAPPDATA%\tutornote-build\release, or
  TUTORNOTE_RELEASE_DIR): the repo lives in a synced folder, and OneDrive locking files
  mid-build breaks packaging, as iCloud does on the Mac.

  Not signed yet, and no update feed yet: both wait on decisions (a signing account; where the
  installer's updates are served from, since this repo is private). Until then Windows shows
  "Windows protected your PC" on first run (More info, Run anyway), and updates are a new
  installer run over the old one.
*/
const path = require("node:path");

const releaseDir =
  process.env.TUTORNOTE_RELEASE_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(__dirname, ".."), "tutornote-build", "release");

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "app.tutornote.desktop",
  productName: "Tutornote",
  copyright: "Copyright © 2026 Tutornote",
  directories: {
    output: releaseDir,
    buildResources: "build",
  },
  files: ["dist/**/*", "static/**/*", "renderer/**/*", "package.json"],
  asar: true,
  // Electron's own switches, burnt into the binary, as on the Mac: no running the app's code as
  // plain Node (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect), the cookie store (the refresh cookie
  // among it) encrypted on disk (on Windows with a DPAPI key, as Chrome does; one-way), the app's
  // code checked when it loads and only ever app.asar. The file:// privileges stay: the app's own
  // screens (static/: the tab bar, the loading screen, sign-in, offline) are file:// pages.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: true,
  },
  // The link that brings a browser sign-in back into the app (src/main/auth.ts). The NSIS
  // installer does not write it; the app registers itself on every start
  // (app.setAsDefaultProtocolClient), the same scheme as the Mac app until both move together.
  protocols: { name: "Tutornote", schemes: ["anothernotes"] },
  publish: null,
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.png",
    requestedExecutionLevel: "asInvoker",
    artifactName: "Tutornote-Setup-${version}.${ext}",
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    shortcutName: "Tutornote",
    uninstallDisplayName: "Tutornote",
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
  },
};
