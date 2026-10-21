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
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isComplete(parsed)) throw new Error(`${file} is incomplete. Remove it to create new local secrets.`);
    fs.chmodSync(file, 0o600);
    return { secrets: parsed, created: false, replacedLegacy: false };
  }
  const secrets = generate();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
  const legacy = path.join(dataDir, LEGACY_SECRETS_FILE);
  const replacedLegacy = fs.existsSync(legacy);
  if (replacedLegacy) fs.rmSync(legacy, { force: true });
  return { secrets, created: true, replacedLegacy };
}
