import { test } from "node:test";
import assert from "node:assert/strict";
import { LAUNCH_START, launchStep, SPLASH_DELAY_MS, SPLASH_MAX_MS, type LaunchAction, type LaunchEvent, type LaunchState } from "../../src/main/launchReveal.ts";

/*
  When the main window shows as it is made, and whether the loader comes up meanwhile
  (src/main/launchReveal.ts). Each case plays a launch as windows.ts would: the events in the
  order they come, and every action asked for on the way. "shown" follows every "show-window",
  as the window's own "show" event does.
*/

function play(events: LaunchEvent[]): { state: LaunchState; actions: LaunchAction[] } {
  let state = LAUNCH_START;
  const actions: LaunchAction[] = [];
  const run = (event: LaunchEvent): void => {
    const step = launchStep(state, event);
    state = step.state;
    for (const action of step.actions) {
      actions.push(action);
      if (action === "show-window") run("shown");
    }
  };
  for (const event of events) run(event);
  return { state, actions };
}

test("no minimum and no intro: the loader only after a second, the window by 15 s", () => {
  assert.equal(SPLASH_DELAY_MS, 1000);
  assert.equal(SPLASH_MAX_MS, 15000);
});

test("loaded within a second: the window shows, and no loader is ever made", () => {
  const { state, actions } = play(["loaded", "delay", "max"]);
  assert.deepEqual(actions, ["show-window"]);
  assert.deepEqual(state, { revealed: true, splash: "none" });
});

test("loaded after a second: the loader is made, shows once drawn, and goes as the window shows", () => {
  const { state, actions } = play(["delay", "splash-ready", "loaded", "max"]);
  assert.deepEqual(actions, ["make-splash", "show-splash", "show-window", "close-splash"]);
  assert.deepEqual(state, { revealed: true, splash: "gone" });
});

test("loaded while the loader is still drawing: it never shows", () => {
  const { actions } = play(["delay", "loaded", "splash-ready"]);
  assert.deepEqual(actions, ["make-splash", "show-window", "close-splash"]);
});

test("the Dock before the page has loaded: the window shows at once, the loader goes, none comes later", () => {
  // (with the loader up)
  assert.deepEqual(play(["delay", "splash-ready", "asked", "loaded", "max"]).actions, ["make-splash", "show-splash", "show-window", "close-splash"]);
  // (before it was due: none is made at all)
  assert.deepEqual(play(["asked", "delay", "splash-ready", "loaded"]).actions, ["show-window"]);
});

test("shown some other way first (a link, a lesson): the loader goes and none is made after", () => {
  assert.deepEqual(play(["delay", "splash-ready", "shown", "loaded"]).actions, ["make-splash", "show-splash", "close-splash"]);
  assert.deepEqual(play(["shown", "delay", "loaded"]).actions, []);
  assert.deepEqual(play(["delay", "shown", "splash-ready"]).actions, ["make-splash", "close-splash"]);
});

test("a page that never loads: the window shows at 15 s, the loader goes with it", () => {
  const { state, actions } = play(["delay", "splash-ready", "max", "loaded"]);
  assert.deepEqual(actions, ["make-splash", "show-splash", "show-window", "close-splash"]);
  assert.equal(state.revealed, true);
});

test("the window shows once: later shows (the Dock again, Explain on screen giving it back) do nothing here", () => {
  const { actions } = play(["loaded", "shown", "asked", "shown", "delay"]);
  assert.deepEqual(actions, ["show-window"]);
});
