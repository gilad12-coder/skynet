import fs from "node:fs";
import path from "node:path";
import { lastLine, type DockerCtx } from "./postgres";
import { runCommand } from "./supervisor";

export const SANDBOX_REPO = "skynet-local-sandbox";

async function imageId(ctx: DockerCtx, ref: string): Promise<string | null> {
  const res = await runCommand(ctx.docker, ["image", "inspect", "--format", "{{.Id}}", ref], {
    env: ctx.env,
    timeoutMs: 30_000,
  });
  const id = res.stdout.trim();
  return res.code === 0 && id.startsWith("sha256:") ? id : null;
}

/**
 * Make sure `skynet-local-sandbox:<appVersion>` exists and return its image
 * ID. The tag carries the app version, so an app update builds a fresh image
 * from the backend it ships; the same version reuses the cached image.
 * The backend runs sandboxes by ID (`APP_LOCAL_SANDBOX_IMAGE=sha256:...`) so a
 * retag can never swap the image under a running job.
 */
export async function ensureSandboxImage(
  ctx: DockerCtx,
  backendDir: string,
  appVersion: string,
  logFile: string,
): Promise<string> {
  const ref = `${SANDBOX_REPO}:${appVersion}`;
  const existing = await imageId(ctx, ref);
  if (existing) return existing;
  const log = fs.createWriteStream(logFile, { flags: "a" });
  try {
    const build = await runCommand(ctx.docker, ["build", "-t", ref, backendDir], {
      env: ctx.env,
      cwd: path.dirname(backendDir),
      timeoutMs: 60 * 60_000,
      log,
    });
    if (build.code !== 0) throw new Error(`docker build ${ref} failed: ${lastLine(build.stderr)}`);
  } finally {
    log.end();
  }
  const built = await imageId(ctx, ref);
  if (!built) throw new Error(`docker build ${ref} produced no image`);
  return built;
}
