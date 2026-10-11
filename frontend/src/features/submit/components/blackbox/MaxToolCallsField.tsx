"use client";

import { NumberInput } from "@/shared/ui/number-input";
import { msg } from "@/shared/lib/messages";

import { DEFAULT_PROPOSER, MAX_TOOL_CALLS_LIMITS } from "../../lib/engine-contract";
import { Field } from "./shared";

/**
 * The per-candidate tool-call cap. The proposer settings and ShinkaEvolve's
 * agent editor both show it, and both edit the one `proposer.max_tool_calls`.
 */
export function MaxToolCallsField({
  value,
  onChange,
  id = "bb-proposer-tool-calls",
}: {
  value: number | null | undefined;
  onChange: (value: number | null | undefined) => void;
  id?: string;
}) {
  return (
    <Field
      label={msg("submit.blackbox.proposer.max_tool_calls")}
      htmlFor={id}
      tip="submit.blackbox.proposer_max_tool_calls"
    >
      <NumberInput
        id={id}
        value={value ?? DEFAULT_PROPOSER.max_tool_calls ?? ""}
        onChange={onChange}
        onClear={() => onChange(DEFAULT_PROPOSER.max_tool_calls)}
        min={MAX_TOOL_CALLS_LIMITS.min}
        max={MAX_TOOL_CALLS_LIMITS.max}
        step={10}
      />
    </Field>
  );
}
