"use client";

import * as React from "react";
import { Coins, Key, X } from "@/shared/ui/icons";
import { useByokKeys, litellmProviderForByok, type TokenSourceMode } from "@/features/billing";
import { useSettingsModal } from "@/features/settings";
import { getByokModelCatalog, cachedByokCatalog } from "@/shared/lib/model-catalog";
import { Dialog, DialogContent, DialogFooter } from "@/shared/ui/primitives/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import { DialogTitleRow } from "@/shared/ui/dialog-title-row";
import { Button } from "@/shared/ui/primitives/button";
import { Label } from "@/shared/ui/primitives/label";
import { Switch } from "@/shared/ui/primitives/switch";
import { Separator } from "@/shared/ui/primitives/separator";
import { ModelPicker, modelSupportsThinking } from "./ModelPicker";
import { ProviderLogo } from "@/shared/ui/provider-logo";
import { modelProviderSlug } from "@/shared/lib/model-provider";
import { effortLabel, effortsFor } from "@/shared/lib/model-efforts";
import { NumberInput } from "@/shared/ui/number-input";
import { Segmented } from "@/shared/ui/segmented";
import { Disclosure } from "./Disclosure";
import { cn } from "@/shared/lib/utils";
import type { ModelConfig, CatalogModel } from "@/shared/types/api";
import { HelpTip } from "@/shared/ui/help-tip";
import { tip } from "@/shared/lib/tooltips";
import { TERMS } from "@/shared/lib/terms";
import { formatMsg, msg } from "@/shared/lib/messages";

interface ModelConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: ModelConfig;
  onSave: (config: ModelConfig) => void;
  /** Label shown in the dialog header, e.g. the primary-model or reflection-model term. */
  roleLabel?: string;
  /** Catalog models for thinking detection */
  catalogModels?: CatalogModel[];
  /** Recently used configs — shown as quick-select at top */
  recentConfigs?: ModelConfig[];
  /** Remove a single recent config by its model name (rendered as a per-row X). */
  onRemoveRecent?: (name: string) => void;
  /**
   * Only the model id is chosen; billing source, sampling and thinking are
   * hidden and never saved. For targets that take nothing but a model id.
   */
  nameOnly?: boolean;
  /** Keep billing selection, but use the model's own sampling defaults. */
  modelDefaultsOnly?: boolean;
}

const TOKEN_SOURCE_SEGMENTS: Array<{
  mode: TokenSourceMode;
  icon: typeof Coins;
  labelKey: "billing.mode.managed" | "billing.mode.byok";
}> = [
  { mode: "managed", icon: Coins, labelKey: "billing.mode.managed" },
  { mode: "byok", icon: Key, labelKey: "billing.mode.byok" },
];

function withoutInlineConnection(config: ModelConfig): ModelConfig {
  const { base_url: _baseUrl, ...rest } = config;
  const {
    api_key: _apiKey,
    api_base: _ApiBase,
    base_url: _ExtraBaseUrl,
    ...safeExtra
  } = rest.extra ?? {};
  const tokenSource = rest.token_source ?? "managed";
  return {
    ...rest,
    token_source: tokenSource,
    byok_provider: tokenSource === "byok" ? rest.byok_provider : undefined,
    extra: Object.keys(safeExtra).length > 0 ? safeExtra : undefined,
  };
}

export function ModelConfigModal({
  open,
  onOpenChange,
  config,
  onSave,
  roleLabel = msg("auto.features.submit.components.modelconfigmodal.literal.1"),
  catalogModels,
  recentConfigs,
  onRemoveRecent,
  nameOnly = false,
  modelDefaultsOnly = false,
}: ModelConfigModalProps) {
  const { keys } = useByokKeys();
  const { openTo } = useSettingsModal();
  // Two of these modals coexist (generation + reflection); the sliding-pill
  // layoutId must be unique per instance or Framer pairs them up.
  const parametersId = React.useId();
  const [parametersOpen, setParametersOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<ModelConfig>(() => withoutInlineConnection(config));
  const mode = nameOnly ? "managed" : (draft.token_source ?? "managed");

  // In BYOK mode the picker lists the BYOK catalog narrowed to the providers
  // the user has a *verified* key for (mapped to their LiteLLM prefix), so a
  // typo'd, revoked, or unverified key never offers models a run could only
  // fail to authenticate.
  const byokProviders = React.useMemo(
    () =>
      keys.filter((k) => k.status === "verified").map((k) => litellmProviderForByok(k.provider)),
    [keys],
  );
  const byokProviderKey = [...byokProviders].sort().join("\u0000");
  // BYOK catalog models also feed reasoning-toggle detection, since a BYOK model
  // won't appear in the managed `catalogModels`.
  const [byokModels, setByokModels] = React.useState<CatalogModel[] | null>(
    cachedByokCatalog()?.models ?? null,
  );
  React.useEffect(() => {
    if (mode !== "byok") return;
    let cancelled = false;
    getByokModelCatalog()
      .then((c) => {
        if (!cancelled) setByokModels(c.models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mode, byokProviderKey]);
  const detectionModels = mode === "byok" ? (byokModels ?? undefined) : catalogModels;

  // Recent chips follow the chosen source: a remembered managed model never
  // shows under BYOK (and vice versa), and a chip whose model the active
  // catalog no longer serves — a removed key, a retired model — is dropped.
  const visibleRecent = React.useMemo(() => {
    if (!recentConfigs?.length) return [];
    const served = detectionModels ? new Set(detectionModels.map((m) => m.value)) : null;
    return recentConfigs.filter(
      (rc) => (rc.token_source ?? "managed") === mode && (!served || served.has(rc.name)),
    );
  }, [recentConfigs, detectionModels, mode]);

  // Sync draft when config changes externally (e.g. opening with different model)
  React.useEffect(() => {
    if (open) {
      setDraft(withoutInlineConnection(config));
      setParametersOpen(
        config.temperature != null || config.max_tokens != null || !!config.extra?.reasoning_effort,
      );
    }
  }, [open, config]);

  // The effort ladder is model-specific (providers reject levels outside
  // their documented set). "none" is expressed by the switch itself, and an
  // empty ladder (always-on thinkers like MiniMax M3) leaves nothing to
  // configure, so the whole section disappears.
  const effortLadder = React.useMemo(
    () => effortsFor(draft.name).filter((level) => level !== "none"),
    [draft.name],
  );
  const defaultEffort = (ladder: readonly string[]) =>
    ladder.includes("medium") ? "medium" : (ladder[Math.floor(ladder.length / 2)] ?? "medium");
  const canThink = modelSupportsThinking(draft.name, detectionModels) && effortLadder.length > 0;
  const thinkingEnabled = !!draft.extra?.reasoning_effort;
  const reasoningEffort = (draft.extra?.reasoning_effort as string) ?? "medium";

  const setThinking = (on: boolean) => {
    setDraft((p) => ({
      ...p,
      extra: on
        ? { ...p.extra, reasoning_effort: defaultEffort(effortLadder) }
        : (() => {
            const rest = { ...p.extra };
            delete rest.reasoning_effort;
            return Object.keys(rest).length ? rest : undefined;
          })(),
    }));
  };

  const setEffort = (level: string) => {
    setDraft((p) => ({ ...p, extra: { ...p.extra, reasoning_effort: level } }));
  };

  const handleSave = () => {
    if (nameOnly) {
      onSave({ name: draft.name });
    } else if (modelDefaultsOnly) {
      onSave({
        name: draft.name,
        token_source: draft.token_source ?? "managed",
        byok_provider: draft.token_source === "byok" ? draft.byok_provider : undefined,
      });
    } else {
      onSave(withoutInlineConnection(draft));
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[85vh] sm:max-w-2xl">
        <DialogTitleRow title={roleLabel} className="px-4 pt-6 sm:px-6" />

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          {visibleRecent.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                {msg("auto.features.submit.components.modelconfigmodal.2")}
              </Label>
              <div className="flex gap-1.5 overflow-x-auto pb-1.5 scrollbar-thin" dir="ltr">
                {visibleRecent.map((rc, i) => {
                  const isActive = draft.name === rc.name;
                  return (
                    <div
                      key={`${rc.name}-${i}`}
                      className={cn(
                        "group/recent flex shrink-0 items-center gap-1.5 rounded-md border ps-2 pe-1 py-1 text-[0.6875rem] font-mono transition-all",
                        isActive
                          ? "border-primary/50 bg-primary/5 text-foreground"
                          : "border-border/40 bg-muted/30 text-muted-foreground hover:border-primary/40 hover:text-foreground hover:bg-muted/50",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setDraft(withoutInlineConnection(rc));
                          setParametersOpen(
                            rc.temperature != null ||
                              rc.max_tokens != null ||
                              !!rc.extra?.reasoning_effort,
                          );
                        }}
                        className="flex items-center gap-1.5 cursor-pointer outline-none"
                      >
                        <ProviderLogo slug={modelProviderSlug(rc.name)} size={16} />
                        <span className="truncate max-w-[120px]">{rc.name.split("/").pop()}</span>
                        {!nameOnly && !modelDefaultsOnly && (
                          <span className="text-[9px] opacity-60">{rc.temperature}</span>
                        )}
                      </button>
                      {onRemoveRecent && (
                        <button
                          type="button"
                          aria-label={formatMsg(
                            "auto.features.submit.components.modelconfigmodal.recent.remove",
                            { model: rc.name.split("/").pop() ?? rc.name },
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveRecent(rc.name);
                          }}
                          className="close-button [--close-btn-size:20px] [--close-btn-radius:6px] [--close-btn-icon:12px] ms-0.5"
                        >
                          <X />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <Separator />
            </div>
          )}

          {!nameOnly && (
            <>
              <div className="space-y-2">
                <Label className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                  {msg("billing.mode.label")}
                </Label>
                <div data-tutorial="model-billing-source">
                  <Segmented<TokenSourceMode>
                    label={msg("billing.mode.aria")}
                    value={mode}
                    onChange={(value) =>
                      setDraft((current) =>
                        withoutInlineConnection({
                          ...current,
                          name: "",
                          token_source: value,
                          byok_provider: undefined,
                        }),
                      )
                    }
                    options={TOKEN_SOURCE_SEGMENTS.map(({ mode: value, icon: Icon, labelKey }) => ({
                      value,
                      label: msg(labelKey),
                      icon: <Icon className="size-3.5" aria-hidden="true" />,
                    }))}
                  />
                </div>
                {mode === "managed" && (
                  <div className="flex items-center gap-2 rounded-md bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
                    <span className="min-w-0 flex-1">{msg("billing.mode.managed_hint")}</span>
                  </div>
                )}
              </div>

              {mode === "byok" && (
                <div className="flex items-center gap-2 rounded-md bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1">{msg("billing.mode.byok_hint")}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => {
                          onOpenChange(false);
                          openTo("providers");
                        }}
                        aria-label={msg("billing.mode.manage_keys")}
                        className="size-8 inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/60"
                      >
                        <Key className="size-4" aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{msg("billing.mode.manage_keys")}</TooltipContent>
                  </Tooltip>
                </div>
              )}
            </>
          )}

          <div className="space-y-2">
            <Label>
              <HelpTip text={tip("model_config.model")}>
                {msg("auto.features.submit.components.modelconfigmodal.4")}
              </HelpTip>
            </Label>
            <ModelPicker
              value={draft.name}
              selectedByokProvider={draft.byok_provider}
              onChange={(next) => {
                setDraft((p) => {
                  const ladder = effortsFor(next).filter((level) => level !== "none");
                  const rest = { ...p.extra };
                  const effort = rest.reasoning_effort as string | undefined;
                  if (!modelSupportsThinking(next, detectionModels) || ladder.length === 0) {
                    delete rest.reasoning_effort;
                  } else if (effort && !ladder.includes(effort)) {
                    rest.reasoning_effort = defaultEffort(ladder);
                  }
                  return { ...p, name: next, extra: Object.keys(rest).length ? rest : undefined };
                });
              }}
              onSelect={(model) =>
                setDraft((current) => ({
                  ...current,
                  byok_provider: mode === "byok" ? (model.byok_provider ?? undefined) : undefined,
                }))
              }
              byokMode={mode === "byok"}
              byokProviders={byokProviders}
              placeholder={msg("auto.features.submit.components.modelconfigmodal.literal.3")}
            />
          </div>

          {!nameOnly && !modelDefaultsOnly && (
            <>
              <Separator />

              <Disclosure
                id={parametersId}
                label={msg("auto.features.submit.components.modelconfigmodal.section.parameters")}
                open={parametersOpen}
                onOpenChange={setParametersOpen}
              >
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor={`${parametersId}-temperature`}>
                      <HelpTip text={tip("model_config.temperature")}>
                        {msg("auto.features.submit.components.modelconfigmodal.5")}
                      </HelpTip>
                    </Label>
                    <NumberInput
                      id={`${parametersId}-temperature`}
                      min={0}
                      max={2}
                      step={0.1}
                      value={draft.temperature ?? ""}
                      onChange={(value) =>
                        setDraft((current) => ({ ...current, temperature: value }))
                      }
                      onClear={() =>
                        setDraft((current) => ({ ...current, temperature: undefined }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${parametersId}-max-tokens`}>
                      <HelpTip text={tip("model_config.max_tokens")}>
                        {msg("auto.features.submit.components.modelconfigmodal.7")}
                      </HelpTip>
                    </Label>
                    <NumberInput
                      id={`${parametersId}-max-tokens`}
                      min={1}
                      step={256}
                      value={draft.max_tokens ?? ""}
                      onChange={(value) =>
                        setDraft((current) => ({ ...current, max_tokens: value }))
                      }
                      onClear={() => setDraft((current) => ({ ...current, max_tokens: undefined }))}
                    />
                  </div>

                  {canThink && (
                    <>
                      <Separator />
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label>{msg("auto.features.submit.components.modelconfigmodal.8")}</Label>
                          <Switch checked={thinkingEnabled} onCheckedChange={setThinking} />
                        </div>
                        {thinkingEnabled && (
                          <div className="space-y-2 p-3 border rounded-lg bg-muted/30">
                            <Label>
                              {msg("auto.features.submit.components.modelconfigmodal.9")}
                            </Label>
                            <Segmented
                              label={msg("auto.features.submit.components.modelconfigmodal.9")}
                              value={reasoningEffort}
                              onChange={setEffort}
                              options={effortLadder.map((val) => ({
                                value: val,
                                label: effortLabel(val),
                              }))}
                            />
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </Disclosure>
            </>
          )}
        </div>

        <DialogFooter className="border-t border-border/40 px-4 pb-4 pt-4 sm:px-6 sm:pb-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {msg("auto.features.submit.components.modelconfigmodal.10")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              !draft.name.trim() ||
              (!nameOnly &&
                !modelDefaultsOnly &&
                ((draft.temperature != null &&
                  (!Number.isFinite(draft.temperature) ||
                    draft.temperature < 0 ||
                    draft.temperature > 2)) ||
                  (draft.max_tokens != null &&
                    (!Number.isInteger(draft.max_tokens) || draft.max_tokens < 1))))
            }
          >
            {msg("auto.features.submit.components.modelconfigmodal.11")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
