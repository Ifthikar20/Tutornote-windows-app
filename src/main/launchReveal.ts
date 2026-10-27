/*
  When the main window shows as it is made, and whether a loader (static/loading.html) comes up
  meanwhile: windows.ts createMainWindow runs this, step by step, and does what each step says.
  No Electron, so it is tested on its own (scripts/tests/launchReveal.test.ts).

  There is no minimum: the window shows the moment its first page has loaded ("loaded": the web
  app, the sign-in screen or the offline page, whichever it opened on), when the student asks for
  it ("asked": the Dock), or at SPLASH_MAX_MS ("max") whatever the page is doing. Only when none
  of that has happened SPLASH_DELAY_MS after the window was made ("delay") is the loader made,
  and it shows once it has drawn ("splash-ready") unless the window is up by then. The window
  shown any way at all ("shown": the reveal itself, the Dock, a link, a lesson) is the end of the
  loader, wherever it had got to, and nothing makes one after that.
*/

/** The loader only for a start slower than this (ms from the window being made). */
export const SPLASH_DELAY_MS = 1000;
/** The window shows by then (ms from its being made) whatever its first page is doing. */
export const SPLASH_MAX_MS = 15000;

export type LaunchEvent = "delay" | "splash-ready" | "loaded" | "asked" | "max" | "shown";
/** What windows.ts does for a step: make the loader's window (hidden), show it, close it, or show
 *  the main window (maximized if it was saved so, focused). */
export type LaunchAction = "make-splash" | "show-splash" | "close-splash" | "show-window";

export interface LaunchState {
  /** The main window is up (or on its way up): no loader from now on. */
  revealed: boolean;
  /** The loader: none made, made and drawing (hidden), up, or closed. */
  splash: "none" | "making" | "up" | "gone";
}

export const LAUNCH_START: LaunchState = { revealed: false, splash: "none" };

/** One step: the state after `event`, and what to do for it, in order. */
export function launchStep(state: LaunchState, event: LaunchEvent): { state: LaunchState; actions: LaunchAction[] } {
  const splashLive = state.splash === "making" || state.splash === "up";
  switch (event) {
    case "delay":
      if (state.revealed || state.splash !== "none") return { state, actions: [] };
      return { state: { ...state, splash: "making" }, actions: ["make-splash"] };
    case "splash-ready":
      if (state.splash !== "making") return { state, actions: [] };
      return state.revealed
        ? { state: { ...state, splash: "gone" }, actions: ["close-splash"] }
        : { state: { ...state, splash: "up" }, actions: ["show-splash"] };
    case "loaded":
    case "asked":
    case "max":
      if (state.revealed) return { state, actions: [] };
      // (the window first, then the loader goes: no moment with neither on screen)
      return {
        state: { revealed: true, splash: splashLive ? "gone" : state.splash },
        actions: splashLive ? ["show-window", "close-splash"] : ["show-window"],
      };
    case "shown":
      return { state: { revealed: true, splash: splashLive ? "gone" : state.splash }, actions: splashLive ? ["close-splash"] : [] };
  }
}
