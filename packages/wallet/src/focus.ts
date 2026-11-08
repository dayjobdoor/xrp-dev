/**
 * Why a WebAuthn call waits for the window's focus: Firefox (Zen and other derivatives included) rejects
 * `navigator.credentials.create` and `.get` with `NotAllowedError` while its window is not the active one (Gecko's
 * `CredentialsContainer` asks for `IsInActiveTab` on both). A macOS passkey sheet that has just closed has not given the
 * focus back yet, so the second ceremony in a row (the PRF read after a registration, a signature) is refused.
 *
 * Why not always `await` the focus: Safari drops the click's user activation across an `await`, so with focus the call
 * runs at once, in the same task.
 */
const FOCUS_WAIT_MS = 10_000;

const whenFocused = (waitMs: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("focus", done);
      resolve();
    };
    // Why call anyway after the wait: the browser's own error is more useful than a hang.
    const timer = setTimeout(done, waitMs);
    window.addEventListener("focus", done);
  });

/**
 * Runs `call` now when the window has focus (or there is no document to ask, as in a Worker or a test), else once focus
 * returns or `waitMs` (10 s by default) has passed.
 */
export const focused = <T>(call: () => Promise<T>, waitMs = FOCUS_WAIT_MS): Promise<T> =>
  typeof document === "undefined" || document.hasFocus() ? call() : whenFocused(waitMs).then(call);
