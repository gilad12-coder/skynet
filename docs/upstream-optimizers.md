# Upstream optimizer execution

This is the engine integration stage of the submission-wizard refactor, stacked after the four-stage wizard, contract/model/budget controls, and durable drafts. It implements the approved dependency pin and the later decision to offer **both worker and Vercel execution for Meta-Harness and AutoResearch**. Runtime selection belongs inside Optimization; it does not restore the removed Target stage.

## Execution authority

All engines use GEPA commit [`0632cdb5dcc052e690eab439e1b4a7e3e9cfe407`](https://github.com/gepa-ai/gepa/tree/0632cdb5dcc052e690eab439e1b4a7e3e9cfe407). Its package metadata still says `0.1.4`, but released `0.1.4` does not provide this engine surface. `pyproject.toml`, `uv.lock`, both pip lockfiles, the staged runtime source, and provenance metadata must agree on the commit. Do not replace this pin with `gepa==0.1.4` or a floating branch.

Skynet owns input validation, model routing, execution transport, outer accounting, progress translation and result persistence. Candidate proposal, native agent prompts, history inspection, search and aggregate winner selection remain upstream. An engine failure propagates; there is no fallback to the removed local Meta-Harness loop.

| Choice | Execution authority | Candidate shape | Model/runtime contract | Recovery claim |
| --- | --- | --- | --- | --- |
| GEPA | Pinned `gepa.gepa_launcher.optimize_anything` | Text or named components | Existing metered optimization model; native GEPA trajectory/state artifacts | State can recover an interrupted local evaluation-budget boundary; this PR does not implement automatic worker restart |
| Best-of-N | Pinned `gepa.oa.engines.best_of_n.BestOfNEngine` | Text | Upstream sampling client reaches the configured metered model through authenticated loopback transport | No cross-job resume |
| Meta-Harness | Pinned `gepa.oa.engines.meta_harness.MetaHarnessEngine` | Text | Claude Code proposer, selected managed model, worker OS jail or Vercel microVM | No persisted-job resume API at this pin |
| AutoResearch | Pinned `gepa.oa.engines.autoresearch.AutoResearchEngine` | Text | Same execution/model transport; upstream controls the research session | In-run Ralph continuation is not persisted-job recovery |
| Auto | Published omni-GEPA recipe | Text | All three GEPA/AutoResearch/Meta-Harness lanes must be available | No composed restart implementation |
| Plateau | Pinned `optimize_adaptive_sequential` helper | Text | Same three engines; upstream aggregate-score scheduler with the supplied patience | No composed restart implementation |

The [pinned omni example](https://github.com/gepa-ai/gepa/blob/0632cdb5dcc052e690eab439e1b4a7e3e9cfe407/docs/docs/blog/posts/2026-07-22-optimize-anything-omni/index.md) runs three equal exploration allocations through `optimize_best_of`, then a fresh GEPA continuation. Skynet assigns a quarter of the proposer allowance to each phase, partitions scorer calls into four allocations (integer remainder to continuation), and requires at least four scorer calls. Best-of-N is an independent selectable baseline, not a substitute exploration lane. Missing native capability blocks the recipe instead of silently reducing it.

This establishes execution fidelity to the pinned implementation. It does not establish numerical reproduction of the Meta-Harness paper's experiments; dataset, evaluator, model and budget differences remain relevant.

## Worker and Vercel transport

`BlackboxRunRequest.proposer_runtime` is `worker` (default) or `vercel`. Historical payloads that omit it use worker capability checks; unsupported historical combinations fail explicitly. Existing stored results are not rewritten.

The worker runtime creates a private temporary home, stages the approved GEPA source, and runs the unchanged native engine in a subprocess. Upstream OS isolation stays enabled: Linux needs usable `bubblewrap`, not just an installed binary. The image installs Node `22.22.0` and Claude Code `2.1.259`. A deployment whose kernel/container policy prohibits the jail reports worker unavailability. It does not run an unjailed host fallback.

The Vercel runtime stages the same source into a managed microVM and installs the same pinned CLI. Upstream's additional host-jail flag is disabled inside this already isolated microVM. Setup and execution share the sandbox lifetime; expiry, setup failure and process failure close the session. Source archives are created from the verified installed pin rather than fetching upstream main at job start. Air-gap source/npm mirrors are documented in `AIRGAP.html`.

The child hosts the real upstream evaluation server. Its evaluator sends nonce-framed JSON requests to the parent; the parent performs budgeted scoring and writes UUID-addressed response files. Requests are deduplicated, partial output is buffered, response waits are bounded, and a parent scorer failure stops native descendants. No public callback endpoint or inbound tunnel is opened. Held-out test examples are never included in the child task.

The gateway URL and authentication configure the CLI's Anthropic-compatible transport. The selected model ID is forwarded unchanged. Native strategies currently require managed routing; BYOK cannot silently use a managed shared key. Native model controls expose selection only, because unsupported temperature/token fields must not appear to govern the CLI. Provider compatibility still requires a deployment smoke test with its actual gateway.

## Capabilities and UX

`GET /blackbox/engines?target=text&proposer_runtime=worker` returns:

- Each engine's availability, reason and named-components support.
- Both runtime options with their individual availability reasons.
- The immutable upstream revision.
- The exact `auto_engines` list, plus `auto_available` and `auto_unavailable_reason`.

The wizard associates catalog responses with the requested target/runtime so a late response cannot authorize a different setup. AutoResearch remains visible. Native engines and compositions show the compact runtime control in Optimization and the chosen runtime in Review. Drafts, clones and payloads retain it. Meta-Harness is no longer gated on the old `target.kind=agent` choice.

Meta-Harness requires training examples when a dataset is supplied; Auto and Plateau inherit that requirement. Validation-only GEPA and AutoResearch runs remain supported. The adapter does not move examples between splits to satisfy an engine. The optional iteration cap applies only to single Meta-Harness runs. Other choices omit that control and reject an explicit API iteration cap, because the pinned implementations do not enforce it as a run-wide limit.

## Evidence, costs and remaining specification work

Native raw workspaces, evaluation artifacts and Claude sessions are copied out before cleanup, subject to an explicit bounded artifact size. Only upstream aggregate checkpoints become candidate progress. Per-example maximum scores are not promoted to optimizer incumbents. Missing/partial evaluation evidence produces no fabricated aggregate. Best-of-N's upstream no-result `0.0` becomes an absent score when there is no completed scoring row. Circular upstream ensemble references and non-finite schedule sentinels are normalized before JSON persistence.

For a native single-task result, the returned candidate and score must match a completed upstream evaluation record. An untested final file fails this fidelity check; Skynet does not re-rank candidates or substitute a different winner. A run without a seed cannot succeed with an empty, unevaluated incumbent.

Native model usage is reconciled from CLI artifacts, deduplicated, retained on errors, and accumulated in a shared locked ledger across parallel lanes. Missing reconciliation fails explicitly. Existing token-accounting paths receive that usage. Known cumulative costs are checked between engine invocations, and fresh proposer allowances are clamped to the remaining run allowance.

**This PR does not complete the hard budget/reservation and recovery sections of the wizard specification.** Upstream native proposer costs become known after a CLI invocation; the current billing system still has token-based pricing, cache/model attribution limitations, post-call ceilings and success-only terminal settlement. Existing baseline/final scoring semantics also remain outside the optimizer's scorer-call cap. These are not exact pre-dispatch all-cost guarantees. The next backend stage must implement the shared setup/run ledger, reserve bounded in-flight work, settle failed/cancelled/interrupted work, preserve evaluated incumbents at a normal budget stop, and add checkpoint-based recovery only for engines that actually support it. Production enablement must be reviewed with those limitations visible.

## Verification

Tests compare the adapter with direct calls to the same pinned upstream implementations using deterministic model sequences. Native integration tests run the real Meta-Harness and AutoResearch engines with a fake CLI and loopback evaluator; they test aggregate winners, parent abort, timeouts, usage reconciliation, archive safety, shared usage and cleanup. Submission/model tests cover runtime/model/budget gates before scorer construction. The worker image smoke checks pinned dependencies and executable availability.

No live provider or Vercel optimization is claimed by these tests. A paid deployment smoke should confirm the selected gateway/model, Linux jail capability and managed microVM behavior before enabling native execution in production.
