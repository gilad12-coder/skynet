---
name: candidate-patch
description: "Rewrite Skynet candidate components in response to a causal diagnosis, keeping every behavior the scorer already rewards."
---

# Skynet Candidate Patch (Plugin-specific)

## Mutation Boundary (Plugin-specific)

Only the components named in `mutation_scope` may change, and each must keep
non-empty text. Do not add, rename, or remove components. Do not reference
files, tools, or runtime state that the scored system cannot see: the scorer
only ever receives the component text and the case input.

## Patch Discipline (Plugin-specific)

Make one coherent change that addresses the diagnosed cause. Prefer precise
additions over wholesale rewrites when the diagnosis is local. When feedback
shows format or schema violations, state the required output shape
explicitly. When feedback shows the system solved a different problem than
the case asked, sharpen the task framing before adding rules.

Return the complete new text of every component you changed. Partial text or
diff notation is invalid.
