# Skynet Repository Context (Plugin-specific)

The active candidate is a version of a user's Git repository. A user-owned
scorer outside this workspace checks out each version, runs the repository's
own setup, and evaluates it case by case, reporting a numeric score plus
written feedback for every case. Higher scores are better.

## What The Candidate Controls (Plugin-specific)

The candidate is the repository's files as they stand in the current
workspace. Edit them in place; what you leave in the workspace becomes the new
version. Nothing in this workspace runs the scorer, and there is no network,
so do not try to install dependencies or run the scorer here.

Only the paths listed in `.autosaddler/session_context.json` under
`mutation_scope` may change (`.` means the whole repository). Paths under
`readonly_paths` (submodules and Git LFS files) stay as fetched. A version
that changes anything else is rejected before it is scored.

## Objective And Background (Plugin-specific)

`.autosaddler/session_context.json` carries the user's `objective` and any
`background` notes. Treat them as the authoritative description of what the
scorer rewards. Case payloads in the training evidence show the exact inputs
the scorer ran the repository on.
