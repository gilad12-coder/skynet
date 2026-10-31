import {
  NextResponse,
  type NextFetchEvent,
  type NextMiddleware,
  type NextRequest,
} from "next/server";
import { auth } from "@/shared/lib/auth";
import { proxyRoute } from "@/shared/lib/proxy-route";

// ``auth`` runs as the proxy itself when called with the request, as the old
// ``export default auth`` did; its typings declare only the wrapper forms.
const authProxy = auth as unknown as NextMiddleware;

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  switch (proxyRoute(request.headers.get("host"), request.nextUrl.pathname)) {
    case "refuse":
      return new NextResponse("Forbidden", { status: 403 });
    case "pass":
      return NextResponse.next();
    case "auth":
      return authProxy(request, event);
  }
}

export const config = {
  // Build output only. Every other route runs the proxy for the local-mode
  // Host check; AUTH_GATED_PATTERN (shared/lib/proxy-route.ts) decides which
  // of them need a login.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
