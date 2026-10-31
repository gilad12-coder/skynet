import type { Metadata } from "next";
import { DesktopLinkConsent } from "@/features/desktop-link";

export const metadata: Metadata = {
  title: "Link a Mac",
  robots: { index: false, follow: false },
};

export default async function DesktopLinkPage({
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
  return <DesktopLinkConsent query={query.toString()} />;
}
