"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { CircleNotch } from "@/shared/ui/icons";

import { claimSharedFolder, setApiAuthToken } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { Button } from "@/shared/ui/primitives/button";

/**
 * Folder share-link redeemer (Google-Drive semantics). The route is login-gated,
 * so the recipient is signed in by the time this mounts: it redeems the token,
 * which grants the link's viewer/editor role on the folder and everything in
 * it, then lands on the dashboard with ``?folder=<id>`` so the sidebar opens
 * that folder under "Shared with me".
 */
export default function FolderSharePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Attach the bearer before redeeming: effects run child-before-parent, so
    // the root bridge may not have synced the token yet.
    if (status === "loading") return;
    let cancelled = false;
    if (session?.backendAccessToken) setApiAuthToken(session.backendAccessToken);
    claimSharedFolder(token)
      .then((res) => {
        if (!cancelled) router.replace(`/?folder=${res.folder_id}`);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token, status, session?.backendAccessToken, router]);

  if (failed) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-2xl font-bold text-foreground">
          {msg("folders.claim.not_found_title")}
        </h1>
        <p className="text-sm text-muted-foreground">{msg("folders.claim.not_found_body")}</p>
        <Button asChild variant="outline" className="mt-2 min-h-[44px]">
          <Link href="/">{msg("not_found.back_dashboard")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <CircleNotch className="size-8 animate-spin text-primary" />
    </div>
  );
}
