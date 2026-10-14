---
name: candidate-patch
description: "Edit the Skynet repository in response to a causal diagnosis, keeping every behavior the scorer already rewards."
---

# Skynet Repository Patch (Plugin-specific)

## Mutation Boundary (Plugin-specific)

Only files under the paths in `mutation_scope` may change. Do not touch
anything outside them or under `readonly_paths`, create symbolic links, or
edit files under `.autosaddler/`. The scorer rebuilds each version from the
repository's tracked files and new files the repository does not ignore, so
ignored build output never counts. Every changed text file must be UTF-8.

## Patch Discipline (Plugin-specific)

Make one coherent change that addresses the diagnosed cause. Prefer precise
edits over rewrites when the diagnosis is local. Keep the repository working:
the scorer runs the same setup on every version, so a change that breaks an
import or the build scores nothing.
