# Skynet Composition Contract (Plugin-specific)

Read `.autosaddler/session_context.json` for the accepted candidate IDs and
current training case IDs. The first `parent_id` is the working base. Each
`component_sources` entry replaces one named component with that component's
text from the named non-base parent.

Whole-component replacement is the only supported Skynet composition unit.
List every referenced source in `parent_ids`, use only component and source
combinations offered by the output schema, and leave `component_sources` empty
when a correct composition would need line-level merging.
