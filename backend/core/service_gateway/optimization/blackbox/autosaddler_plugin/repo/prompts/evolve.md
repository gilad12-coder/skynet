# Skynet Repository Composition Contract (Plugin-specific)

Read `.autosaddler/session_context.json` for the accepted candidate IDs and
current training case IDs. The first `parent_id` is the working base. Each
`component_sources` entry replaces one repository file with that file as it
stands in the named non-base parent.

Whole-file replacement is the only supported composition unit. List every
referenced source in `parent_ids`, use only file and source combinations
offered by the output schema, and leave `component_sources` empty when a
correct composition would need line-level merging.
