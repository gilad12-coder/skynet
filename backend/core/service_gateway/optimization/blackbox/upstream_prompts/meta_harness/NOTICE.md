# Meta-Harness proposer skill

`SKILL.md` is the unmodified proposer skill from
https://github.com/stanford-iris-lab/meta-harness at revision
`0cbc31e97c9e6d24232d1dc754827c02e1ec415c`
(`reference_examples/text_classification/.claude/skills/meta-harness/SKILL.md`),
redistributed under the MIT License in `LICENSE`.

`native_engines.py` derives the sandbox skill from this file at run time through
exact-snippet substitutions that only rename the text-classification specifics
(memory systems, datasets, `config.yaml`, the `uv run` import check). Bumping the
pinned revision must keep the checksum test in `tests/test_native_engines.py`
and the substitution table in sync.
