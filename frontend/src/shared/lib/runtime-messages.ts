/**
 * Sync active-catalog resolution for `msg()`, across the RSC server/client
 * boundary — the message-catalog counterpart to `runtime-locale.ts`.
 *
 * `msg("some.key")` resolves a string from the *active* locale's catalog with no
 * argument, so the catalog has to be ambient. To ship only the active fallback
 * chain (not all locales), the catalog is delivered out of band rather than
 * statically imported into the client bundle:
 *
 * - **Client**: a module-level map seeded from the `window.__SKYNET_MESSAGES__`
 *   shim the layout injects before hydration, so even module-scope `msg()`
 *   calls (resolved while the bundle evaluates) find their strings. The
 *   `LocaleProvider` also sets it from a prop, which is what covers the SSR pass
 *   of client components (where `window` is undefined).
 * - **Server**: a per-request slot held by React's `cache()`, set once at the
 *   top of the root layout so Server Components resolve against the request's
 *   merged catalog without cross-request bleed.
 *
 * The merge across the fallback chain happens once, server-side (see
 * `messages.server.ts`); the value here is already a flat, complete map.
 */

import { cache } from "react";

export type UiCatalog = Record<string, string>;

declare global {
  interface Window {
    __SKYNET_MESSAGES__?: UiCatalog;
  }
}

let clientMessages: UiCatalog | null = null;

// Lazily created so cache() is only ever invoked during a server render, never
// when this module loads in the client bundle. Mirrors runtime-locale.ts.
let serverSlot: (() => { current: UiCatalog }) | null = null;

function getServerSlot(): { current: UiCatalog } {
  serverSlot ??= cache((): { current: UiCatalog } => ({ current: {} }));
  return serverSlot();
}

/**
 * Pin the active catalog for the current server request. Call once at the top of
 * the root layout (and `generateMetadata`) before any descendant resolves a
 * message.
 */
export function setServerMessages(catalog: UiCatalog): void {
  getServerSlot().current = catalog;
}

/**
 * Seed the client's active catalog. The `LocaleProvider` calls this before any
 * descendant renders so the first client render (and SSR of client components)
 * resolves against the request's catalog.
 */
export function setClientMessages(catalog: UiCatalog): void {
  clientMessages = catalog;
}

/**
 * Resolve the catalog every `msg()` call should read from.
 *
 * Branches by bundle, exactly like `getActiveLocale()`: the client map when set
 * (preferred, since during SSR of client components `window` is undefined yet we
 * still need the request catalog), else the per-request server slot on the
 * server, else the injected `window.__SKYNET_MESSAGES__` shim for the client's
 * first paint / module-scope resolution.
 */
export function getActiveMessages(): UiCatalog {
  if (clientMessages !== null) return clientMessages;
  if (typeof window === "undefined") {
    return getServerSlot().current;
  }
  clientMessages = window.__SKYNET_MESSAGES__ ?? {};
  return clientMessages;
}

/**
 * Inline `<script>` body that sets `window.__SKYNET_MESSAGES__` before
 * hydration. Unlike the locale shim, the catalog carries arbitrary user-facing
 * copy, so `<` is escaped to `<` to keep a value from closing the
 * surrounding `<script>` (same guard the JSON-LD block uses).
 */
export function serializeMessages(catalog: UiCatalog): string {
  return `window.__SKYNET_MESSAGES__=${JSON.stringify(catalog).replace(/</g, "\\u003c")};`;
}
