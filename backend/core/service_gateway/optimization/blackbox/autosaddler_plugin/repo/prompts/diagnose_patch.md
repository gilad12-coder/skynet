# Skynet Repository Mutation Task (Plugin-specific)

Read `.autosaddler/session_context.json` for the objective, background, and
mutation scope, `.autosaddler/training_evidence.json` for the per-case scores
and scorer feedback, and the core history manifest. Read the repository's code
in the workspace.

Diagnose, using the core diagnosis procedure, why the weakest training cases
score as they do, then edit the implicated files in the workspace as one
coherent change. Keep everything that already earns credit; the matched-strict
gate rejects a change that trades one case for another.

Run the `patch-verification` procedure after editing. Return `intent`, causal
`diagnosis`, `expected_effect`, and `changed_paths` listing every
repository-relative file you created, edited, or deleted, and nothing else.
Use the supplied Skynet output schema.
