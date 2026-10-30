# Skynet Repository Reflection Contract (Plugin-specific)

Read `.autosaddler/session_context.json` for the parent, child, selection,
diagnosis, matched training scores, acceptance reason, and aggregate
development scores when available.

Return lessons using the supplied Skynet reflection schema. Useful scopes
include code correctness, behavior on specific inputs, performance, scorer
expectations, and mutation safety. `evidence_case_ids` may contain only
training case IDs supplied in the current context.
