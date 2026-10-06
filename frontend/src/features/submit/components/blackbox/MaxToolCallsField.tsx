"use client";

import { NumberInput } from "@/shared/ui/number-input";
import { msg } from "@/shared/lib/messages";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import { DEFAULT_PROPOSER, MAX_TOOL_CALLS_LIMITS } from "../../lib/engine-contract";
import { Field } from "./shared";

/**
 * The per-candidate tool-call cap. The proposer settings and ShinkaEvolve's
 * agent editor both show it, and both edit the one `proposer.max_tool_calls`.
 */
export function MaxToolCallsField({
  w,
  id = "bb-proposer-tool-calls",
}: {
  w: BlackboxWizardContext;
  id?: string;
}) {
  const { proposer, updateProposer } = w;
  return (
    <Field
      label={msg("submit.blackbox.proposer.max_tool_calls")}
      htmlFor={id}
      tip="submit.blackbox.proposer_max_tool_calls"
    >
      <NumberInput
        id={id}
        value={proposer.max_tool_calls ?? DEFAULT_PROPOSER.max_tool_calls ?? ""}
        onChange={(value) => updateProposer({ max_tool_calls: value })}
        onClear={() => updateProposer({ max_tool_calls: DEFAULT_PROPOSER.max_tool_calls })}
        min={MAX_TOOL_CALLS_LIMITS.min}
        max={MAX_TOOL_CALLS_LIMITS.max}
        step={10}
      />
    </Field>
  );
}
