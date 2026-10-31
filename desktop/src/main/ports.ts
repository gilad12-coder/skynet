import net from "node:net";

export interface PortRange {
  start: number;
  end: number;
}

/** Port ranges from §1.7; each service takes the next free port in its range. */
export const PORT_RANGES = {
  api: { start: 48100, end: 48119 },
  frontend: { start: 48120, end: 48139 },
  postgres: { start: 48140, end: 48159 },
} as const satisfies Record<string, PortRange>;

export type PortProbe = (port: number, host: string) => Promise<boolean>;

/** True when nothing listens on host:port and we can bind it. */
export const canBind: PortProbe = (port, host) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });

/** Return the first free port in the range, skipping ports in `taken`. */
export async function findFreePort(
  range: PortRange,
  opts: { host?: string; taken?: Iterable<number>; probe?: PortProbe } = {},
): Promise<number> {
  const host = opts.host ?? "127.0.0.1";
  const probe = opts.probe ?? canBind;
  const taken = new Set(opts.taken ?? []);
  for (let port = range.start; port <= range.end; port++) {
    if (taken.has(port)) continue;
    if (await probe(port, host)) return port;
  }
  throw new Error(`No free port in ${range.start}-${range.end} on ${host}`);
}

export interface PortPlan {
  api: number;
  frontend: number;
  postgres: number;
}

export async function allocatePorts(probe?: PortProbe): Promise<PortPlan> {
  const postgres = await findFreePort(PORT_RANGES.postgres, { probe });
  const api = await findFreePort(PORT_RANGES.api, { probe });
  const frontend = await findFreePort(PORT_RANGES.frontend, { probe });
  return { api, frontend, postgres };
}
