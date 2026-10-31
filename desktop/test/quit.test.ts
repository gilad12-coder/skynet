import { describe, expect, it, vi } from "vitest";
import { holdQuitUntilStopped } from "../src/main/quit";

function quitEvent() {
  return { preventDefault: vi.fn() };
}

describe("holdQuitUntilStopped", () => {
  it("holds the first quit request and starts the shutdown once", () => {
    const shutdown = vi.fn();
    const onBeforeQuit = holdQuitUntilStopped(shutdown);
    const first = quitEvent();
    onBeforeQuit(first);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("also holds a second quit request (a second Cmd+Q) while the shutdown runs", () => {
    const shutdown = vi.fn();
    const onBeforeQuit = holdQuitUntilStopped(shutdown);
    onBeforeQuit(quitEvent());
    const second = quitEvent();
    onBeforeQuit(second);
    const third = quitEvent();
    onBeforeQuit(third);
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(third.preventDefault).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
