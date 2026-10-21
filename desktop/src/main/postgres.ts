import { runCommand, waitFor } from "./supervisor";

export const PG_CONTAINER = "skynet-local-postgres";
export const PG_IMAGE = "pgvector/pgvector:pg16";
export const PG_VOLUME = "skynet-local-pgdata";
export const PG_DB = "skynet";
export const PG_USER = "skynet";

export interface DockerCtx {
  docker: string;
  env: Record<string, string>;
}

export function databaseUrl(password: string, port: number): string {
  return `postgresql://${PG_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${PG_DB}`;
}

/**
 * Start the Postgres container on 127.0.0.1:<port>. A leftover container from
 * a crashed session is removed first; the data lives in the named volume, so
 * removing the container loses nothing. POSTGRES_PASSWORD only takes effect
 * when the volume is empty, which is why the password must stay stable.
 */
export async function startPostgres(ctx: DockerCtx, port: number, password: string): Promise<void> {
  await runCommand(ctx.docker, ["rm", "-f", PG_CONTAINER], { env: ctx.env, timeoutMs: 30_000 });
  const run = await runCommand(
    ctx.docker,
    [
      "run",
      "-d",
      "--rm",
      "--name",
      PG_CONTAINER,
      "-p",
      `127.0.0.1:${port}:5432`,
      "-v",
      `${PG_VOLUME}:/var/lib/postgresql/data`,
      "-e",
      `POSTGRES_DB=${PG_DB}`,
      "-e",
      `POSTGRES_USER=${PG_USER}`,
      "-e",
      "POSTGRES_PASSWORD",
      PG_IMAGE,
    ],
    // The password goes through the environment, not argv, so `ps` never shows it.
    { env: { ...ctx.env, POSTGRES_PASSWORD: password }, timeoutMs: 10 * 60_000 },
  );
  if (run.code !== 0) throw new Error(`docker run ${PG_IMAGE} failed: ${lastLine(run.stderr)}`);
  await waitFor(
    "Postgres",
    async () => {
      const res = await runCommand(ctx.docker, ["exec", PG_CONTAINER, "pg_isready", "-U", PG_USER, "-d", PG_DB], {
        env: ctx.env,
        timeoutMs: 10_000,
      });
      return res.code === 0;
    },
    { timeoutMs: 90_000, intervalMs: 1_000 },
  );
}

export async function stopPostgres(ctx: DockerCtx): Promise<void> {
  await runCommand(ctx.docker, ["stop", PG_CONTAINER], { env: ctx.env, timeoutMs: 30_000 });
}

/** Remove every sandbox container the backend started (label `skynet.job`). */
export async function removeSandboxContainers(ctx: DockerCtx): Promise<void> {
  const list = await runCommand(ctx.docker, ["ps", "-aq", "--filter", "label=skynet.job"], {
    env: ctx.env,
    timeoutMs: 15_000,
  });
  const ids = list.stdout.split(/\s+/).filter(Boolean);
  if (ids.length) await runCommand(ctx.docker, ["rm", "-f", ...ids], { env: ctx.env, timeoutMs: 60_000 });
}

export function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).pop() ?? "unknown error";
}
