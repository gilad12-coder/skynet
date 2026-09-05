"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { toast } from "react-toastify";
import { getPackageRegistry, updatePackageRegistry } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { Button } from "@/shared/ui/primitives/button";
import { RetryIconButton } from "@/shared/ui/retry-icon-button";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";

const PYPI = "https://pypi.org/simple";

export function PackageRegistrySetting() {
  const { data: session } = useSession();
  const owner = session?.user?.email ?? "";
  return <RegistryForm key={owner} owner={owner} />;
}

function RegistryForm({ owner }: { owner: string }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    setValue("");
    setLoading(true);
    setError(null);
    if (!owner) return;
    getPackageRegistry()
      .then((result) => {
        if (cancelled) return;
        setSaved(result.index_url);
        setValue(result.index_url);
      })
      .catch(() => {
        if (!cancelled) setError(msg("settings.registry.load_error"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [owner, reload]);

  const save = useCallback(async (indexUrl: string) => {
    setSaving(true);
    setError(null);
    try {
      const result = await updatePackageRegistry(indexUrl);
      setSaved(result.index_url);
      setValue(result.index_url);
      toast.success(msg("settings.saved"));
    } catch {
      setError(msg("settings.registry.save_error"));
    } finally {
      setSaving(false);
    }
  }, []);

  return (
    <form
      className="space-y-3 border-t px-3 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save(value);
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="settings-package-registry">{msg("settings.registry.label")}</Label>
        <p id="settings-package-registry-hint" className="text-xs text-muted-foreground">
          {msg("settings.registry.description")}
        </p>
      </div>
      <Input
        id="settings-package-registry"
        type="url"
        dir="ltr"
        value={value}
        placeholder={PYPI}
        onChange={(event) => setValue(event.target.value)}
        disabled={!owner || loading || saving || saved === null}
        aria-describedby="settings-package-registry-hint"
        autoComplete="off"
        spellCheck={false}
        className="min-h-[44px] font-mono text-sm"
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {saved === null && error ? (
          <RetryIconButton
            label={msg("settings.notifications.retry")}
            onClick={() => setReload((n) => n + 1)}
            loading={loading}
          />
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={loading || saving || saved === null || (saved === PYPI && value === PYPI)}
              onClick={() => void save(PYPI)}
            >
              {msg("settings.registry.reset")}
            </Button>
            <Button
              type="submit"
              disabled={loading || saving || saved === null || value.trim() === saved}
            >
              {saving ? msg("settings.registry.saving") : msg("settings.registry.save")}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
