#!/usr/bin/env node
/*
  Make a Windows release on this laptop: check, build, and check what was built. It touches no
  server and uploads nothing; the last lines say which command puts the release on the site.

    TUTORNOTE_WEB_REF=<web commit> npm run release              the whole release
    TUTORNOTE_WEB_REF=<web commit> npm run release -- --check   only the checks: nothing is built or written
    ... -- --require-signed    stop when the build would be unsigned
    ... -- --skip-renderer     keep renderer/ as it is (it must already be that web commit's build)
    ... -- --rebuild           build the version the release folder already holds once more
                               (only while that build has never been uploaded)

  The steps, each stopping with what to do:
    1. The checks. No uncommitted change to a tracked file, and no file git has never seen in
       src/, static/, helpers/ or build/ (they go into the app); the version is plain n.n.n, the same
       in package-lock.json, and above the one the release folder's latest.yml names; the app
       talks to app.tutornote.ai and keeps a browser sign-in's session (the two things 1.0.1 is
       for); the update feed is still https://tutornote.ai/downloads/windows/, the address every
       installed app asks; TUTORNOTE_WEB_REF names a commit of tutornote-web that is on
       origin/feature/october, so only pushed web code goes into an app; signed or unsigned.
    2. npm run typecheck, npm test.
    3. The web app's bundle from that commit (scripts/build-renderer.mjs), into renderer/.
    4. npm run dist: the installer, its blockmap and latest.yml, in the release folder
       (%LOCALAPPDATA%\tutornote-build\release, or TUTORNOTE_RELEASE_DIR; outside OneDrive).
    5. The three files agree: latest.yml names this version and this installer, with the
       installer's own size and SHA-512, and the app inside asks the feed above for updates.

  Signed only when ~/.anothernote/windows-signing.env is there (electron-builder.config.cjs
  reads it); without it the release is unsigned, as 1.0.0 was.

  TUTORNOTE_WEB_DIR names a web checkout somewhere else, as for `npm run renderer`. The tests live
  in Tutornote_test_suite: the ones scripts/tests lacks are copied from the checkout beside this
  repo (TUTORNOTE_SUITE_DIR for another place), never over a file that is there.
*/
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The address every installed app asks for updates. It never moves: 1.0.0 knows no other. */
export const FEED_URL = "https://tutornote.ai/downloads/windows/";
/** Web code goes into an app only once it is on this branch of the web repo's origin. */
export const PUBLISHED_BRANCH = "origin/feature/october";
/** The installer's file name (electron-builder.config.cjs artifactName; the site serves only this shape). */
export const installerName = (version) => `Tutornote-Setup-${version}.exe`;

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
const lf = (text) => String(text ?? "").replace(/\r\n/g, "\n");
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, "$2");

/** Which of two plain versions is later: below zero, zero, or above zero. */
export function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** latest.yml as electron-builder writes it: the version, the installer's name, its SHA-512, and
 *  the files list (each with its own name, SHA-512 and size). Missing lines come back as null. */
export function readFeed(text) {
  const lines = lf(text).split("\n");
  const top = (name) => {
    for (const line of lines) {
      const m = new RegExp(`^${name}:\\s*(.+)$`).exec(line);
      if (m) return unquote(m[1]);
    }
    return null;
  };
  const files = [];
  for (const line of lines) {
    const start = /^\s+-\s+url:\s*(.+)$/.exec(line);
    if (start) {
      files.push({ url: unquote(start[1]), sha512: null, size: null });
      continue;
    }
    const field = /^\s+(sha512|size):\s*(.+)$/.exec(line);
    if (field && files.length) {
      const file = files[files.length - 1];
      if (field[1] === "size") file.size = Number(unquote(field[2]));
      else file.sha512 = unquote(field[2]);
    }
  }
  return { version: top("version"), path: top("path"), sha512: top("sha512"), files };
}

/**
 * What stops a release before anything is built, as plain sentences (none: go ahead).
 *   pkg, lock    package.json and package-lock.json, parsed
 *   sources      { config, server, builder }: the text of src/main/config.ts, src/main/server.ts
 *                and electron-builder.config.cjs
 *   feedText     the release folder's latest.yml from the release before, or null when none
 *   rebuild      true to allow the very version the release folder already holds
 */
export function preflightProblems({ pkg, lock, sources, feedText = null, rebuild = false }) {
  const problems = [];
  const version = String(pkg?.version ?? "");
  const plain = PLAIN_VERSION.test(version);
  if (!plain) {
    problems.push(
      `package.json's version is "${version}": a release is plain n.n.n. The site serves only ` +
        `Tutornote-Setup-<n.n.n>.exe, and a name like 1.0.1-beta.1 makes installed apps ask for another feed.`,
    );
  }
  const lockTop = lock?.version;
  const lockRoot = lock?.packages?.[""]?.version;
  if (lockTop !== version || lockRoot !== version) {
    problems.push(
      `package-lock.json says ${lockTop ?? "nothing"} (and ${lockRoot ?? "nothing"} for the app itself) where package.json ` +
        `says ${version}: set the version with \`npm version ${plain ? version : "<n.n.n>"} --no-git-tag-version\`.`,
    );
  }
  if (feedText !== null && feedText !== undefined) {
    const before = readFeed(feedText).version;
    if (!before || !PLAIN_VERSION.test(before)) {
      problems.push(`The release folder's latest.yml names no plain version (${before ?? "none"}): move that file aside and try again.`);
    } else if (plain && compareVersions(version, before) < 0) {
      problems.push(`The release folder already holds ${before}, which is later than ${version}: installed apps never go back. Raise the version.`);
    } else if (plain && compareVersions(version, before) === 0 && !rebuild) {
      problems.push(
        `The release folder already holds ${before}: raise the version in package.json first. ` +
          `(To build ${version} once more because it was never uploaded, pass --rebuild.)`,
      );
    }
  }
  const config = lf(sources?.config);
  if (!config.includes(`const DEFAULT_SITE = "https://app.tutornote.ai";`)) {
    problems.push(`src/main/config.ts: DEFAULT_SITE is not "https://app.tutornote.ai", so this build would not talk to the application's own name.`);
  }
  if (!config.includes(`const DEFAULT_WEBSITE = "https://tutornote.ai";`)) {
    problems.push(`src/main/config.ts: DEFAULT_WEBSITE is not "https://tutornote.ai", so the terms, the privacy page and the website link would open in the wrong place.`);
  }
  if (!lf(sources?.server).includes("useSessionCookies: jarCookies")) {
    problems.push(`src/main/server.ts has no \`useSessionCookies: jarCookies\`: without it a browser sign-in ends signed out, and this release signs every PC out once.`);
  }
  const publish = /publish:\s*\{\s*provider:\s*"generic",\s*url:\s*"([^"]*)"\s*\}/.exec(lf(sources?.builder));
  if (!publish || publish[1] !== FEED_URL) {
    problems.push(
      `electron-builder.config.cjs: the update feed is ${publish ? publish[1] : "not named"}, not ${FEED_URL}. ` +
        `It must stay that address, or the apps already installed never find this release.`,
    );
  }
  return problems;
}

/**
 * What is wrong with a finished release folder, as plain sentences (none: it is good to upload).
 *   feedText     the new latest.yml, or null when the build wrote none
 *   version      package.json's version
 *   files        { "<name>": { size, sha512 } } for each file that is there (fileFacts)
 *   updateText   win-unpacked/resources/app-update.yml: left out = not checked, null = missing
 */
export function feedProblems({ feedText, version, files, updateText }) {
  const problems = [];
  const exe = installerName(version);
  const blockmap = `${exe}.blockmap`;
  const have = files ?? {};
  if (feedText === null || feedText === undefined) {
    problems.push("The build wrote no latest.yml: installed apps would never hear of this release.");
  } else {
    const feed = readFeed(feedText);
    if (feed.version !== version) problems.push(`latest.yml says version ${feed.version ?? "nothing"}, not ${version}.`);
    if (feed.path !== exe) problems.push(`latest.yml names ${feed.path ?? "no installer"}, not ${exe}.`);
    const listed = feed.files.find((file) => file.url === exe);
    if (!listed) problems.push(`latest.yml's files list has no ${exe}.`);
    const fact = have[exe];
    if (fact) {
      if (feed.sha512 !== fact.sha512 || (listed && listed.sha512 !== fact.sha512)) {
        problems.push(`latest.yml's SHA-512 is not ${exe}'s own: an installed app would refuse the download.`);
      }
      if (listed && listed.size !== fact.size) {
        problems.push(`latest.yml says ${listed.size ?? "no"} bytes where ${exe} has ${fact.size}.`);
      }
    }
  }
  if (!have[exe]) problems.push(`${exe} is not in the release folder.`);
  if (!have[blockmap]) problems.push(`${blockmap} is not in the release folder: the upload needs it beside the installer.`);
  if (updateText !== undefined) {
    const named = updateText === null ? null : /^url:\s*(.+)$/m.exec(lf(updateText));
    if (!named || unquote(named[1]) !== FEED_URL) {
      problems.push(
        `The app inside the installer asks ${named ? unquote(named[1]) : "no address"} for updates ` +
          `(win-unpacked/resources/app-update.yml), not ${FEED_URL}.`,
      );
    }
  }
  return problems;
}

/** Each named file that is in the folder, with its size and its SHA-512 the way latest.yml writes
 *  it (base64). Read in pieces: the installer is over a hundred megabytes. */
export function fileFacts(dir, names) {
  const facts = {};
  const piece = Buffer.alloc(1024 * 1024);
  for (const name of names) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const hash = createHash("sha512");
    const fd = fs.openSync(file, "r");
    let size = 0;
    try {
      for (;;) {
        const n = fs.readSync(fd, piece, 0, piece.length, null);
        if (n === 0) break;
        hash.update(piece.subarray(0, n));
        size += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    facts[name] = { size, sha512: hash.digest("base64") };
  }
  return facts;
}

/* ---- the run itself: everything below reads the machine, and only from `main` ---- */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const say = (line) => console.log(`==> ${line}`);

function stop(lines) {
  for (const line of [].concat(lines)) console.error(line);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  // npm is npm.cmd on Windows, which only runs through a shell; its arguments here are this
  // script's own constants, so they go as one command line (scripts/build-renderer.mjs).
  const viaShell = process.platform === "win32" && cmd === "npm";
  const r = viaShell
    ? spawnSync([cmd, ...args].join(" "), { stdio: "inherit", shell: true, cwd: root, ...opts })
    : spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) stop(`${cmd} ${args.join(" ")} failed (exit ${r.status ?? r.signal}). Nothing was uploaded; fix it and run the release again.`);
}

/** A git answer, or null when git refuses. --no-optional-locks: a check never writes, not even
 *  the index's own bookkeeping. */
function git(dir, ...args) {
  const r = spawnSync("git", ["--no-optional-locks", "-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trimEnd() : null;
}

const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

/** The folders a build takes whole: src/ is compiled, helpers/ is built into the screen helper,
 *  static/ and build/ are packaged as they stand. A file there goes into the app, tracked or not. */
const BUILT_FOLDERS = /^(src|static|helpers|build)\//;

/** Where electron-builder writes (electron-builder.config.cjs: the same rule). */
const releaseDirOf = () =>
  path.resolve(
    process.env.TUTORNOTE_RELEASE_DIR ||
      path.join(process.env.LOCALAPPDATA || path.join(root, ".."), "tutornote-build", "release"),
  );

/** Signed or not, from the laptop's own file of NAME=value lines (no secret is in it). */
function signingState() {
  const usual = path.join(os.homedir(), ".anothernote", "windows-signing.env");
  const file = process.env.TUTORNOTE_SIGNING_FILE || usual;
  const shown = file === usual ? "~/.anothernote/windows-signing.env" : file;
  if (!fs.existsSync(file)) return { signed: false, shown, missing: [], publisher: null };
  const value = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^TUTORNOTE_SIGN_([A-Z]+)=(.+)$/.exec(line.trim());
    if (m) value[m[1]] = m[2].trim();
  }
  const missing = ["ENDPOINT", "ACCOUNT", "PROFILE", "PUBLISHER"].filter((name) => !value[name]);
  return { signed: true, shown, missing, publisher: value.PUBLISHER ?? null };
}

/** The test files `npm test` names that scripts/tests lacks, and where the suite keeps them. */
function missingTests(pkg) {
  const named = String(pkg?.scripts?.test ?? "").match(/scripts\/tests\/\S+/g) ?? [];
  const missing = named.map((rel) => path.basename(rel)).filter((name) => !fs.existsSync(path.join(root, "scripts", "tests", name)));
  const suite = path.resolve(process.env.TUTORNOTE_SUITE_DIR || path.join(root, "..", "Tutornote_test_suite", "windows-app"));
  return { missing, suite, inSuite: missing.every((name) => fs.existsSync(path.join(suite, name))) };
}

function usage() {
  console.log(
    [
      "TUTORNOTE_WEB_REF=<web commit> node scripts/release.mjs [--check] [--require-signed] [--skip-renderer] [--rebuild]",
      "  --check           only the checks: nothing is built, nothing is written",
      "  --require-signed  stop when the build would be unsigned",
      "  --skip-renderer   keep renderer/ as it is (it must be that web commit's build)",
      "  --rebuild         build the version the release folder already holds once more",
    ].join("\n"),
  );
}

function main() {
  const flags = new Set(process.argv.slice(2));
  if (flags.has("--help") || flags.has("-h")) return usage();
  const known = ["--check", "--require-signed", "--skip-renderer", "--rebuild"];
  const unknown = [...flags].filter((flag) => !known.includes(flag));
  if (unknown.length) {
    usage();
    stop(`Unknown option: ${unknown.join(" ")}`);
  }
  const checkOnly = flags.has("--check");

  // 1. The checks. Every problem is gathered, so one run names them all.
  say("checking (nothing is built yet)");
  const pkg = JSON.parse(readText(path.join(root, "package.json")) ?? "{}");
  const lock = JSON.parse(readText(path.join(root, "package-lock.json")) ?? "{}");
  const version = String(pkg.version ?? "");
  const releaseDir = releaseDirOf();
  const problems = preflightProblems({
    pkg,
    lock,
    sources: {
      config: readText(path.join(root, "src", "main", "config.ts")),
      server: readText(path.join(root, "src", "main", "server.ts")),
      builder: readText(path.join(root, "electron-builder.config.cjs")),
    },
    feedText: readText(path.join(releaseDir, "latest.yml")),
    rebuild: flags.has("--rebuild"),
  });

  if (process.platform !== "win32") problems.push("A Windows release is built on Windows: run this on the Windows laptop.");

  // What git holds is what is built: no change to a tracked file, and no file git has never seen
  // in a folder the build takes whole (BUILT_FOLDERS). Ignored files (node_modules, renderer/,
  // build/helpers, the tests) are not listed, and a stray file anywhere else does not matter.
  const status = git(root, "status", "--porcelain", "--untracked-files=all");
  if (status === null) problems.push(`${root} is not a git checkout: a release is built from committed work only.`);
  else {
    const lines = status ? status.split("\n") : [];
    const few = (names) => `${names.slice(0, 4).join(", ")}${names.length > 4 ? ", ..." : ""}`;
    const changed = lines.filter((line) => !line.startsWith("??")).map((line) => line.slice(3));
    const stray = lines
      .filter((line) => line.startsWith("??"))
      .map((line) => line.slice(3).replace(/^"/, ""))
      .filter((name) => BUILT_FOLDERS.test(name));
    if (changed.length) problems.push(`Uncommitted changes in this repo (${few(changed)}): commit them first, so the release is what git holds.`);
    if (stray.length) {
      problems.push(`Files git does not hold would go into the build (${few(stray)}): commit them or move them out of the repo first.`);
    }
  }
  const appCommit = git(root, "rev-parse", "--short", "HEAD") ?? "unknown";

  if (!fs.existsSync(path.join(root, "node_modules", "typescript")) || !fs.existsSync(path.join(root, "node_modules", "electron-builder"))) {
    problems.push("node_modules is missing or incomplete here: run `npm ci` in this repo first.");
  }

  const tests = missingTests(pkg);
  if (tests.missing.length && !tests.inSuite) {
    problems.push(
      `${tests.missing.length} of the tests npm test names are not in scripts/tests (first: ${tests.missing[0]}) and not in ${tests.suite}: ` +
        "run `python sync.py --to-apps` in Tutornote_test_suite, or name its windows-app folder in TUTORNOTE_SUITE_DIR.",
    );
  }

  // The web commit that goes inside the app: named, a commit, and pushed.
  const webDir = path.resolve(process.env.TUTORNOTE_WEB_DIR || path.join(root, "..", "tutornote-web"));
  const ref = (process.env.TUTORNOTE_WEB_REF ?? "").trim();
  let webSha = null;
  let webShort = null;
  if (!fs.existsSync(path.join(webDir, "package.json"))) {
    problems.push(`No web app at ${webDir}: name the tutornote-web checkout in TUTORNOTE_WEB_DIR.`);
  } else {
    if (!ref) {
      problems.push(
        "TUTORNOTE_WEB_REF is not set: name the web commit that goes inside this release (the one that is live), " +
          "for example TUTORNOTE_WEB_REF=1a2b3c4 npm run release.",
      );
    } else if (!/^[0-9a-f]{7,40}$/i.test(ref)) {
      problems.push(`TUTORNOTE_WEB_REF is "${ref}": name a commit by its id (7 to 40 hex characters), not a branch. A branch moves; a release must say exactly what is inside it.`);
    } else {
      webSha = git(webDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
      if (!webSha) {
        problems.push(`The web checkout at ${webDir} has no commit ${ref}: run \`git fetch\` there, or check the id.`);
      } else {
        webShort = git(webDir, "rev-parse", "--short", webSha) ?? webSha.slice(0, 7);
        const branches = (git(webDir, "branch", "-r", "--contains", webSha) ?? "").split("\n").map((line) => line.trim());
        if (!branches.includes(PUBLISHED_BRANCH)) {
          problems.push(
            `Web commit ${webShort} is not on ${PUBLISHED_BRANCH} as the web checkout knows it: push it first ` +
              "(or run `git fetch` in the web checkout). Only pushed web code goes into an app.",
          );
        }
      }
    }
    if (!fs.existsSync(path.join(webDir, ".env.off"))) {
      problems.push(`${path.join(webDir, ".env.off")} is missing: copy .env.off.example to .env.off in the web checkout first (or name a checkout that has it in TUTORNOTE_WEB_DIR).`);
    }
  }

  const signing = signingState();
  if (signing.signed && signing.missing.length) {
    problems.push(`${signing.shown} has no ${signing.missing.map((name) => `TUTORNOTE_SIGN_${name}`).join(", ")}: the build would stop at signing.`);
  }
  if (!signing.signed && flags.has("--require-signed")) {
    problems.push(`--require-signed: there is no ${signing.shown}, so this build would be unsigned.`);
  }

  const signedLine = signing.signed ? `signed as ${signing.publisher ?? "(no publisher named)"}` : `UNSIGNED: no ${signing.shown}`;
  say(`Tutornote ${version} for Windows, app commit ${appCommit}, web commit ${webShort ?? "(not named)"}`);
  say(signedLine);
  say(`release folder: ${releaseDir}`);
  if (problems.length) {
    stop([`Not ready: ${problems.length} thing${problems.length === 1 ? "" : "s"} to put right first.`, ...problems.map((line) => `  - ${line}`)]);
  }
  if (checkOnly) {
    say(`ready to build ${version}. Nothing was built. Run it again without --check to build.`);
    return;
  }

  // 2. The code is sound.
  if (tests.missing.length) {
    say(`copying ${tests.missing.length} test${tests.missing.length === 1 ? "" : "s"} from ${tests.suite}`);
    fs.mkdirSync(path.join(root, "scripts", "tests"), { recursive: true });
    for (const name of tests.missing) fs.copyFileSync(path.join(tests.suite, name), path.join(root, "scripts", "tests", name), fs.constants.COPYFILE_EXCL);
  }
  say("type check and tests");
  run("npm", ["run", "typecheck"]);
  run("npm", ["test"]);

  // 3. The web app's bundle, from the named commit.
  if (flags.has("--skip-renderer")) say("keeping renderer/ as it is (--skip-renderer)");
  else {
    say(`building the web app's bundle from ${webShort}`);
    run(process.execPath, [path.join(root, "scripts", "build-renderer.mjs")], {
      env: { ...process.env, TUTORNOTE_WEB_REF: webSha, TUTORNOTE_WEB_DIR: webDir },
    });
  }
  // renderer/BUILD starts with the commit's short id (scripts/build-renderer.mjs). Its length is
  // git's choice on the day it was written, so it is matched as the start of the full id.
  const built = (readText(path.join(root, "renderer", "BUILD")) ?? "").trim();
  const builtSha = built.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{7,40}$/.test(builtSha) || !webSha.startsWith(builtSha)) {
    stop(`renderer/ is ${built || "not built"}, not web commit ${webShort}: run the release again without --skip-renderer.`);
  }
  if (!fs.existsSync(path.join(root, "renderer", "index.html"))) {
    stop("renderer/index.html is missing: without it the app would load the site in its window instead of its own bundle.");
  }

  // 4. The installer.
  say("packaging (npm run dist)");
  run("npm", ["run", "dist"]);

  // 5. What was built is what the feed says.
  say("checking the release folder");
  const exe = installerName(version);
  const names = [exe, `${exe}.blockmap`];
  const facts = fileFacts(releaseDir, names);
  const wrong = feedProblems({
    feedText: readText(path.join(releaseDir, "latest.yml")),
    version,
    files: facts,
    updateText: readText(path.join(releaseDir, "win-unpacked", "resources", "app-update.yml")),
  });
  if (wrong.length) stop(["The build finished, but the release is not right. Do not upload it.", ...wrong.map((line) => `  - ${line}`)]);

  // 6. What to do next. Nothing here goes near a server.
  const megabytes = Math.round(facts[exe].size / (1024 * 1024));
  console.log("");
  say(`Tutornote ${version} is built (${signedLine}).`);
  console.log(`    folder:  ${releaseDir}`);
  console.log(`    files:   ${exe}  (${megabytes} MB, ${facts[exe].size} bytes)`);
  console.log(`             ${exe}.blockmap`);
  console.log("             latest.yml");
  console.log(`    inside:  app commit ${appCommit}, web commit ${webShort}`);
  console.log(`    for the Download page:  version ${version}, size "${megabytes} MB", /downloads/windows/${exe}`);
  console.log("");
  console.log("Nothing was uploaded. To put it on the site, in tutornote-web:");
  console.log(`    ./deploy-aws.sh --windows-release-only="${releaseDir.replace(/\\/g, "/")}"`);
  console.log("The installer and its blockmap go up first and latest.yml last, so no app is told of a file that is not there yet.");
}

const asScript = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (asScript) main();
