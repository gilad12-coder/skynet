import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { allocatePorts, canBind, findFreePort, PORT_RANGES } from "../src/main/ports";

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
    servers.push(server);
  });
}

describe("findFreePort", () => {
  it("returns the first port when it is free", async () => {
    expect(await findFreePort({ start: 48100, end: 48119 }, { probe: async () => true })).toBe(48100);
  });

  it("falls back to the next free port", async () => {
    const busy = new Set([48100, 48101, 48102]);
    const port = await findFreePort({ start: 48100, end: 48119 }, { probe: async (p) => !busy.has(p) });
    expect(port).toBe(48103);
  });

  it("skips ports already taken by this launch", async () => {
    const port = await findFreePort({ start: 48100, end: 48119 }, { taken: [48100], probe: async () => true });
    expect(port).toBe(48101);
  });

  it("fails when the whole range is busy", async () => {
    await expect(findFreePort({ start: 48100, end: 48102 }, { probe: async () => false })).rejects.toThrow(
      "No free port in 48100-48102",
    );
  });

  it("detects a real listener on 127.0.0.1", async () => {
    const range = { start: 48157, end: 48159 };
    const first = await findFreePort(range);
    await occupy(first);
    expect(await canBind(first, "127.0.0.1")).toBe(false);
    const next = await findFreePort(range);
    expect(next).toBeGreaterThan(first);
  });
});

describe("allocatePorts", () => {
  it("uses the contract ranges", async () => {
    const plan = await allocatePorts(async () => true);
    expect(plan).toEqual({ api: PORT_RANGES.api.start, frontend: PORT_RANGES.frontend.start, postgres: PORT_RANGES.postgres.start });
    expect(PORT_RANGES).toEqual({
      api: { start: 48100, end: 48119 },
      frontend: { start: 48120, end: 48139 },
      postgres: { start: 48140, end: 48159 },
    });
  });
});
