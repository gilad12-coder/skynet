/**
 * Build the `before-quit` handler. The first quit request starts `shutdown`.
 * Every request is held with preventDefault, including a second Cmd+Q or a
 * Dock Quit while the stack stops: a request that is not held lets Electron
 * exit at once and leaves Postgres, job containers and `stack.pids` behind.
 * `shutdown` must end with `app.exit`, which does not emit `before-quit`.
 */
export function holdQuitUntilStopped(shutdown: () => void): (event: { preventDefault(): void }) => void {
  let started = false;
  return (event) => {
    event.preventDefault();
    if (started) return;
    started = true;
    shutdown();
  };
}
