import {
  NextResponse,
  type NextFetchEvent,
  type NextMiddleware,
  type NextRequest,
} from "next/server";
import { auth } from "@/shared/lib/auth";
import { isRefusedLocalHost } from "@/shared/lib/local-host";

// Every app surface requires login — including ``/share/<token>``. A
// recipient must authenticate so the backend resolves them to the role the
// link grants (e.g. editor); a logged-out visitor bounces to /login and
// returns via callbackUrl. ``api/auth`` (NextAuth), ``api/register``,
// ``api/webauthn`` (passkey sign-in options), ``api/2fa`` (emailed
// sign-in codes), ``api/password-reset`` and ``api/email-verify`` (the
// login page's reset / verify flows) are excluded: all are hit by
// logged-out visitors, so
// guarding them would bounce the POSTs to /login and the flow would never
// complete. Terms and Privacy are public legal disclosures and must remain
// readable before someone creates an account. ``optimizations`` is excluded
// because a public (Explore-corpus) run must be openable signed-out — the
// detail gate probes the anonymous public composite itself and bounces to
// /login only when the run turns out not to be public. ``api/version`` is
// read by the external uptime monitor, which never signs in. Every
// ``public/`` entry (``fonts``, ``licenses``, the notices file) is excluded
// too: signed-out pages load the bundled fonts, and a gated font request
// gets the /login HTML back instead of the woff2. ``sw.js`` (the web push
// service worker) is fetched by the browser itself on registration and
// update checks, and a /login redirect would fail its registration.
const AUTH_GATED_PATTERN =
  "/((?!login|terms|privacy|optimizations|api/auth|api/register|api/webauthn|api/2fa|api/password-reset|api/email-verify|api/version|_next/static|_next/image|fonts/|licenses/|THIRD_PARTY_NOTICES\\.txt|favicon\\.svg|favicon-dark\\.svg|notification-icon\\.png|sw\\.js|robots\\.txt|sitemap\\.xml).*)";
const authGated = new RegExp(`^${AUTH_GATED_PATTERN}$`);

// ``auth`` runs as the proxy itself when called with the request, as the old
// ``export default auth`` did; its typings declare only the wrapper forms.
const authProxy = auth as unknown as NextMiddleware;

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  // Local mode checks Host on every route, the auth routes included.
  if (isRefusedLocalHost(request.headers.get("host"))) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  if (!authGated.test(request.nextUrl.pathname)) return NextResponse.next();
  return authProxy(request, event);
}

export const config = {
  // Build output only. Every other route runs the proxy for the local-mode
  // Host check; AUTH_GATED_PATTERN decides which of them need a login.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
