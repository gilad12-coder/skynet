"use client";

import { useSettingsModal } from "@/features/settings";
import { msg } from "@/shared/lib/messages";
import { Button } from "@/shared/ui/primitives/button";
import { Label } from "@/shared/ui/primitives/label";
import { TEXTAREA_CLASS } from "./shared";
import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";

export function ScorerPackages({ w }: { w: BlackboxWizardContext }) {
  const { openTo } = useSettingsModal();
  const lock = w.scorerDependencyLock;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor="bb-scorer-packages">{msg("submit.blackbox.packages.label")}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-[44px] sm:min-h-0"
          onClick={() => openTo("wizard")}
        >
          {msg("settings.registry.label")}
        </Button>
      </div>
      <p id="bb-scorer-packages-hint" className="text-xs text-muted-foreground">
        {msg("submit.blackbox.packages.hint")}
      </p>
      <textarea
        id="bb-scorer-packages"
        dir="ltr"
        value={w.scorerPackages}
        onChange={(event) => {
          w.setScorerPackages(event.target.value);
          w.setScorerDependencyLock(null);
        }}
        placeholder="numpy==2.3.0"
        aria-describedby="bb-scorer-packages-hint"
        className={`${TEXTAREA_CLASS} min-h-[72px] font-mono text-sm`}
      />
      {w.scorerInstall.trim() && (
        <div className="space-y-1 text-xs">
          <code className="block break-all" dir="ltr">
            {w.scorerInstall.trim()}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-[44px] sm:min-h-0"
            onClick={() => w.setScorerInstall("")}
          >
            {msg("submit.blackbox.packages.remove_legacy")}
          </Button>
        </div>
      )}
      {lock && (
        <div className="space-y-1 text-xs">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-[44px] sm:min-h-0"
            onClick={() => w.setScorerDependencyLock(null)}
          >
            {msg("submit.blackbox.packages.resolve_again")}
          </Button>
          <p className="break-all text-muted-foreground" dir="ltr">
            {lock.registry_url}
          </p>
          {lock.artifacts.length ? (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono" dir="ltr">
              {lock.artifacts.map((artifact) => (
                <li key={artifact.sha256}>
                  {artifact.name}=={artifact.version}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{msg("submit.blackbox.packages.included")}</p>
          )}
        </div>
      )}
    </div>
  );
}
