# Skynet Mutation Task (Plugin-specific)

Read `.autosaddler/session_context.json` for the objective, background, and
mutation scope, `.autosaddler/training_evidence.json` for the per-case scores
and scorer feedback, and the core history manifest. Read `candidate.json` for
the current text of every component.

Diagnose, using the core diagnosis procedure, why the weakest training cases
score as they do, then rewrite the implicated components as one coherent
change. Keep everything that already earns credit; the matched-strict gate
rejects a rewrite that trades one case for another.

Run the `patch-verification` procedure after drafting. Return `intent`, causal
`diagnosis`, `expected_effect`, and `updates` mapping every rewritten
component name to its complete new text. Components that are not changed must
be omitted from `updates`. Use the supplied Skynet output schema.
