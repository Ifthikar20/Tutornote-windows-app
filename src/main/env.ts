/*
  Overrides read from the environment (ANOTHERNOTES_URL, ANOTHERNOTES_API_URL, ANOTHERNOTES_SITE,
  the maintenance-gate key, TUTORNOTE_TAP_LOG) are for development and testing only. A packaged
  app ignores them: another program on the same machine must not be able to repoint the app at
  its own origin by setting one, because that origin would get the app's microphone permission and
  its sign-in (WHAT_TO_FIX.md WIN-02 / MAC-02). To use the overrides, run the app from source.

  The decision is a pure function so the gate can be tested without Electron
  (scripts/tests/env.test.ts); config.ts reads app.isPackaged and passes it in.
*/

/** `value` in a development build (packaged false), undefined in a packaged one. */
export function devValue<T>(value: T, packaged: boolean): T | undefined {
  return packaged ? undefined : value;
}
