import { describe, expect, it } from "vitest";
import { appUrlFromArgv, LINK_CALLBACK, parseLinkCallback } from "../src/main/app-url";

describe("parseLinkCallback", () => {
  it("reads the code and the state of an approved link", () => {
    const state = "gAAAAABn_state+with/odd=chars==";
    const url = `${LINK_CALLBACK}?${new URLSearchParams({ code: "abc_-1", state })}`;
    expect(parseLinkCallback(url)).toEqual({ kind: "code", code: "abc_-1", state });
  });

  it("reads a declined link", () => {
    expect(parseLinkCallback("skynet://link/callback?error=access_denied&state=s")).toEqual({ kind: "denied" });
  });

  it("reports other errors and a missing code or state", () => {
    expect(parseLinkCallback("skynet://link/callback?error=server_error")).toEqual({ kind: "error", error: "server_error" });
    expect(parseLinkCallback("skynet://link/callback?code=c")).toEqual({ kind: "error", error: "invalid_request" });
    expect(parseLinkCallback("skynet://link/callback?state=s")).toEqual({ kind: "error", error: "invalid_request" });
  });

  it("ignores every other URL", () => {
    for (const url of [
      "skynet://link/callback/?code=c&state=s",
      "skynet://link/other?code=c&state=s",
      "skynet://evil/callback?code=c&state=s",
      "skynet://evil@link/callback?code=c&state=s",
      "skynet://link:1/callback?code=c&state=s",
      "skynet:link/callback?code=c&state=s",
      "https://link/callback?code=c&state=s",
      "not a url",
      "",
    ]) {
      expect(parseLinkCallback(url), url).toBeNull();
    }
  });
});

describe("appUrlFromArgv", () => {
  it("finds the skynet:// URL a second instance received", () => {
    expect(appUrlFromArgv(["/Applications/Skynet.app/Contents/MacOS/Skynet", "skynet://link/callback?code=c"])).toBe(
      "skynet://link/callback?code=c",
    );
    expect(appUrlFromArgv(["/Applications/Skynet.app/Contents/MacOS/Skynet", "--flag"])).toBeNull();
  });
});
