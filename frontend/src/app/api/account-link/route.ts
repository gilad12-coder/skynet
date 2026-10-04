import { NextResponse } from "next/server";
import { auth } from "@/shared/lib/auth";
import {
  ACCOUNT_LINK_COOKIE,
  ACCOUNT_LINK_TTL_SECONDS,
  LINKABLE_PROVIDERS,
  encodeAccountLink,
} from "@/shared/lib/account-link";

/**
 * Start linking a Google or GitHub account to the signed-in account. Sets the
 * signed link cookie; the browser then runs the provider's normal sign-in, and
 * the sign-in callback links instead of signing in by email.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  const username = session?.user?.email;
  if (!username) return NextResponse.json({ error: "auth.unauthorized" }, { status: 401 });

  let provider = "";
  try {
    const body = (await request.json()) as { provider?: unknown };
    provider = typeof body.provider === "string" ? body.provider : "";
  } catch {
    provider = "";
  }
  if (!LINKABLE_PROVIDERS.has(provider)) {
    return NextResponse.json({ error: "accounts.identity_not_found" }, { status: 400 });
  }

  const value = encodeAccountLink(username, provider);
  if (!value) return NextResponse.json({ error: "auth.not_configured" }, { status: 500 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ACCOUNT_LINK_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ACCOUNT_LINK_TTL_SECONDS,
  });
  return response;
}
