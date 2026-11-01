import type { Metadata } from "next";
import { McpConsent } from "@/features/mcp-consent";

export const metadata: Metadata = {
  title: "Connect an AI agent",
  robots: { index: false, follow: false },
};

export default async function McpAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, item);
    }
  }
  return <McpConsent query={query.toString()} />;
}
