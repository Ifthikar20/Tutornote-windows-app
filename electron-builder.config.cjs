/*
  How the app is packaged. `npm run dist` gives Tutornote-Setup-<version>.exe: a one-click
  installer that installs for this Windows user only (no admin, no UAC prompt) into
  %LOCALAPPDATA%\Programs\Tutornote, with Start menu and desktop shortcuts and its own
  uninstaller. `npm run pack` gives the unpacked app (win-unpacked\Tutornote.exe) for a quick look.

  The output goes outside OneDrive (%LOCALAPPDATA%\tutornote-build\release, or
  TUTORNOTE_RELEASE_DIR): the repo lives in a synced folder, and OneDrive locking files
  mid-build breaks packaging, as iCloud does on the Mac.

  Signed through Azure Artifact Signing once ~/.anothernote/windows-signing.env names the account
  (signingOptions below: the founder's, never in this repo). Without that file the build is
  unsigned, as 1.0.0 was: Windows then shows "Windows protected your PC" on first run, and an
  antivirus may refuse the file. With it, a file that can't be signed stops the build, so a
  release never goes out half signed. The sign-in is `az login` on this machine, so no key is kept.

  Updates come from the site: latest.yml beside the installer goes up with the web deploy's
  --windows-release, and the app reads it (src/main/updater.ts). A signed build also writes the
  publisher into the app, and electron-updater then refuses an update signed by anyone else.
*/
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const releaseDir =
  process.env.TUTORNOTE_RELEASE_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(__dirname, ".."), "tutornote-build", "release");

// The screen helper (helpers/screen-win, scripts/build-screen-helper.mjs): reads another app's
// window for the tutor on screen (src/main/screen.ts). Packaged next to the app when it was built.
const screenHelper = path.join(__dirname, "build", "helpers", "tutornote-screen.exe");
const hasScreenHelper = fs.existsSync(screenHelper);

/** Azure Artifact Signing, from the laptop's own file of NAME=value lines (no secret in it):
 *  TUTORNOTE_SIGN_ENDPOINT, _ACCOUNT, _PROFILE and _PUBLISHER, the name on the certificate exactly.
 *  TUTORNOTE_SIGNING_FILE points at another file. */
function signingOptions() {
  const file = process.env.TUTORNOTE_SIGNING_FILE || path.join(os.homedir(), ".anothernote", "windows-signing.env");
  if (!fs.existsSync(file)) return null;
  const value = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^TUTORNOTE_SIGN_([A-Z]+)=(.+)$/.exec(line.trim());
    if (m) value[m[1]] = m[2].trim();
  }
  for (const name of ["ENDPOINT", "ACCOUNT", "PROFILE", "PUBLISHER"]) {
    if (!value[name]) throw new Error(`${file} has no TUTORNOTE_SIGN_${name}`);
  }
  return {
    endpoint: value.ENDPOINT,
    codeSigningAccountName: value.ACCOUNT,
    certificateProfileName: value.PROFILE,
    publisherName: value.PUBLISHER,
  };
}
const signing = signingOptions();
// The signing module is PowerShell, which Windows' default policy won't load. This build's own
// PowerShell may, for its run only: the machine's policy stays as it is.
if (signing) process.env.PSExecutionPolicyPreference = "RemoteSigned";

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
  // tutornote:// is the sign-in link's scheme; anothernotes:// only until the web's /desktop/sign-in names it
  // everywhere (src/main/auth.ts LEGACY_PROTOCOL).
  protocols: { name: "Tutornote", schemes: ["tutornote", "anothernotes"] },
  publish: { provider: "generic", url: "https://tutornote.ai/downloads/windows/" },
  forceCodeSigning: Boolean(signing),
  // electron-builder signs resources/ only under app.asar.unpacked, so the helper beside it asks.
  ...(signing && hasScreenHelper
    ? { afterPack: (context) => context.packager.signIf(path.join(context.appOutDir, "resources", "tutornote-screen.exe")) }
    : {}),
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.png",
    requestedExecutionLevel: "asInvoker",
    artifactName: "Tutornote-Setup-${version}.${ext}",
    ...(signing ? { azureSignOptions: signing } : {}),
    ...(hasScreenHelper ? { extraResources: [{ from: screenHelper, to: "tutornote-screen.exe" }] } : {}),
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
