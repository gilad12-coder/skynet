/** Public Privacy Policy page at /privacy. */

import type { Metadata } from "next";
import { LegalDocument, LEGAL_LINKS, PRIVACY_POLICY } from "@/features/legal";
import { APP_NAME } from "@/shared/lib/brand";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `How ${APP_NAME} collects, uses, and shares your personal information.`,
  alternates: { canonical: LEGAL_LINKS.privacy },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return <LegalDocument document={PRIVACY_POLICY} kind="privacy" />;
}
