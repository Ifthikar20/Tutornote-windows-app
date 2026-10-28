#!/usr/bin/env node
/*
  Build the Windows screen helper (helpers/screen-win/*.cs) into build/helpers/tutornote-screen.exe,
  with the C# compiler that comes with Windows (.NET Framework 4.8): nothing to install. The Windows
  twin of the Mac app's scripts/build-screen-helper.sh.

    npm run helper                  build it (skipped when the exe is newer than its sources)
    build/helpers/tutornote-screen.exe --selftest

  It references Windows' own API descriptions (C:\Windows\System32\WinMetadata\*.winmd) for the text
  reader, and no other library. Off Windows, or without the compiler, it says so and exits 0: the app
  then has no tutor on screen, as on a Mac without its helper.
*/
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "helpers", "screen-win");
const outDir = path.join(root, "build", "helpers");
const out = path.join(outDir, "tutornote-screen.exe");

if (process.platform !== "win32") {
  console.log("screen helper: not Windows, skipped");
  process.exit(0);
}
const windir = process.env.WINDIR || "C:\\Windows";
const fw = path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319");
const csc = path.join(fw, "csc.exe");
const winmd = path.join(windir, "System32", "WinMetadata");
if (!fs.existsSync(csc)) {
  console.log(`screen helper: no C# compiler at ${csc}, skipped`);
  process.exit(0);
}

const sources = fs.readdirSync(src).filter((f) => f.endsWith(".cs")).map((f) => path.join(src, f));
const newest = Math.max(...[...sources, fileURLToPath(import.meta.url)].map((f) => fs.statSync(f).mtimeMs));
if (fs.existsSync(out) && fs.statSync(out).mtimeMs > newest && !process.argv.includes("--force")) {
  console.log("screen helper: up to date");
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
const refs = [
  path.join(fw, "System.dll"),
  path.join(fw, "System.Core.dll"),
  path.join(fw, "System.Drawing.dll"),
  path.join(fw, "System.Web.Extensions.dll"),
  path.join(fw, "System.Runtime.dll"),
  // (for Windows.Foundation.Rect, the boxes the text reader gives, which .NET holds as its own type)
  path.join(fw, "System.Runtime.WindowsRuntime.dll"),
  ...["Foundation", "Graphics", "Media", "Security", "Storage", "Globalization"].map((n) => path.join(winmd, `Windows.${n}.winmd`)),
];
const args = [
  "-nologo",
  "-target:exe",
  "-platform:x64",
  "-optimize+",
  "-warn:4",
  `-out:${out}`,
  ...refs.map((r) => `-r:${r}`),
  ...sources,
];
const r = spawnSync(csc, args, { encoding: "utf8" });
const said = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
if (r.status !== 0) {
  console.error(said || `csc failed (exit ${r.status})`);
  process.exit(1);
}
if (said) console.log(said);
console.log(`screen helper: built ${path.relative(root, out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
