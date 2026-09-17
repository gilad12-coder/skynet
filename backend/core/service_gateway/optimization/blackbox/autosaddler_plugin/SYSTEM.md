# Skynet Candidate Context (Plugin-specific)

The active candidate is a Skynet blackbox version: one or more named text
components (a prompt, an instruction file, or a set of prompt parts) that a
user-owned scorer evaluates case by case. The scorer runs outside this
workspace, on the user's own runtime, and reports a numeric score plus written
feedback for every case. Higher scores are better.

## What The Candidate Controls (Plugin-specific)

The candidate text is the only lever. It becomes the instruction the scored
system follows, or the agent instruction file a harness executes, on every
case. Nothing in this workspace runs the scorer, and no file outside
`candidate.json` influences the score.

`candidate.json` in the current workspace maps each component name to its
current text. Every component listed in `.autosaddler/session_context.json`
under `mutation_scope` may be rewritten; component names are frozen and no
component may be emptied.

## Objective And Background (Plugin-specific)

`.autosaddler/session_context.json` carries the user's `objective` and any
`background` notes. Treat them as the authoritative description of what the
scorer rewards. Case payloads in the training evidence show the exact inputs
the scored system received.
