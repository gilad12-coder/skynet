import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

export interface LocalSecrets {
  pgPassword: string;
  backendAuthSecret: string;
  authSecret: string;
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
 * Load the local secrets from `secrets.bin`, or create them on first launch.
 * The file holds a JSON object encrypted with Electron safeStorage, which
 * keeps the key in the macOS login keychain. The same Postgres password must
 * survive restarts because it is baked into the persistent data volume.
 */
export function loadOrCreateSecrets(dataDir: string): { secrets: LocalSecrets; created: boolean } {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("macOS keychain encryption is not available; Skynet cannot store its local secrets.");
  }
  const file = path.join(dataDir, "secrets.bin");
  if (fs.existsSync(file)) {
    const parsed: unknown = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    if (isComplete(parsed)) return { secrets: parsed, created: false };
    throw new Error(`${file} is incomplete. Remove it and the skynet-local-pgdata volume to reset.`);
  }
  const secrets = generate();
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(secrets)), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { secrets, created: true };
}
