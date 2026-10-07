import { auth } from "@/shared/lib/auth";

export default auth;

export const config = {
  matcher: [
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
    // gets the /login HTML back instead of the woff2.
    "/((?!login|terms|privacy|optimizations|api/auth|api/register|api/webauthn|api/2fa|api/password-reset|api/email-verify|api/version|_next/static|_next/image|fonts/|licenses/|THIRD_PARTY_NOTICES\\.txt|favicon\\.svg|notification-icon\\.png|robots\\.txt|sitemap\\.xml).*)",
  ],
};
