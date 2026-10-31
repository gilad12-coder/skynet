import crypto from "node:crypto";

/** Matches backend settings.local_user_email; the backend signs in this one local user. */
export const LOCAL_USER_EMAIL = "local@skynet.local";

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/**
 * Mint the short-lived HS256 session JWT the local backend accepts, the same
 * shape the web app's frontend mints. The secret never leaves this process.
 */
export function mintSessionToken(secret: string, email: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ sub: email, email, name: email, aud: "skynet-backend", iss: "skynet-frontend", iat, exp: iat + 300 }),
  );
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(signature)}`;
}

export type StartResult = { ok: true; url: string } | { ok: false; reason: "unavailable" | "failed"; detail: string };

/** Talks to the local backend's /local/hosted-link routes as the local user. */
export class HostedLinkClient {
  constructor(
    private readonly apiOrigin: string,
    private readonly secret: string,
  ) {}

  private async call(method: "GET" | "POST", route: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${this.apiOrigin}${route}`, {
      method,
      headers: { authorization: `Bearer ${mintSessionToken(this.secret, LOCAL_USER_EMAIL)}`, ...headers },
      signal: AbortSignal.timeout(10_000),
    });
  }

  /** Create the local user row; the link routes need it to exist. */
  async ensureLocalUser(): Promise<void> {
    const res = await fetch(`${this.apiOrigin}/auth/local/session`, {
      method: "POST",
      headers: { "X-Internal-Auth": this.secret },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Local sign-in failed (HTTP ${res.status})`);
  }

  async linked(): Promise<boolean> {
    const res = await this.call("GET", "/local/hosted-link/status");
    if (!res.ok) throw new Error(`Account status check failed (HTTP ${res.status})`);
    const body = (await res.json()) as { linked?: boolean };
    return body.linked === true;
  }

  async start(): Promise<StartResult> {
    const res = await this.call("POST", "/local/hosted-link/start");
    const body = (await res.json().catch(() => ({}))) as { authorize_url?: string; code?: string; detail?: string };
    if (res.ok && body.authorize_url?.startsWith("https://")) return { ok: true, url: body.authorize_url };
    if (res.status === 503 || body.code === "hosted_link.not_configured") {
      return { ok: false, reason: "unavailable", detail: body.detail ?? "" };
    }
    return { ok: false, reason: "failed", detail: body.detail ?? `HTTP ${res.status}` };
  }
}
