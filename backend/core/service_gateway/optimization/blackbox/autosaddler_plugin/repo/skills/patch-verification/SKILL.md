---
name: patch-verification
description: "Verify a Skynet repository change before returning it: allowed paths only, a real change, and a diagnosis the edit actually implements."
---

# Skynet Repository Patch Verification (Plugin-specific)

## Checks (Plugin-specific)

- Every changed file lies inside `mutation_scope` and outside
  `readonly_paths`, and `changed_paths` lists exactly the files you changed.
- The workspace differs from the version you started from.
- Re-read every edited file: the code still parses, imports resolve, and
  nothing that earned credit was removed without a stated reason.
- `intent`, `diagnosis`, and `expected_effect` describe exactly the change in
  the workspace and nothing more.
