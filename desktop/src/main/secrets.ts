import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface LocalSecrets {
  pgPassword: string;
  backendAuthSecret: string;
  authSecret: string;
}

export const SECRETS_FILE = "secrets.json";
/** The keychain-encrypted file of earlier builds. It is never decrypted (see loadOrCreateSecrets). */
export const LEGACY_SECRETS_FILE = "secrets.bin";

/**
 * Create the data folder with mode 0700, or narrow an existing one to 0700.
 * A recursive mkdir does not change the mode of a folder that exists, and
 * Electron or an earlier build can create it with 0755.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

function recoveryHint(file: string): string {
  return `Quit Skynet, remove ${file}, and open Skynet again. It then creates new secrets and sets the new Postgres password on the existing volume, so your data stays.`;
}

function generate(): LocalSecrets {
  return {
    pgPassword: randomBytes(24).toString("hex"),
    backendAuthSecret: randomBytes(32).toString("hex"),
    authSecret: randomBytes(32).toString("hex"),
  };
}

function isComplete(value: unknown): value is LocalSecrets {
  const v = value as Partial<LocalSecrets> | null;
  return !!v && [v.pgPassword, v.backendAuthSecret, v.authSecret].every((s) => typeof s === "string" && s.length >= 32);
}

/**
 * Load the local secrets from `secrets.json`, or create them.
 *
 * The file is plain JSON with mode 0600 in the user's data folder. The secrets
 * protect only services bound to 127.0.0.1, so the keychain adds little: any
 * process that runs as the user can already read the Postgres volume and the
 * app's data. The keychain also cost too much. An ad-hoc signed app gets a new
 * signature on every rebuild or update, so safeStorage asked for the login
 * password again, and the synchronous call blocked the main thread (Quit and
 * SIGTERM did nothing) while the prompt was open.
 *
 * An old `secrets.bin` is not decrypted, because that would open the same
 * prompt. New secrets replace it. startPostgres sets the new password on the
 * existing volume, so the data stays; only local web sessions sign out once.
 */
export function loadOrCreateSecrets(dataDir: string): { secrets: LocalSecrets; created: boolean; replacedLegacy: boolean } {
  const file = path.join(dataDir, SECRETS_FILE);
  if (fs.existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`${file} cannot be read (${(err as Error).message}). ${recoveryHint(file)}`);
    }
    // A damaged file is never replaced on its own: the user decides, and the hint says what happens.
    if (!isComplete(parsed)) throw new Error(`${file} is incomplete. ${recoveryHint(file)}`);
    fs.chmodSync(file, 0o600);
    return { secrets: parsed, created: false, replacedLegacy: false };
  }
  const secrets = generate();
  ensurePrivateDir(dataDir);
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  // fsync before and after the rename, so a crash cannot leave an empty secrets.json.
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(secrets));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const dirFd = fs.openSync(dataDir, "r");
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
  const legacy = path.join(dataDir, LEGACY_SECRETS_FILE);
  const replacedLegacy = fs.existsSync(legacy);
  if (replacedLegacy) fs.rmSync(legacy, { force: true });
  return { secrets, created: true, replacedLegacy };
}
