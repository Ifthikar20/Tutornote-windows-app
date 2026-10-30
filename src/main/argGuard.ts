/*
  Chromium command-line switches that would let another program on the machine instrument a
  packaged app: open a debugging port into its origin, run its subprocesses under a chosen command,
  send its traffic through a proxy, or make it accept bad certificates. The fuses cover the
  equivalent environment variables (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect) but not these
  switches, so index.ts refuses to start a packaged build when any is present (WHAT_TO_FIX.md
  WIN-03 / MAC-03). A development build keeps them.

  The list and the check are pure here so they can be tested without Electron
  (scripts/tests/argGuard.test.ts).
*/

export const FORBIDDEN_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "remote-allow-origins",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "inspect-publish-uid",
  "js-flags",
  "proxy-server",
  "proxy-pac-url",
  "host-rules",
  "host-resolver-rules",
  "ignore-certificate-errors",
  "ignore-certificate-errors-spki-list",
  "disable-web-security",
  "user-data-dir",
  "renderer-cmd-prefix",
  "gpu-launcher",
  "utility-cmd-prefix",
  "browser-subprocess-path",
] as const;

/** The first forbidden switch that `has` reports present, or null when none is. */
export function offendingSwitch(has: (name: string) => boolean): string | null {
  for (const name of FORBIDDEN_SWITCHES) {
    if (has(name)) return name;
  }
  return null;
}
