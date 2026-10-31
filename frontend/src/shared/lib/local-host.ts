// The local desktop build signs in its single user with no credentials, so a
// web page that rebinds its own hostname to 127.0.0.1 could sign in and read
// the backend token. The rebound request still names that page in Host, so
// local mode serves only the loopback names it binds. The desktop app opens
// 127.0.0.1, and Next.js builds callback URLs with "localhost".
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost"]);

/**
 * Whether local mode must refuse a request with this Host header.
 *
 * Hosted builds never set APP_LOCAL_MODE and refuse nothing. In local mode the
 * host must be a loopback name or the AUTH_URL host, on the AUTH_URL port.
 */
export function isRefusedLocalHost(
  host: string | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.APP_LOCAL_MODE !== "1") return false;
  let actual: URL;
  try {
    actual = new URL(`http://${host ?? ""}`);
  } catch {
    return true;
  }
  if (actual.username || actual.password || actual.pathname !== "/") return true;
  const authUrl = env.AUTH_URL ?? env.NEXTAUTH_URL;
  if (!authUrl) return !LOOPBACK_NAMES.has(actual.hostname);
  const expected = new URL(authUrl);
  if (actual.port !== expected.port) return true;
  return !LOOPBACK_NAMES.has(actual.hostname) && actual.hostname !== expected.hostname;
}
