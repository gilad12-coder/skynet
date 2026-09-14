---
name: patch-verification
description: "Verify a Skynet candidate patch before returning it: complete component text, frozen schema, and a diagnosis the diff actually implements."
---

# Skynet Patch Verification (Plugin-specific)

## Checks (Plugin-specific)

- Every key in `updates` appears in `mutation_scope` and its value is the
  complete, non-empty replacement text.
- At least one component differs from `candidate.json`.
- The rewritten text still covers every case the evidence shows scoring
  well; nothing that earned credit was removed without a stated reason.
- `intent`, `diagnosis`, and `expected_effect` describe exactly the change in
  `updates` and nothing more.
