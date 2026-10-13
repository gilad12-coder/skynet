"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";

import { sessionIdentity } from "@/shared/lib/session-identity";

import { UnifiedWizard } from "./v2/UnifiedWizard";

// Setups were once saved as drafts in this browser and offered back on
// return; that feature is gone, so whatever an older build left is dropped.
const RETIRED_DRAFT_DATABASE = "skynet-wizard-drafts";
const RETIRED_DRAFT_RESUME_KEY = "skynet.wizard-draft.resume";

function clearRetiredDrafts() {
  try {
    window.indexedDB?.deleteDatabase(RETIRED_DRAFT_DATABASE);
  } catch {}
  try {
    window.sessionStorage.removeItem(RETIRED_DRAFT_RESUME_KEY);
  } catch {}
}

/** `/submit` root: the one submission wizard, once the session is known. */
export function SubmitEntry() {
  const searchParams = useSearchParams();
  // Read once: a run started from a folder's menu should land in that folder.
  const [folderId] = useState(() => searchParams.get("folder"));
  const { data: session, status } = useSession();
  const accountId = status === "loading" ? null : sessionIdentity(session) || null;

  useEffect(() => {
    clearRetiredDrafts();
  }, []);

  if (accountId === null) return null;
  // Keyed by account so a sign-in switch never carries one user's setup to another.
  return <UnifiedWizard key={accountId} folderId={folderId} />;
}
