# Submission wizard: implementation specification

Version 1.4, 2026-09-03. Product decisions D01–D08c are approved, with the subsequent implementation decisions in section 16 taking precedence where they refine an earlier requirement. Implementation is in progress in the PR stack and the `codex/wizard-budget-lifecycle` worktree. This document distinguishes implemented source, tested behavior, live-provider evidence, and deployment evidence; production completion has not been established.

## 1. Confirmed requirements

1. Refactor the submission experience and remove redundant choices.
2. Use the agreed Goal → Evaluation → Optimization → Review structure, resolving model/test dependencies within those stages through D03's scoped validation policy.
3. Remove the generic Scored directly / Run by an agent Target selector from the primary flow.
4. Treat hosted sandbox execution as automatic infrastructure, not a per-run user choice.
5. Auto means optimize_anything's Auto behavior. Do not invent a replacement search strategy.
6. Preserve the algorithms. Meta-Harness must follow its paper-defined behavior; existing implementation limitations are not its specification.
7. Ask the user about consequential open questions as they arise, one at a time. Do not describe unresolved implementation choices as settled.
8. Include AutoResearch in the wizard despite its incomplete implementation. Its inclusion is explicitly requested and does not depend on D01.
9. Use pinned upstream implementations as the execution authority. Replace Skynet's local algorithm reimplementations where necessary, while retaining Skynet's sandboxing, model routing, billing, progress, and results integration. Verify fidelity and compatibility rather than redesigning algorithms. User explicitly approved this scope.
10. Preserve the existing initial carousel with visible Anything and DSPy program entries. It precedes the four-stage wizard. Do not replace it with an inline workflow selector in Goal; the user explicitly likes the initial carousel.
11. Run the applicable setup tests automatically when the user presses Continue, including model or sandbox calls. Do not require a separate Test setup click or another confirmation dialog.
12. Notify the user of Continue-triggered validation through toast messages. Show validation progress and the success/failure outcome; preserve useful field-level error details.
13. Save unfinished setup across refresh/browser reopening and offer an actionable restore toast with Continue draft and Start new. Do not expire drafts by age. Continue draft restores the previous setup; Start new clears the saved wizard draft and starts fresh. The user explicitly replaced the expiry-research request with this policy.
14. Minimize model selection around the task model and optimization model. Reveal an additional scorer-model choice only when the actual evaluator needs a separate model. Reflection, feedback, grading and proposer labels must not create redundant model pickers. The user asked to verify the algorithm-specific requirements rather than assume every algorithm needs three models.
15. Default an LLM scorer to the compatible Optimization model, retaining a separate-model override. Clearly show the actual model serving each role and explain why that role uses it. The user explicitly approved shared model selection and emphasized role clarity.
16. Use one spending budget for setup validation and the optimization run together, including billable sandbox usage. Show setup spent, run spent and remaining budget. Setup spending reduces the allowance carried into the run; it does not sit outside the selected budget. For BYOK roles, Total covers Skynet's platform fee and sandbox usage; the model provider charges token usage directly through the user's key outside Skynet's budget. This confirms scope, not a new fee, price or guarantee about in-flight overruns.
17. The user funds actual usage. Determine the required credit reservation and headroom before admitting work; do not rely on Skynet absorbing overruns. Reserve within the selected budget and available account balance, settle actual usage once, and release unused headroom. An adaptive run's exact eventual usage is not knowable upfront, so its estimate must remain distinct from an enforceable per-operation cost bound.
18. When the budget cannot cover the next operation, finish with Budget reached and preserve the best completed/evaluated candidate available so far. Show only actual scores and identify incomplete or unperformed evaluation. A normal budget stop is not an execution failure; if no candidate finished evaluation, report that plainly.
19. Automatically recover temporary infrastructure interruptions from a compatible checkpoint when the pinned optimizer supports true recovery and the remaining budget can fund it. Preserve the same run, settings, search state and cumulative spend. Bound retries and notify the user of recovery; do not automatically restart from scratch or resume an explicit pause/cancel or Budget reached stop.

## 2. Current implementation and exact change surfaces

Repository: /Users/giladmorad/PycharmProjects/Skynet-gilad12-coder. The implementation branch is `codex/wizard-budget-lifecycle`, stacked on the pinned-runtime work in PR #400. PRs #398–#400 are review dependencies and have not been merged by this specification. Recheck the final commit and PR state before deployment; branch-local test results do not establish production behavior.

All paths below are relative to that repository root.

| Surface | Current responsibility | Required change |
| --- | --- | --- |
| frontend/src/features/submit/components/SubmitEntry.tsx | Preliminary recipe screen; mounts DSPy or Anything wizard; clone/deep-link selection | Preserve the initial carousel and its transitions; enter Goal after selection; preserve deep links, clone preselection and drafts |
| components/RecipePicker.tsx | DSPy/Anything recipe carousel and selected-recipe chip | Retain the carousel, current labels and Change affordance; avoid adding another equivalent workflow selector inside Goal |
| lib/wizard-steps.ts | Numeric indices for seven semantic step IDs; DSPy and Anything have different order | Introduce four semantic stage IDs; explicitly map old states and update every consumer |
| components/SubmitWizard.tsx and components/blackbox/BlackboxWizard.tsx | Separate renderers using shared navigation | Retain workflow-specific rendering; combine fields by stage instead of forcing both backends into one form model |
| components/SubmitStepper.tsx and SubmitNav.tsx | Reachability, validation, back/next, submission | Four visible stages, named validation destinations, accurate completion state and inline errors |
| hooks/use-submit-wizard.ts | DSPy form state, column mapping, authoring, validation, payloads, draft persistence | Rehome fields and gates while preserving DSPy run/grid-search behavior |
| hooks/use-blackbox-wizard.ts | Candidate, scorer, target, strategy, budgets, clone, dry-run, payload | Remove UI-owned Target mode; derive required configuration from task/algorithm contract; preserve explicit evaluation semantics |
| components/blackbox/BlackboxStartStep.tsx, BlackboxScorerStep.tsx and BlackboxOptimizerStep.tsx | Separate target, scorer and reflection model controls | Present Task model and Optimization model once where needed; reveal a separate scorer override only for an evaluator that needs it; preserve the actual role of existing scorer.model calls |
| lib/wizard-draft.ts | DSPy draft singleton; 30-minute TTL; best-effort locale-reload stash | Add versioned durable local recovery for both workflows; remove age-based expiry from the new recovery path; restore only after the toast action |
| frontend/src/shared/providers/toast-container.tsx | Shared react-toastify container; 4-second auto-close, body-click close and dragging by default | Reuse the shared provider; override behavior only for the actionable draft toast so the choice persists and buttons have unambiguous actions |
| lib/clone-payload.ts | Shared basics, rows, column order, and input/output restoration | Preserve cross-workflow clone semantics and private defaults; restore configuration before computing visibility |
| components/steps/SplitSection.tsx and SplitRecommendationCard.tsx | Dataset split recommendation and advanced manual controls | Embed within Evaluation; preserve recommendation calculation and manual overrides |
| frontend/src/shared/lib/api.ts | Submission, scorer test, engine catalog requests | Keep existing endpoints where possible; extend evaluation preflight/catalog contracts only where needed |
| components/CostCeilingCard.tsx and lib/cost-bracket.ts | Estimated credit range and optional run-only ceiling | Present one shared setup/run budget before first billable Continue; keep estimates separate from server-reported spending and remaining allowance |
| backend/core/billing/, core/api/routers/submissions.py and core/service_gateway/optimization/cost_ceiling.py | Usage metering, account checks, dry-run charging and after-call cost checks | Link setup and run to one authoritative budget; reserve verified worst-case cost/headroom before dispatch and settle actual user-funded usage once |
| backend/core/models/blackbox.py | Candidate, scorer, target, strategy, budget, catalog contracts | Preserve legacy submissions; map to pinned upstream contracts and add compatibility fields only where needed |
| backend/core/api/routers/submissions.py | /blackbox/run, /blackbox/scorer/dry-run, /blackbox/engines | Authoritative preflight, compatible catalog, unchanged identity/idempotency/billing checks |
| backend/core/service_gateway/optimization/blackbox/ | Local engine implementations, strategy, scoring, sandbox adapters | Replace algorithm reimplementations with adapters to pinned upstream engines; retain platform integration |
| backend/core/worker/subprocess_runner.py and engine.py | Dispatch, process supervision, cancellation, persisted events | Add managed job execution without rewriting optimization logic or losing lifecycle guarantees |
| backend/core/models/common.py, blackbox.py, results.py; core/api/routers/optimizations/lifecycle.py; frontend/src/shared/constants/job-status.ts and result views | Job/response schemas, terminal handling, resume eligibility and result presentation | Carry a structured budget stop and optional evaluated result; classify it as terminal, retain actual metrics/artifacts, and gate recovery on real capability and remaining funds |
| frontend/src/features/tutorial/lib/steps.ts and related tutorial source | Selectors and step-linked assistance | Remap to semantic stages; generated tutorial output follows its source workflow |
| i18n/locales/ui/*.json and generated/ui-catalog.ts | Localized strings and typed catalog | Edit source catalogs and run the existing generator; do not hand-edit generated output |

## 3. Engine fidelity: an actual dependency, not a UX choice

The inspected lockfiles pin gepa==0.1.4. Skynet calls gepa.optimize_anything for GEPA but also implements its own Auto, Best-of-N, Meta-Harness, engine registry, and evaluation server. Its AutoResearch registry entry is unavailable because no implementation is installed there.

Skynet's Meta-Harness currently calls ctx.reflection_lm once per proposal. It clips candidates and feedback, shows the most recent six trials plus the best, and explicitly instructs the model to rewrite the instruction files used by a fixed coding agent. These are observed local implementation details, not approved requirements.

The [Meta-Harness paper](https://arxiv.org/abs/2603.28052) describes search over harness code with an agentic proposer that can inspect previous candidates and execution evidence through the filesystem. The [authors' repository](https://github.com/stanford-iris-lab/meta-harness) supplies reference experiments and proposer wrappers.

The inspected [upstream optimize_anything Meta-Harness engine](https://github.com/gepa-ai/gepa/blob/main/src/gepa/oa/engines/meta_harness.py) launches a coding-agent proposer and materializes candidate/history/trace files. This is materially different from Skynet's single reflection-call implementation. The upstream main-branch URL is a discovery reference; select an immutable version before implementation and check paper fidelity rather than assuming it.

The [official omni description](https://gepa-ai.github.io/gepa/blog/) documents engine composition, parallel exploration, and continuation variants. The exact upstream entry point/version behind the product's Auto must be pinned. Do not silently map the user's term to a similarly named local strategy or a DSPy budget preset.

**Decision D01 — approved:** Use pinned upstream implementations as the execution authority, with Skynet providing sandboxing, model routing, billing, progress, and results integration. Replace local algorithm reimplementations where they differ. This is an approved integration and fidelity correction; it is not a redesign of the algorithms.

### D01 implementation contract

| Responsibility | Owner | Implementation rule |
| --- | --- | --- |
| Candidate generation, selection, mutation, proposer instructions and search history | Pinned upstream engine | Invoke the actual engine; do not reproduce its loop in Skynet or replace its proposer with a superficially similar model call |
| Auto composition and engine-specific budget/evaluation semantics | Pinned upstream implementation/configuration | Identify the exact supported upstream recipe and map configuration explicitly; do not retain the local Auto merely because its label matches |
| Algorithm fields and availability | Upstream contracts plus deployment capability checks | Derive supported settings from the pinned version; availability must include required proposer/runtime dependencies |
| Sandbox provisioning, input staging, gateway access and cleanup | Skynet | Provide the environment the engine expects without changing its search behavior |
| Authentication, authorization, user billing and outer run limits | Skynet | Preserve existing protections and accounting; keep platform limits distinguishable from algorithm budgets |
| Progress, logs, trajectories, results and exports | Skynet adapters | Translate actual upstream events/results into existing product views; preserve raw artifacts needed to explain the run |
| Cancellation, expiry and recovery | Skynet supervisor using supported upstream behavior | Stop work reliably; restore only supported engine state; do not claim restart-from-seed is a resume |

Before replacing an engine, record the package version or immutable source commit and pin the sandbox dependencies to it. The exact revision is an implementation research task, not an already selected version. Do not execute from a floating main branch or fetch the newest source at job start.

Create a capability matrix for GEPA, Meta-Harness, AutoResearch, Auto, and other retained supported engines. Include candidate shape, required models/proposer executables, supported parameters, dataset/evaluation semantics, budgets, events, artifacts, and recovery support. AutoResearch stays selectable even if its runtime row is incomplete; its launch gate remains authoritative.

Keep new-run execution on the approved upstream path. If historical payloads need local compatibility handling, isolate that handling and identify its implementation/version explicitly; do not silently fall back to a legacy algorithm when the upstream runner fails. Existing stored results remain unchanged.

Verification must compare an adapter invocation with a direct invocation of the same pinned implementation using deterministic fixtures or recorded/mock model responses where possible. Check forwarded configuration, evaluation counts, budget/stop behavior, resulting candidate and metadata, and event/artifact preservation. A live smoke test proves integration but does not alone establish paper fidelity or identical stochastic results.

If the selected upstream implementation itself diverges from the paper, document the discrepancy and resolve it explicitly before claiming fidelity. Do not patch algorithm semantics inside a platform adapter as an incidental implementation detail.

## 4. Navigation and form ownership

Recommended stage IDs: goal, evaluation, optimization, review. Use IDs for saved state, validation destinations, tutorial targets, and review Edit actions; derive numeric positions for display. Do not leave hard-coded old indices in hooks.

The initial carousel is a workflow-entry screen, outside the four-stage progress indicator. Fresh /submit visits show it first. The selected workflow then opens Goal. Keep the existing Change affordance to reopen the carousel without clearing the current draft.

Migration from the existing seven steps: basics → review; start → goal; cases/scorer/split → evaluation; optimizer → optimization; review → review. Restoration must validate prerequisites and open the first incomplete stage when an old position is no longer reachable. An old draft's step number alone does not prove completion.

Retain the two backend-specific hooks initially. Extract only genuinely shared navigation or field sections; do not build a generic schema-driven form framework. Keep shared fields and workflow-specific fields explicit so switching a presentation mode cannot leak irrelevant configuration into a payload.

Forward navigation validates the current stage, focuses its first error, and retains input. Back navigation does not erase completion evidence that is still valid. Review Edit links target a stage and field. A stage is complete only when its current required inputs validate; merely visiting it is insufficient.

Keep the agreed stage order. With upstream engines, the candidate/evaluator task contract remains separate from the optimizer's proposer implementation. Selecting an agentic optimizer must not automatically change the evaluated artifact into instructions for a separate coding agent. Preserve Evaluation as the place to author success criteria. Continue runs tests for the validation scope whose inputs are complete at that stage; a full execution check that needs later configuration runs when leaving Optimization. Missing later-stage setup does not cause an invented default or erase an evaluator draft. Do not introduce another visible stage or a separate confirmation to trigger these checks.

## 5. Goal: field-level behavior

**Decision D02 — approved with correction:** Keep the existing initial carousel. DSPy program remains directly visible alongside Anything; the user explicitly prefers this carousel. After choosing, enter the four-stage wizard. Do not move the workflow choice into Goal or rename the existing entries as part of this decision.

Detailed entry behavior:

- A fresh /submit visit shows the current carousel and its existing initial ordering. Choosing a slide opens Goal for that workflow.
- Keep current recipe deep-link behavior: a valid direct recipe link can open its workflow; a clone link opens the carousel with the source workflow preselected, as it does today.
- Choosing a workflow does not select an optimizer, change sandbox policy, or launch model work solely as a side effect of carousel navigation.
- Retain the selected-workflow Change control. Reopening the carousel and returning to the same workflow must not reinitialize its hook or restart its interview.
- Switching to another workflow preserves each draft and its authored artifacts. Only the active workflow is serialized into a submission. Shared clone data is hydrated once, not repeatedly merged over user edits.
- Keep the existing carousel styling, controls, transition and reduced-motion behavior. Verify keyboard and RTL navigation when changing its integration with the new stages.
- Do not repeat the Anything-versus-DSPy question inside Goal. Editor format or other genuinely task-specific settings may remain when they have a distinct purpose.
- Do not add Agent or Sandbox as new top-level carousel entries. Optimizer/proposer harness configuration appears where applicable to the selected engine; evaluation of an agent is a separate task contract.

| Field/action | Behavior | Validation and preservation |
| --- | --- | --- |
| Task type/workflow | Inherit Anything or DSPy program from the initial carousel; expose Change to reopen it | Preserve each workflow's draft and existing labels; do not repeat the choice in Goal or guess from code syntax |
| Objective | Plain-language statement of desired improvement | Required for seedless/assisted generation; preserve an explicitly supported seed-only API workflow |
| Starting point | Existing text/code, supported named parts, or assisted creation | Preserve exact content; never trim or rewrite the artifact just for display |
| Supporting context | Optional expandable text | Pass through as background; distinguish from instructions being optimized |
| Editor format | Detect language for editor presentation | Detection must not select the optimizer, evaluator behavior, or sandbox policy |
| Named parts | Existing name/content editor, when the authoritative engine supports it | Validate names and collisions before constructing an object; never silently discard duplicate parts |
| Assisted creation | Existing interview and authoring surface | Preserve manually edited content; apply generated replacements through the established review interaction |
| Existing DSPy workflow | Retain module/workflow configuration | Wait for data and column roles before generating data-dependent signature/metric code |

Do not add repository import, arbitrary ZIP execution, new file types, or automatic task inference merely because a generalized Goal stage makes them conceivable. Those need separate requirements.

## 6. Evaluation: data, scoring, and test evidence

Present data import/library selection, success criteria/scorer authoring, and split controls as sections of one stage. Show counts and a compact preview after import. Keep required column mapping for DSPy; an Anything dataset must not acquire fabricated input/output mappings.

Keep Python and external evaluator support. Show installation/dependency settings only for the relevant evaluator. Preserve existing secret handling; a clone with a scrubbed evaluator credential must ask for the missing credential, not appear executable.

Treat an evaluator as code or an external service, not automatically another model. Show a separate scoring-model control only when the evaluator needs an LLM for judging or generating feedback and that role needs its own selection. Tests, exact-match metrics, parsers and other deterministic feedback do not need a scoring-model picker.

The existing scorer.model supplies the llm helper, which may run the candidate prompt, judge outputs, or do both. scorerCallsModel proves only that the helper is used; it cannot distinguish those responsibilities. Preserve the helper's current binding for existing code and clones. For supported templates/adapters, use their declared call roles to present the task and judge bindings correctly. Do not relabel every existing scorer.model as a third judge, add an extra invocation, rewrite user code, or require another model solely because the helper appears. Details of the reduced model-selection contract are in section 7.

Split controls must show actual row counts and preserve shuffle/seed/manual fractions. Recommendations may update in automatic mode after data changes; manual choices must not be overwritten. Validate nonnegative counts/fractions, the existing sum tolerance, and the resulting feasible dataset sizes. Keep held-out test data out of optimization feedback according to the selected algorithm's contract. Do not relabel train/validation usage to imply isolation that the engine does not provide.

### Two distinct validation scopes

1. Evaluator check: prove that the evaluator accepts an appropriate input and returns a valid score/feedback result.
2. Execution preflight: prove that the configured candidate or agent can run in the selected managed runtime and feed the evaluator correctly.

The existing /blackbox/scorer/dry-run request has scorer, candidate, and case. It does not include target/harness configuration and therefore cannot prove the full agent path. Do not display a full-run Ready state based on that endpoint alone.

Implementation: retain the scorer check for authoring and add or extend a preflight path that carries the effective execution context. Finalize endpoint shape against the pinned adapter contract under approved D01; use the same runner/evaluator integration that real submissions use. Return the validation scope explicitly.

### Validation identity and asynchronous results

The current Anything test key includes scorer code/URL/dependencies/model, but not the tested candidate, selected case, or target/harness. Expand the identity to every input relevant to the validation scope.

For a full execution test that includes: candidate revision; selected example revision; evaluator code/config/dependencies; relevant model configurations; harness/run/setup configuration; engine-specific evaluation contract; runtime image/version. Use a local secret revision or server reference instead of persisting raw credentials in a hash record.

States: idle, running, passed, failed, stale. A field change during a test marks its result obsolete. Ignore responses whose input identity no longer matches the current form; cancel the request where practical. Multiple Continue clicks must share one active check, not create duplicate billable work.

**Decision D05 — approved with correction:** Setup tests run after the user presses Continue, even when they incur model or sandbox costs. Notify the user with toast messages, as explicitly requested. The earlier recommendation for an explicit Test setup action is rejected. Continue owns both validation and successful forward navigation. Preserve the current behavior of staying on the stage when its required test fails; there is no newly introduced Skip validation action.

### Continue implementation

1. Acquire a single in-flight advancement lock before awaiting anything. A second click or keyboard activation joins/ignores that attempt and must not start another model call or sandbox.
2. Run structural checks first: required fields, parsing, compatible configuration, applicable split rules and known capabilities. Focus the first failing field and perform no execution test for an invalid form.
3. Determine which tests this stage can and must establish. Evaluation checks the authored evaluator when its required input/model configuration is complete. Leaving Optimization runs outstanding full execution/proposer-runtime readiness checks using the effective setup. Do not start an optimization search merely to test readiness.
4. Reuse a successful result only if its validation scope, input identity and runtime identity still match. Navigating back and forward through unchanged configuration must not charge for the same test again.
5. If a required result is missing or stale, show Continue as a busy control with meaningful status such as Validating setup. Keep the form visible. Run the sample through the same managed integration path used by real jobs, with the selected model/credential settings.
6. Use a suitable selected non-held-out example. For seedless tasks, perform only the readiness checks valid without a starting candidate and label their scope accurately; do not score the objective as a pretend generated artifact or alter upstream bootstrap semantics.
7. On a current successful result, record its identity/evidence and advance once. On test failure, remain on the stage, display an actionable error near the relevant inputs and release the lock. Pressing Continue again retries after correction or a transient failure; retain the entered work.
8. If the user edits configuration or navigates away while a test is running, cancel where supported and ignore obsolete responses. A late success must not move a user who is now editing a different stage.
9. Preserve optional editor-level test controls that already serve authoring, but do not require them before Continue. No separate payment/approval dialog is added. Any brief usage copy is informational; cost presentation follows D08 and must not invent a price.
10. Preserve test evidence in Review. Final submission rechecks structure/capabilities and current test identities; reuse current successful evidence. If a relevant change invalidated a required check, return to the owning stage or run the same validation path before creating the job. Do not launch from a stale green badge.

### Validation toast lifecycle

- Use the existing application toast system and localized message catalogs. One validation attempt owns one toast ID; update it through the lifecycle rather than stacking a new toast for every subcheck.
- When Continue begins an actual asynchronous validation, show a loading toast such as Validating setup… and keep the Continue button busy. Where useful, its supporting text can identify the current operation, such as testing the evaluator in the sandbox. No additional confirmation is required.
- After all required checks for that advancement succeed against the current configuration, update the toast to Setup validated and advance once. Do not announce full optimization completion or validation of scopes that were not exercised.
- On failure, update the toast to a concise actionable error and stay on the stage. Retain detailed error context near the relevant field or test result so it remains available after the toast closes. Do not expose raw secrets or unfiltered backend logs in a toast.
- A structural field error before execution may use a short error toast plus focused field feedback; do not display a loading toast for a test that never started.
- Reusing an unchanged successful check does not create another running-test toast or imply new work occurred. Navigation can proceed using the current evidence.
- A cancelled or obsolete attempt must not later show a success toast. Dismiss its loading toast or update it to explain that setup changed and Continue should be pressed again. Ignore late results using the same attempt/configuration identity as navigation.
- Ensure every started loading toast reaches a terminal update or dismissal on success, failure, timeout, cancellation or leaving the flow. Preserve existing accessibility/live-region behavior, keyboard access, RTL and reduced-motion conventions.
- Add focused checks for duplicate clicks, progress-to-success, progress-to-failure and stale-response handling. The toast outcome and navigation outcome must be driven by the same validation result.

Unavailable engines are a distinct configuration state, not a failed test. AutoResearch remains selectable/configurable and can reach a Review showing that execution is unavailable. Do not run a known-impossible test, mark it passed, or fall back to another engine. Run stays disabled and backend submission validation enforces the same availability requirement.

## 7. Optimization: contract-driven controls

Default the Anything strategy selection to the confirmed upstream Auto meaning. Preserve DSPy's own optimizer selection and GEPA budget-level meaning; do not conflate them merely because both contain the word auto.

Separate catalog visibility, configuration selection, compatibility, and launch availability. AutoResearch must remain visible and selectable even while its implementation is incomplete. A user can choose it and inspect/edit its applicable settings without losing the rest of the form. If it cannot execute, show a clear availability status and reason and prevent launch; do not silently choose another algorithm. Backend validation must enforce launch availability as well. For Auto, distinguish visible catalog entries from the engines that its authoritative execution recipe can actually invoke; showing AutoResearch is not evidence that Auto can run it.

Query the catalog from the backend; do not duplicate capability rules in frontend conditionals scattered across components. Preserve an unavailable selected engine in draft/clone state instead of clearing it when capabilities load. Configuration screens must not use engine.available as the condition for allowing a selection. The current BlackboxOptimizerStep does disable selection on that flag, so this requires an explicit change to that component and the optimization-stage validation policy.

For AutoResearch, derive parameter names and meanings from the chosen authoritative engine revision. Until that mapping is settled, do not expose invented controls or a simulated runnable implementation. Proposed status wording: Not available to run yet, with the backend reason in supporting text. Authoring/configuration may continue; Review must retain the selection and explain why Run is unavailable. Other form validation still applies normally.

The current catalog offers requires_agent_target and supports_parts. Those fields describe the existing local architecture and are not enough to distinguish an agentic optimizer's proposer from an agent being evaluated. Model these requirements separately once the authoritative engine contracts are chosen. The proposer runner and evaluated runner must not share one field just because both may use the same CLI.

Keep common controls visible: optimizer choice, required model roles, budget, and any task-critical harness configuration. Put applicable concurrency, timeouts, reasoning controls, and detailed algorithm parameters in expandable sections. Do not show parameters an engine will ignore. Preserve unset values as unset rather than silently injecting a new default.

### D04: model responsibilities and minimum selection

**Confirmed direction:** Center the ordinary model-backed setup on two choices: Task model and Optimization model. The user wants the fewest necessary model selections, conditional on the task and chosen algorithm. The previous proposal to automatically inherit the optimizer model from an ambiguously named evaluation model is superseded, not approved.

These are roles, not a requirement for two distinct model IDs or an assertion that every task uses two LLMs. Optimizing a prompt, program or harness around a model does not train that model's weights. A task that only executes ordinary code and uses deterministic tests needs no task-model selection. A scorer that performs deterministic checks needs no judging model. Preserve supported non-reflective DSPy optimizers without adding an unused optimization-model requirement.

Source verification on 2026-09-02:

- [DSPy's GEPA reference](https://dspy.ai/api/optimizers/GEPA/overview/) separates the student program, reflection_lm/custom instruction proposer, and metric. The reflection model analyzes evidence and proposes changes. Feedback can come from the metric's code, logs or checks; a separate feedback-generating LLM is not mandatory.
- [Meta-Harness section 3](https://arxiv.org/html/2603.28052v1#S3) distinguishes the model inside the candidate harness, the task reward function, and the proposer that inspects prior code, scores and traces. The proposer fills the optimization-model role. Do not add a separate GEPA-style reflector or feedback summarizer around it. A task-specific judge can still be model-backed.
- The [upstream optimize_anything configuration](https://gepa-ai.github.io/gepa/api/optimize_anything/OptimizeAnythingConfig/) exposes GEPA reflection configuration and model settings for Meta-Harness and AutoResearch proposers. Those are different engine bindings for the optimization role. Verify their exact supported model/provider settings against the immutable implementation selected under D01; current documentation is discovery evidence, not the execution pin.

| UI role | Responsibility | When a selection is needed |
| --- | --- | --- |
| Task model | Run the prompt, program or candidate harness being improved | The submitted task invokes a platform-configured LLM; omit for non-LLM tasks, and do not duplicate a model already configured in the task |
| Optimization model | Propose improvements; reflection for standard GEPA, agentic proposals for Meta-Harness/AutoResearch | The selected upstream engine requires a configurable proposer/reflection model; one control, with algorithm-specific supporting copy |
| Scoring model | Judge outputs or produce model-generated feedback for the evaluator | Only when the evaluator actually invokes a judging/feedback LLM; reuse a compatible existing selection where approved, and reveal a full picker for a separate override |

Use Task model and Optimization model as the stable primary labels. Supporting text explains the selected algorithm's use of the optimization model. Do not show separate Optimization, Reflection, Feedback, Proposer and Harness model pickers for the same call role. A harness's proposer-model setting binds to Optimization model; a model executed by the candidate harness binds to Task model. The assistant that helps author a draft does not become another run-model choice.

| Setup | Required logical roles and expected selection behavior |
| --- | --- |
| GEPA optimizing a model-backed task with deterministic scoring | Task + optimization; feedback is emitted by the evaluator, with no extra feedback-model selection |
| GEPA optimizing a model-backed task with LLM judging | Task + optimization + conditional scoring; a third distinct selection is needed only for a separate scoring configuration |
| Meta-Harness with a deterministic task reward | Task + optimization/proposer; retain raw execution evidence and do not insert an additional reflector |
| Meta-Harness with a model-backed judge | Same two primary roles plus conditional scoring, just as determined by that evaluator; judging is not a GEPA-only concern |
| AutoResearch or GEPA optimizing non-LLM code with deterministic tests | Optimization/proposer only; do not invent a task-model or scorer-model requirement |
| Auto using several upstream engines | Keep the user-facing optimization choice consolidated where the pinned recipe supports it; verify compatibility for every invoked proposer, preserve the recipe, and do not silently remove an engine or substitute a different model |

The tables describe the ordinary supported single-task-model flow, not a license to collapse existing multi-model program code. Preserve explicit embedded/legacy configuration. This refactor does not introduce a general multi-model program editor or model-search algorithm.

### Model state, routing and compatibility

1. Keep task and optimization selections independent. The user may select the same model for both, but choosing an inexpensive task model must not silently replace an explicitly selected optimization model. No blanket task-to-optimizer inheritance is approved.
2. Bind one visible selection to each actual role. Reuse the existing model picker and configuration object, including credential source and supported parameters. Do not compare only model names when deciding whether two configurations are equivalent.
3. Keep API compatibility explicit. Existing reflection_model_config is the legacy optimization-model configuration, not a separate feedback model. DSPy program/model configuration and legacy target.model are task execution settings. Legacy scorer.model may be task execution or judging, as described in section 6; it cannot be migrated by its field name alone.
4. Where an evaluator needs separate task and judge calls, its platform adapter must carry both effective bindings without changing the meaning of an existing single llm helper. Add only the compatibility fields required by that contract. Do not claim the present single scorer.model already represents two independent models.
5. Record inherited-versus-explicit state for scoring-model reuse. The default scoring binding references the optimization selection rather than copying its current model name. Inherited configuration follows compatible source changes; explicit overrides do not. Preserve cloned explicit configurations even if their model IDs happen to match. Credential material stays out of persisted drafts.
6. Validate compatibility separately for the task runtime, proposer executable and scoring client. A proposer-compatible model is not automatically usable by the evaluator's API client. Show a specific missing/unsupported-model error when needed; do not switch provider, billing source, model or upstream engine silently.
7. Preserve the task model and evaluator when switching optimizers. Reuse the selected optimization model only if the new engine supports it, and explain any required change inline. Hide inapplicable role controls while preserving authored configuration for switching back; exclude inactive roles from new payloads and cost estimates.
8. Show resolved roles and reuse in Review, using the exact configuration used by validation and submission. The same model ID in multiple roles does not mean the roles share a call, a prompt, or an evaluation result. Keep their usage attribution separate; reusing a selection does not eliminate the underlying work.
9. Invalidate test evidence only for affected scopes. Changing a task or scoring model invalidates tests that invoke it. Changing only the optimizer model invalidates proposer readiness and, if scoring inherits it, scoring checks. Ignore in-flight results for obsolete resolved configurations.

### D04a: shared scorer model and visible responsibilities

**Approved:** When an evaluator needs an LLM judge, default its binding to the Optimization model if the configuration is compatible. The user agrees it should be the same and requires clear explanation of which model serves which responsibility and why. Display a compact Scoring model: Same as optimization row with the resolved name and a Use a different model action. Opening that action reveals the third picker; it is not present as another mandatory blank field. Respect an explicitly configured evaluator/clone override. If reuse is unsupported, require a compatible explicit scoring model before that evaluator is executed.

This default must not change what the evaluator scores or replace deterministic feedback with LLM calls. Preserve configured judge prompts, grading parameters and any explicit independence constraints. A shared model selection is a routing default, not a change to GEPA or Meta-Harness.

### Model explanation and interaction details

Keep the explanation immediately below each relevant model row, not only inside a tooltip. Use the actual resolved model name, with a provider qualifier when names are ambiguous. The examples below use placeholders to describe dynamic copy; no specific commercial model is selected by this specification.

| Location/state | Primary text | Supporting explanation |
| --- | --- | --- |
| Task model | Task model · {taskModel} | Runs the prompt, program or harness you are improving. |
| GEPA optimization model | Optimization model · {optimizerModel} | Uses evaluation feedback to propose better prompts or code. |
| Meta-Harness optimization model | Optimization model · {optimizerModel} | Examines previous code, scores and execution traces to propose improved harnesses. |
| AutoResearch optimization model | Optimization model · {optimizerModel} | Drives the selected AutoResearch engine's experiment proposals. Only show claims supported by the pinned implementation. |
| Inherited LLM scoring | Scoring model · {optimizerModel} · Same as optimization | Judges outputs against your evaluation criteria. Reuses your optimization model in separate scoring calls. |
| Explicit LLM scoring | Scoring model · {scorerModel} · Custom | Judges outputs against your evaluation criteria using this separate model configuration. |
| Deterministic scoring | Scoring · Your evaluator | Uses your code or tests to compute scores. No scoring model is needed. |
| Pending inherited scoring | Scoring model · Same as optimization | Uses the model you choose in Optimization. Its setup check will run when you continue from that step. |

- Put the task picker in its owning task configuration and the optimization picker in Optimization. Elsewhere, show a compact resolved-role summary with an Edit link to that existing control; do not render another editable copy. The inherited scoring row opens the explicit scoring override only through Use a different model.
- Mark reuse with text, not color or an unexplained linking icon. Model names, responsibility and reuse status must remain readable with keyboard navigation, assistive technology, long names and RTL layouts.
- Show the scoring summary only when relevant to the authored evaluator. Do not introduce a new question asking every user whether they want an LLM judge, or add a judge merely to fill the row.
- While scoring inherits the optimizer, changing the optimizer updates both resolved model names immediately and invalidates the affected checks. The role description remains stable. An explicit scoring override remains unchanged. Offer Use optimization model to restore inheritance.
- Sharing selects the same model/provider and compatible credential routing; it does not copy an optimizer's system prompt, search history or algorithm-specific reasoning instructions into the judge. Preserve evaluator-specific generation settings and upstream proposer settings. Validate the fully resolved per-role call configuration, including any supported inherited common settings.
- In Review, show one compact role-to-model list, with scoring labeled Same as optimization when applicable. If the same model also serves the task, retain all role labels so the user can see its separate responsibilities without repeating the picker. Do not imply that model weights are being trained or that shared selection means scoring has no cost.
- Toasts and inline test status identify the operation actually running, such as Testing evaluator with {modelName}. A combined check may use a general validation toast with specific phase text; it must not report a scorer check as optimizer search completion.
- Generate these summaries from the same resolved bindings used by preflight, payload building and cost attribution, so copy cannot name a different model from the one invoked. Keep model and provider names untranslated while localizing role text, explanations and actions in the source catalogs.

The ordering consequence is explicit: Evaluation precedes Optimization. An inherited judge whose source has not been chosen is unresolved, not ready. Continue runs structural checks and any executable validation scope, while the model-dependent evaluator check remains visibly pending until leaving Optimization, when the source model is available. Do not select a temporary paid model, perform a duplicate judge selection, claim evaluation passed, or start tests merely from changing a picker. If an explicit task/scoring model is already available, Continue tests that scope immediately. All required pending tests must pass before submission. This uses the existing D03 deferred-scope policy and adds no stage or extra Test setup button.

Budget display must separate a spend cap from an estimate and explain the unit for evaluation counts. In the existing black-box contract, baseline/final test evaluations are outside max_scorer_runs. Current frontend estimates price both shares from the reflection model and do not establish full agent/sandbox cost. Audit accounting before presenting a total-cost guarantee. Do not convert credits, dollars, tokens, and evaluator calls into one field without an explicit conversion policy.

### D08: shared budget for setup and execution

Source observations from the current local code, checked on 2026-09-02; no live charges or production billing checks were performed:

- backend/core/api/routers/submissions.py:blackbox_scorer_dry_run checks the caller's credits and meters returned scorer-model usage as Scorer dry run. This is a separate request before job submission. Its request does not carry the future job's max_cost_credits, so that job cap does not currently include prior setup tests.
- backend/core/service_gateway/optimization/blackbox/service.py constructs a CostCeilingCallback over the reflection LM and scorer usage for the strategy call. The inspected callback binding does not establish coverage of all sandbox usage or agent-provider charges. Baseline and final holdout evaluation calls also sit outside that callback context; cover those explicitly before promising a whole-run ceiling.
- backend/core/service_gateway/optimization/cost_ceiling.py checks accumulated cost after an LM call completes and trips when usage exceeds the cap. This is not evidence of an exact pre-spend limit; concurrent or already-started calls can consume more before the stop takes effect. Stronger cap wording requires matching admission/reservation and settlement behavior.
- frontend/src/features/submit/lib/cost-bracket.ts projects task/reflection token usage heuristically and distinguishes managed/BYOK display. It is an estimate, not a ledger or verified sandbox-cost calculation. Shared scorer/optimizer selection must still account for both roles' calls.

**Approved:** One budget covers setup validation and the submitted optimization together, including sandbox/platform usage that is billable to the user. Show one visible budget with setup spent, run spent and remaining. D08b additionally requires actual admitted usage to be user-funded even if the run later stops without a successful result; the accounting changes needed for that are explicit below. These decisions do not introduce a new rate or charge unused reservations as usage.

### Budget placement and display

1. Keep the four stages. Introduce the compact Total budget field in the existing stage before its first billable Continue, normally Evaluation. If an earlier Continue genuinely executes a scoped setup test, expose the same field there before that work. Do not add a Budget stage or confirmation modal. Unrelated wizard-assistant usage keeps its existing billing policy; do not silently fold it into this new scope.
2. Keep one source of budget state across stages and both workflow views. Optimization edits the same total, not a new run-only allowance. Other locations use a compact summary and Edit link rather than a second independent value. A suggested value may use the existing estimate only when its inputs and coverage are valid; do not invent an arbitrary spending default or label an incomplete estimate as all-inclusive.
3. Label the field Total budget. Supporting text: Includes setup tests and this optimization, including billable sandbox usage. Keep the existing account's credit/currency conventions. Managed roles include their marked-up provider cost. BYOK roles include only Skynet's platform fee; provider token charges are paid directly through the user's key and stay outside Total. The choice of display currency and any price conversion is not changed by this approval.
4. After a test, show Setup spent and Available from the authoritative server response. Before a submitted run exists, Run spent is zero and can be omitted for compactness. In Review and run details, show Setup spent, Run spent and Available together. While work is active, add Reserved for work in progress as a compact explanation so the numbers reconcile. Available excludes reservations and headroom already committed; the settled-spend-only remainder may be shown in details but must not look spendable. A low/high Estimated usage range stays explicitly separate from actual spending and the chosen total.
5. Treat phase and cost type as separate dimensions. Setup spent includes its billable model and sandbox work; Run spent includes that phase's work. A model/sandbox breakdown is a drilldown of those totals, not an additional amount to add again. Reusing one model for scoring and optimization still counts every billable call once.
6. Example using illustrative credits, not a price quote: total 100; setup has used 4; the run starts with at most 96 available before accounting for active reservations. Editing the total to 150 makes the available amount 146, not 150. Reopening a draft or submitting the job does not reset setup spend.
7. Continue-triggered validation uses the agreed loading/success/failure toast. A completed test can include Setup used {amount}; {remaining} remaining when settled amounts are available. Do not invent a precise charge while provider usage is pending. A budget shortage stays inline with an actionable toast and prevents new paid work; there is no automatic top-up or budget increase.

### Authoritative accounting and request integration

Use the existing billing/storage infrastructure. The minimum new linkage is a server-owned budget identity for this setup and its eventual run. This record is accounting metadata, not cloud storage for draft code or datasets. The exact storage/API field names should follow the repository's existing idempotency conventions during implementation.

| Data | Required behavior |
| --- | --- |
| Budget identity and owner | Stable across this draft's tests, restore and submission; ownership enforced by the server on every operation |
| Total and revision | One authorized amount; concurrency control prevents a stale tab or retry from restoring an older limit |
| Setup usage | Accumulated billable test usage, including applicable sandbox work, linked to unique test attempts |
| Run usage | Accumulated billable job usage, including baseline/final evaluation and all invoked upstream engines |
| Active reservations | Account for work admitted but not settled, including parallel calls and runtime allocation |
| Submission linkage | One logical successful submission consumes/transfers the setup linkage atomically; a retry cannot create a second full allowance |

- Extend the existing scorer-test/preflight and submission contracts only as needed to carry that identity, the current budget revision and logical operation identity. Create or recover the accounting record before executing the first billable test. Retrying the same request must resolve to the same record and attempt.
- Compute available-to-start work as max(0, total budget - settled billable setup usage - settled billable run usage - active reservations), using one consistent pricing unit and the server's supported billing policy. Keep account-level credit gates and other active-run commitments in addition to this budget. A run budget is not proof of available wallet balance.
- Reserve before dispatch using an enforceable operation cost bound and required headroom; do not launch a billable path for which these are unknown. Settle actual billable usage and release unused reservations. Carry relevant limits into model routing and sandbox supervision. Every Auto subengine draws from the same parent allowance; do not give each engine the full total independently or alter its upstream search strategy to disguise insufficient budget.
- Preserve upstream evaluation-count, iteration and proposer-budget meanings. The platform spending budget is an outer constraint, not a conversion that replaces those algorithm parameters. Count baseline and final evaluation spending even when upstream excludes those calls from its optimization-evaluation counter.
- Deduplicate charge events separately from client navigation. Reusing valid test evidence incurs no new test; deliberately executing another stale/retried test accounts for that new work once under current billing rules. Submission must not debit setup calls for a second time. Never trust amounts, usage or discount flags submitted by the browser.
- Under D08b, track and settle real billable usage from admitted attempts even if the run later fails, is cancelled or is interrupted. Missing final output is not proof of zero provider usage. Never bill a test that did not start or convert its unused reservation into a charge. Record this change from the present success-only job debit path explicitly in implementation and product copy.
- Keep fully resolved model/provider/credential-source attribution for mixed roles. Preserve BYOK pricing and wallet treatment. The budget UI must state that BYOK provider token charges are outside Total and paid directly through the user's key; Total remains the hard cap for Skynet's platform fee and sandbox usage. This approval does not establish coverage for an unverified custom BYOK route.
- Preserve actual usage and provider-cost evidence alongside user credit charges. D08b rejects routine platform absorption: all properly admitted usage is user-funded from the budget reserved for it. This is not authorization for an unbounded debit, automatic budget increase, a duplicate charge or an invented reconciliation amount.

### Editing, restore and concurrency

- Increasing the total requires an explicit edit by the user and the existing account credit checks. Decreasing it cannot hide already settled spending or invalidate in-flight reservations. If the entered amount cannot support committed work, retain the last accepted total and show the minimum currently supportable amount inline.
- Restoring a draft restores its budget identity and refreshes totals from the server. Cached browser counters are display hints only; an unavailable accounting response prevents new billable work but does not erase the draft. Reconcile a pending test before offering a retry that could duplicate it.
- Start new clears the wizard and detaches its old budget record after the existing reset safeguards. It does not delete ledger entries, refund usage or move old charges into the new setup. Cancel any owned in-flight preflight where supported and settle its reservation; late responses cannot reattach the old draft or alter the new budget.
- A cloned submitted run starts a new accounting identity. It may copy the chosen budget amount as a form value, subject to current validation, but never copies the source run's spending, reservation or executable authority.
- If the user switches between Anything and DSPy inside the same unfinished setup, the shared total remains unchanged and setup spending across those tests remains visible. Only one active workflow becomes the submitted run; switching workflows cannot refresh the allowance.
- On successful submission, atomically attach the setup budget to the run. Retrying an uncertain submission returns the same run and linkage. A second tab must not spend the same remaining allowance on an unrelated second job.

### D08b: reserve sufficient credits and charge actual usage

**Approved with correction:** The user wants the required credits and sufficient headroom determined before execution, with the usage cost borne by the user. The proposal that Skynet routinely absorb an in-flight overrun is rejected. Do not reinterpret this as permission to exceed the selected budget: headroom belongs inside the amount the user has authorized and funded.

Distinguish three quantities: expected usage is a forecast; required reservation is the maximum authorized amount that the next bounded work and its headroom can consume; actual usage is what the provider/runtime reports and the billing policy prices after execution. An adaptive optimization does not have an exactly predictable sequence of future prompts, outputs or runtime activity. Do not promise the exact final bill before it runs.

The [provider token-counting documentation](https://platform.claude.com/docs/en/build-with-claude/token-counting) explicitly describes input counts as estimates, and the [sandbox pricing documentation](https://vercel.com/docs/sandbox/pricing) meters active CPU, provisioned memory, creation, network and snapshot storage. These sources were checked on 2026-09-02. Therefore, counting a prompt and assuming an average completion/runtime is insufficient to guarantee headroom. The platform needs bounded resource settings, applicable rates and actual usage reconciliation.

### Pricing inputs and bounds

| Cost component | Reservation basis and enforcement |
| --- | --- |
| Model input | Price the final provider request, including system text, tool definitions, history and supported media; use a provider-compatible token bound that accounts for counting uncertainty rather than treating the count endpoint as exact |
| Output/reasoning | Use the effective provider-enforced maximum and that provider's billing semantics; account for hidden reasoning and nested/server-side tool behavior without double-counting tokens already included in output |
| Model/provider prices | Verified rates for the actual routed model, provider, pricing tier and request mode; account for applicable cache-write/miss, context-tier and tool charges; do not assume an unguaranteed cache discount |
| Sandbox | Bound the actual CPU/memory allocation and lifetime plus applicable creation, transfer and other metered resources; account for billing granularity and bounded shutdown/export work, not just expected active CPU |
| Retries and agent tool loops | Every new billable attempt obtains coverage before dispatch, or consumes a pre-reserved bounded group allowance; opaque SDK retries cannot bypass admission |
| Required completion work | Keep coverage for cleanup and any algorithm-required final evaluation/export before admitting more search work; do not exhaust the total and then run an unbudgeted final phase |
| Conversion and rounding | Use the same server pricing rules for reservation and settlement, including platform fees and credit rounding; avoid increasing the final bill just because one reservation was split into several records |

Observed implementation gaps to address:

- backend/core/billing/pricing.py:model_token_costs currently falls back to generic per-token rates when a model is absent or incompletely priced. Those values cannot authorize a claim of fully covered provider cost. Require verified applicable pricing for new protected execution paths; an unknown price is not zero and not a safe default.
- The current ModelUsage tracks only model plus input/output counts. Extend its accounting boundary as needed for actual billable categories such as cache operations, tool fees and runtime use instead of silently folding unknown costs into an average token price.
- backend/core/service_gateway/language_models.py normalizes token limits and merges config.extra/provider routing. Quote and enforce the fully resolved request after these changes. An earlier UI max_tokens value is not necessarily the cap the provider receives. Do not permit a later override or routing change to enlarge cost without rechecking the reservation.
- Current credit conversion rounds a priced aggregate upward. Preserve the agreed pricing unit and aggregation policy; atomically reserving each call must not accidentally introduce a new one-credit minimum charge for every subcall.
- The pricing code's markup already describes an infrastructure share. Verify the existing commercial pricing scope before adding a separate sandbox line: count covered infrastructure once, and do not introduce an undisclosed fee as a substitute for proper metering.
- The inspected worker debits successful runs in its completion-notification path. D08b needs durable usage settlement independent of final job success, with attempt-level deduplication and recovery. Decouple billing completion from whether a success notification was sent. Do not charge the same child/parent grid work twice.

### Admission and settlement sequence

1. Resolve the exact provider/model/runtime configuration and a versioned applicable price snapshot. Bind the reservation to that request/configuration, owner, budget and logical attempt. Any cost-increasing change requires a fresh check before dispatch.
2. Compute the operation's maximum charge plus bounded headroom needed for settlement, shutdown and other applicable tail work. Headroom is derived from the resource/billing contract; a guessed fixed percentage is not proof that the bound is sufficient. If a component has no enforceable bound, block that paid path with a specific setup/capability reason.
3. Atomically check both the remaining run/setup budget and available account funding, including other active commitments. Reserve the required amount once. A reservation reduces Available but does not debit usage. Parent commitments and child holds must not be subtracted twice.
4. Start work only after reservation succeeds. Enforce the quoted limits at the gateway/provider and sandbox supervisor, including all calls made by an agentic proposer. Upstream engine budget flags or an after-call callback alone are not proof of coverage.
5. If the next operation cannot fit, do not start it. Do not automatically increase the budget, substitute a model, shorten an upstream-selected response limit or make the evaluator return a fake bad score. Use a distinct platform budget-stop signal so the algorithm does not learn from an evaluation that never occurred.
6. Persist actual usage as it becomes available. On completion, price it under the applicable recorded policy, settle it once from the reservation and release unused coverage. A 10-credit reservation that uses 6 credits creates a 6-credit charge and releases 4; headroom itself is not a fee.
7. On timeout, interrupted streams, cancellation or lost responses, reconcile the operation/provider request before releasing its remaining coverage or retrying. Missing usage is pending, not zero. Preserve settlement evidence across worker or browser restarts.
8. If a reported charge exceeds its verified bound, stop new work on that path, retain the evidence and treat it as a pricing/enforcement defect. Do not silently normalize it into routine over-budget operation, invent a usage figure or reinstate the rejected platform-subsidy assumption. The supported path must prove its bound before resuming protected execution.

These controls apply to setup, task execution, LLM judging, optimization proposals and their billable managed runtime. Preserve the selected upstream algorithm; budget admission adds an outer execution constraint, not a replacement search loop. BYOK paths require equivalent verified provider attribution and controls for whatever spending guarantee is displayed.

### Budget copy and a worked example

Use concise supporting text near Total budget: We reserve credits before work starts. You pay for actual usage; unused reserved credits become available again. Show Estimated usage only as a forecast. When work is reserved, expose Reserved for work in progress so the user can understand why Available is lower than total minus settled spend. Keep the reservation mechanics out of the primary wizard decisions.

Illustrative credits, not a price quote: total 100, settled usage 82, and current work plus its completion headroom has reserved 6. Available is 12. A next operation requiring 10 can be admitted; one requiring 15 cannot. After the 10-credit operation settles at 7, its unused 3 credits return to Available. This calculation is shared by simultaneous engines and tabs through the server, not recomputed independently in each browser.

### D08c: normal budget stop with evaluated results

**Approved:** When the remaining budget cannot safely cover the next operation, finish with a Budget reached reason and return the best completed, evaluated candidate available so far. Keep the actual evidence and metrics; do not present a partially evaluated candidate as a completed result or claim a held-out score that was never computed. If no candidate completed evaluation, explain that no evaluated result is available yet. Checkpoint-based continuation remains conditional on the pinned engine's real recovery support under D07.

### Stopping sequence and result integrity

1. A failed reservation triggers a typed platform budget-stop signal. Stop admitting new paid operations across the entire run, including Auto lanes and evaluator/proposer children. Do not send a synthetic zero score, empty answer or generic evaluator failure back into the search algorithm.
2. Distinguish temporary reservation contention from actual exhaustion. Work already covered by valid reservations may finish within its limits; do not declare the run terminal while it can still publish a newer completed result or release enough headroom for the next operation. If a declined admission is only waiting for already-running work to settle, wait at the existing scheduling boundary and reevaluate coverage. Do not reorder proposals or alter upstream selection to manufacture an affordable path.
3. Once the next required work cannot fit after settlement, stop the search and finish only already-covered mandatory completion/cleanup work. No new unreserved evaluation, export transfer, sandbox extension or automatic retry may run after the stop. Finalize reservations and actual charges under D08b.
4. Persist the engine's incumbent and its evidence whenever the upstream engine publishes a completed candidate-selection result, before starting subsequent work where supported. At a budget stop, use that authoritative result or a supported engine recovery API. Do not reconstruct a replacement optimizer by picking the largest single-example score from logs.
5. A completed evaluation means the comparison/evaluation unit required by that engine and task has finished. Preserve candidate identity/content, model configuration, dataset/split identity, evaluation counts, score definitions and provenance together. A score on one case or a partial batch does not make the candidate fully evaluated for an aggregate metric.
6. Preserve a starting candidate as the result when it is the engine's best evaluated incumbent and no improved candidate qualifies. An unevaluated seed is still a starting artifact, not an evaluated winning result. Do not claim improvement merely because the optimizer proposed a change.
7. Keep any incomplete candidate and its raw progress as incomplete history when useful. Exclude it from the returned best-candidate claim unless the upstream contract actually completed its required evaluation. A later user can inspect that history without mistaking it for a validated result.
8. Finalize once using the existing ownership/status compare-and-set protections. A concurrent explicit user cancellation retains cancellation as its reason; an independent infrastructure or evaluator failure retains its actual error. Do not relabel every abnormal termination as Budget reached.

### Stop result and status contract

Current source evidence: OptimizationStatus lists pending, validating, running, success, failed, cancelled and paused. The subprocess sends uncaught exceptions as EVENT_ERROR, which the worker turns into failure. BlackboxRunResponse requires best_candidate. PairResult has a stop_reason field, but it is not a run-wide terminal contract. Therefore, changing a toast label alone cannot implement D08c.

Recommended minimal contract: add a terminal stopped state with a structured budget_reached reason and an optional evaluated result. Keep execution outcome, result availability and billing settlement distinguishable. A budget stop can have a valid result while optional final testing or billing reconciliation remains incomplete. Treat field names here as the proposed API mapping to finalize against existing schemas, not an already-existing endpoint behavior.

| Information | Requirement |
| --- | --- |
| Terminal execution state/reason | stopped with budget_reached; user-facing label Budget reached, not Failed or an unqualified Optimization completed |
| Result availability | Explicitly indicate whether a completed/evaluated incumbent exists; represent absence without a fake empty best_candidate or a validation-breaking partial success response |
| Candidate and selection evidence | Preserve the upstream-selected artifact and the completed evaluation scope used to select it |
| Baseline/final metrics | Persist only measured values; leave missing values absent/null and include a reason such as not run before budget stop |
| Budget outcome | Total, settled setup/run spend, released/pending reservations and remaining amount; values can settle after execution ends without reopening the search |
| Recovery capability | Derived from an actual compatible checkpoint and supported pinned engine, not from the presence of a seed or result alone |

- Extend the subprocess/managed-runner result envelope to return this stop outcome and optional result without entering the generic error handler. Preserve normal success and genuine-error behavior. If a shared result class cannot represent no completed candidate, use a typed terminal envelope rather than inventing required result fields.
- Update backend/frontend enums, storage constraints if present, response schemas, status filters/counts, streaming completion, notification/analytics mappings and terminal classifications together. The current frontend status map is exhaustive. Intentionally update API/schema fixtures for this contract change while preserving unrelated Pydantic descriptions.
- Include stopped in distributed grid terminal accounting so the parent cannot wait forever. Retain completed pair results and expose incomplete pairs accurately; a parent prevented from finishing its requested work by budget shows that reason. Parent and child settlement must count each usage event once.
- Keep previous stored run outcomes unchanged. New Budget reached semantics apply to new executions or explicit subsequent attempts; do not relabel historical failed jobs by searching their error strings.

### Result screen and notification copy

| Situation | Display |
| --- | --- |
| Completed/evaluated incumbent exists | Budget reached. Your best evaluated version is saved. Show its artifact and actual evaluation scope/scores. |
| Only the evaluated starting candidate qualifies | Budget reached. No better evaluated version was found before stopping. Retain the starting result and measured baseline evidence. |
| No candidate completed evaluation | Budget reached before a candidate finished evaluation. Preserve the run, logs, draft inputs and incurred usage; do not show a fabricated best score or improvement percentage. |
| Final held-out testing was not performed | Final test not run before budget stop. Display any completed validation score under its correct label. |
| Some work is still settling | Finishing work already in progress, then the terminal budget-stop summary. Keep pending usage marked as pending rather than displaying a final zero charge. |

Use the existing toast system once for the transition and keep the reason on the persisted run page. Retain actual candidate download/export where available; preserve existing artifact/serving validation gates. Clear active spinners and end streaming only when the worker has finalized the stop. Do not trigger a fresh validation charge merely to make the result screen look complete.

A budget stop never resumes solely because a reservation was later released, an account was topped up, a tab reopened or a worker restarted. If the user later chooses to continue, require sufficient newly available/explicitly increased allowance and a compatible supported checkpoint. Where only a fresh run is supported, identify it as a new run and preserve the old result; do not label that operation Resume. D07's proposed automatic recovery concerns infrastructure interruption while the run remains authorized, not an intentional budget stop.

The Continue/toast policy remains approved. Reservations add no separate Test setup action, payment confirmation or model-selection step.

## 8. Review and submission

Render the effective configuration using the same normalized values that build the payload. Show objective, artifact summary, dataset counts/splits, evaluator, selected algorithm/Auto, relevant models/runners, budget, privacy, and current validation evidence. Provide Edit links without duplicating full editors.

Move run name and description here. Suggest a name from the objective using existing naming behavior where available; do not add a paid naming call. Preserve a user-edited or cloned name. Keep private as the current default. Description stays optional with the existing 280-character limit.

Before submission, revalidate required fields and current capabilities. Reuse the matching successful checks performed by Continue; run the same required-validation path if any evidence has become stale, without another confirmation dialog. Then submit once with the existing idempotency mechanism. Network uncertainty must retry the same logical submission rather than create another job. Success uses the returned optimization ID and existing run page. Failure retains the draft and points to the relevant field or service issue.

A readiness check is scoped evidence, not a promise that an entire optimization will finish successfully. Display which inputs were checked and when configuration changes invalidate that evidence.

## 9. Payload compatibility and migration

| UI grouping | Existing request fields to preserve |
| --- | --- |
| Goal | objective, background, recipe, seed_candidate; DSPy module/signature/workflow fields |
| Evaluation | scorer, cases/dataset, column mapping/order, split_fractions, shuffle, seed |
| Optimization | strategy, budget, reflection_model_config; relevant execution model/runner configuration |
| Review | name, description, is_private, max_cost_credits, estimated_credits_low/high |

Removing Target from the UI does not require immediately deleting target from the public request model or historical payloads. Keep an explicit compatibility adapter for existing jobs. Do not globally replace target.kind with agent or infer it solely from sandbox availability.

Historical clones should reconstruct the same meaning and surface unavailable legacy settings. If an upstream engine migration changes accepted configuration, record the engine source/version for new runs and define how old runs are cloned or resumed. Never rewrite existing result records to make them appear generated by the new implementation.

Avoid database schema changes solely for step reordering. Add persisted fields only when the engine/runtime compatibility design requires them. Preserve Pydantic schema descriptions when touching models and verify the repository's OpenAPI gate.

## 10. Draft lifetime and authoring recovery

Observed current behavior: DSPy retains an in-memory draft for 30 minutes across client-side navigation, with a best-effort sessionStorage stash for locale reload. The Anything hook has no equivalent saved-draft mechanism in the inspected source.

**Decision D06 — approved with correction:** Keep unfinished setup across refresh/browser reopening without an application-driven expiry timer. Offer a polished actionable toast that lets the user Continue draft or Start new. Do not automatically restore saved fields before the choice. Do not research or choose an expiry duration; that earlier request was explicitly superseded.

### Toast presentation and actions

Use the existing warm/light toast styling, a restrained draft icon, a clear sentence, and two real buttons. Suggested copy: Continue from your previous setup? Supporting text may identify the workflow, saved stage and last edit time without exposing private content. Primary action: Continue draft. Secondary action: Start new. Last edit time is informational and never used as an expiry rule.

Use the existing locale-aware placement: bottom-right in LTR and bottom-left in RTL, with responsive width and spacing so it does not obscure the wizard's navigation controls. Keep a compact horizontal action row that wraps if translations require it. Reuse the established buttons, typography, focus and reduced-motion behavior; no modal or extra confirmation.

The current provider auto-closes after four seconds and closes on body click. Override those defaults for this toast: no auto-close, no body-click dismissal, no drag dismissal, and no countdown bar. Continue draft and Start new each have their own handler; clicking the toast background does not imply either action. Announce the offer politely without stealing keyboard focus and make both actions keyboard-operable.

### Discovery and restoration

1. Once the current account is known, read its saved draft without mutating it. If there is no meaningful saved input, show the ordinary initial carousel without a restore toast.
2. If a draft exists, create one restore toast keyed by its draft ID. Re-renders must not stack duplicate offers. Hold blank-state autosaves until the restore/new choice is resolved so mounting a fresh form cannot overwrite the saved draft.
3. Continue draft restores the active workflow, semantic stage, both workflow snapshots, authored candidate/scorer content, data, model choices and budgets from one complete saved revision. Hydrate once, then enable autosave. Show the recovered workflow rather than forcing a second carousel selection.
4. Revalidate restored fields, dataset references and engine capabilities. Keep unavailable AutoResearch or legacy choices visible. Missing credentials remain visibly incomplete; old stored test success must not establish current runtime readiness. The next relevant Continue reruns required checks.
5. Dismiss the offer after successful restoration. If restoration fails, retain the saved data and update the toast with an actionable failure; never replace it with a blank snapshot. Start new remains an explicit way to discard the unusable draft.
6. Leaving the page without choosing preserves the saved draft. The restore offer can appear on the next visit. Toast lifecycle cleanup itself must not delete data.

### Start new: exact reset scope

Start new is the explicit reset action. Clear the previous wizard's persisted record, its draft-owned uploaded-data snapshots, both workflow form snapshots, validation evidence and in-memory draft state. Reset to the initial carousel with current defaults. Do not carry the old workflow, step, objective, code, dataset, models, budgets or privacy override into the new form.

The reset applies to the saved wizard setup only. It does not delete dataset-library records, submitted jobs, account/provider settings, recent-model preferences or unrelated browser storage. Avoid clearing all localStorage/IndexedDB as a shortcut.

Cancel pending autosaves and use a draft revision/reset generation so a late write cannot resurrect the discarded setup. Coordinate open tabs against that revision. If the reset cannot be committed, report the failure and do not claim that the draft was cleared.

While an offer is pending, carousel browsing may remain available, but no ordinary selection may silently overwrite the saved draft. If the carousel offers an entry action during this state, label it explicitly as starting a new setup and route it through the same reset handler. An explicit clone/deep-link request must likewise preserve the existing draft until the user chooses to replace it; do not let clone hydration overwrite it as a side effect.

### Storage and lifetime

- Use IndexedDB for versioned form snapshots and uploaded dataset content. Record draft ID, account ID, active workflow, stage ID, per-workflow state and update time. Update time is for display and ordering, not timed deletion.
- Save after a short debounce and at workflow/navigation boundaries. Persist coherent revisions so recovery cannot mix one candidate revision with a different dataset/form snapshot.
- Store edited candidate/scorer text, objective/background, model identifiers and non-secret parameters, budgets, split settings and relevant dataset metadata/content. Verify dataset-library references before reuse.
- Never persist raw API keys, external evaluator secrets, gateway tokens or authentication tokens in the draft. Restore managed credential references where available; otherwise request the missing credential in its normal field.
- Scope discovery and restoration to the signed-in account. Signing out detaches in-memory state and dismisses the toast; it must not expose the previous account's draft to another user or treat sign-out as Start new.
- Keep the previously agreed successful-submission cleanup: the submitted job becomes the saved run, and its now-consumed wizard draft is cleared. Submission failure retains the draft. No scheduled age-based cleanup is introduced.
- If browser storage is unavailable or full, retain in-memory work and show a concise save-status toast. Do not erase the form or block an otherwise valid submission. Browser/user-cleared storage cannot be recovered by this feature.

Server draft storage, cross-device sync, credential persistence and draft-history browsing are outside this scope. The server-owned budget/accounting identity introduced by D08 stores spend and authorization metadata, not draft content, and does not add cloud draft synchronization.

## 11. Managed runtime integration

Keep authentication, job claiming, billing authorization, persisted status, and supervision in the existing service. Execute the optimization workload and platform-run user code in managed isolation. Infrastructure placement must not rewrite optimizer prompts, search order, evaluation semantics, or budget definitions.

The production runtime boundary is one Vercel Sandbox for each paid Continue scope and one Vercel Sandbox for the submitted run. The existing worker invokes and supervises that boundary with the same outward progress/result/cancellation interface. It may admit work, reserve and settle usage, retain credentials, relay only authorized model/evaluator/MCP operations, persist events/results/checkpoints and recover a compatible run. It must not execute the optimizer, authored scorer, harness, candidate command or dependency command on its own host. Do not give the sandbox direct database or provider credentials merely to reuse an in-process service function; provide job-scoped inputs and opaque relay capabilities.

There is no execution-environment choice in either wizard. Legacy `worker` request values canonicalize to Vercel before admission. Every completed-run Playground, streaming, ReAct, ad hoc evaluation and shared-serve request creates fresh caller-owned one-request authority and runs in Vercel, including interactions with historical runs; no stored runtime value restores API-host execution. Historical artifacts that lack the safe persisted metadata required for sandbox reconstruction fail closed. Keep an internal sandbox-provider seam so infrastructure can later move to a cheaper equivalent isolation provider after separate security, accounting and compatibility verification; this is deployment policy, not a user-facing optimizer setting.

The detailed runner design must cover:

- Immutable runtime image and compatible pinned optimizer/proposer dependencies.
- Job-scoped candidate/data materialization; separation of held-out data from proposer-accessible history.
- Model routing and credential scope; preserve BYOK and attribution without leaking provider secrets into logs or artifacts.
- Progress/log/result transport, ordered events, retry/deduplication, and heartbeats while an engine is busy.
- Cancellation that stops all work associated with the job and revokes its capabilities; no later success overwriting cancellation.
- Runtime expiry and worker restart behavior. Current scorer sandbox reopening is not proof that optimizer state can resume after its sandbox expires.
- Checkpoint persistence and recovery only where the selected engine supports it; no invented resume semantics.
- Result/artifact collection before teardown, failure reporting, cleanup after success/failure/cancel, and orphan sweeping.
- Service preflight when sandbox configuration is absent; no hosted fallback to the worker host.
- External evaluators remain remote and retain their existing credential/request contract.

Do not set runtime lifetime, retry counts, storage retention, or simultaneous-job limits without checking current deployment capabilities and the user's intended run sizes. These are pending implementation details, not reasons to reintroduce a Target switch.

### D07: automatic recovery from compatible checkpoints

Local source checked on 2026-09-02:

- backend/core/worker/engine.py:_checkpoints_enabled permits the existing run and grid_search types on a checkpoint-capable store. The blackbox path does not inherit that checkpoint guarantee simply because it invokes GEPA or another upstream engine.
- The worker restores saved GEPA state for supported paths. Its unexpected-SIGKILL recovery can requeue work within the configured attempt limit; without a compatible checkpoint, requeueing is not proof of continuation and may repeat work from the start.
- backend/core/api/routers/optimizations/lifecycle.py:resume_job currently accepts failed/cancelled/paused jobs with stored checkpoint/pair state and reuses the run ID. D08's new accounting requires renewed reservation checks against cumulative spend; reopening the job must not grant a fresh copy of the original budget.
- core/config.py defaults job_max_attempts to 3 and sandbox lifetime to 2700 seconds. These are local defaults, not verified production settings or confirmed upstream recovery capabilities. Reopening a scorer sandbox does not restore an optimizer's full state. Choose effective runtime limits from the deployed provider capabilities and pinned adapter, not this historical description alone.

**Approved:** Automatically recover a run after a temporary infrastructure interruption when its optimizer supports genuine checkpoint recovery and the remaining budget can fund it. Keep the same run identity, cumulative spend, dataset/model/engine versions and search state; bound recovery by the existing supported attempt policy. Show a concise Recovering run status and an existing-system toast when the user is present, without asking for another confirmation for work already authorized within the budget.

The automatic policy excludes user pause/cancel, a normal Budget reached stop, schema/version-incompatible state, deterministic user-code/configuration failures and any path that can only restart from scratch. If recovery is unavailable, preserve results/logs and state the specific reason. Do not promise identical stochastic future outputs after a retry; fidelity means using the engine's supported state-restoration semantics without replacing its search loop.

Implementation must reconcile provider/runtime usage and terminate or revoke the old worker's execution capability before admitting the replacement. A lease change must not leave two workers spending the same run budget. Any work replayed under a supported checkpoint contract needs normal admission and usage attribution; never bill the same provider event twice. Actual checkpoint compatibility and deployed runtime limits remain technical validation gates; product approval does not establish those capabilities.

### Recovery eligibility and checkpoint contract

1. The backend capability record must distinguish engine support for true state restoration, the availability of a usable checkpoint for this run, and current eligibility to spend. An engine name, saved candidate, sandbox snapshot or completed pair is not enough by itself. Auto recovery must cover its composition state and participating lanes; do not advertise whole-Auto recovery merely because one child engine can resume.
2. Recover only a classified temporary infrastructure interruption of a run that was still authorized to execute. Preserve the existing deployed attempt cap after verifying its semantics; do not add unlimited retries or reset the counter when a different worker claims the run. Repeated deterministic restore/configuration errors end recovery promptly with the specific cause.
3. Commit checkpoint bytes and metadata atomically so a killed writer cannot publish a half-written recovery point. Keep the last verified checkpoint until its replacement is durable. Use the upstream engine's supported checkpoint format; do not reconstruct missing search state from a prompt transcript or merely reseed with the best candidate.
4. Bind a checkpoint to the run and an integrity-checked revision: engine/source version, supported serialization version, runtime/dependency image, task/configuration fingerprint and dataset/split identity. Native state must retain the upstream-supported search history/frontier, progress, RNG and budget counters as applicable. Restore only compatible state; do not upgrade the engine mid-run or merge later wizard edits into it.
5. Keep credentials and billing authority outside user-visible checkpoint artifacts. Reissue short-lived run-scoped execution access after ownership is established. A restored checkpoint must not restore a stale authorization token or reset the server's spend ledger to the checkpoint's older timestamp.
6. Preserve completed evaluation/result evidence independently where required by D08c. The latest safe checkpoint may precede later completed work. Report that replay can occur under the supported engine semantics, and reconcile usage for actual attempts rather than treating the replay as free or charging the original event twice.

### Recovery execution sequence

1. Record the interruption and recoverable checkpoint revision on the existing job; retain its saved artifacts and last valid progress. Use a recovery activity/reason within the existing active lifecycle where possible, avoiding another terminal status just to display Recovering run.
2. Claim the recovery attempt atomically using the existing lease/ownership mechanism and a monotonically changing execution generation. Verify the persisted job is still eligible after the claim. Duplicate queue deliveries must not create parallel recovery attempts.
3. Fence the old worker at both result publication and paid-operation admission. Terminate its sandbox/process or revoke its ability to start new paid work. Reconcile outstanding provider/runtime calls and reservations; if their state is uncertain, preserve coverage and stop short of admitting overlapping replacement work.
4. Verify checkpoint integrity/compatibility, necessary runtime/model access and remaining funds for restoration, resumed work and required headroom. Reuse the same budget identity, price/usage evidence and cumulative settled spend. The original total is never granted again as a fresh allowance.
5. If the remaining budget cannot fund recovery, follow the approved Budget reached outcome and preserve available evaluated results. If the checkpoint is unusable or recovery attempts are exhausted, preserve artifacts/logs with the actual interruption/recovery reason. Neither condition triggers a silent fresh restart.
6. Materialize the pinned runtime and immutable inputs, then call the upstream restore/resume entry point. Restore engine counters without resetting the platform's authoritative ledger or double-subtracting settled usage. Any genuinely repeated work obtains the usual reservation and settles actual usage.
7. Recheck cancellation, budget-stop state and execution generation before paid dispatch and result publication. A user cancel during restoration prevents the new worker from continuing. Late events from the old attempt cannot overwrite the active or terminal state.
8. On confirmed resumed execution, clear the recovery activity, continue publishing progress to the same run page, and retain an auditable recovery event. A valid recovery ends at the restored engine actually running, not just at a successful sandbox creation.

### Recovery UX

| State | User-facing behavior |
| --- | --- |
| Automatic recovery starts | Recovering run. Restoring saved progress after an interruption. Keep the existing run page and saved progress visible. |
| Recovery succeeds | Run recovered. Optimization is continuing. Return to normal live progress; keep the same run ID and cumulative spending. |
| Recovery lacks sufficient funded headroom | Budget reached. Preserve the available evaluated result and show budget amounts; do not increase the total. |
| Recovery is unsupported or fails | Explain the specific recovery limit and keep available results/logs. A separate user action may start a new run; never label that action Resume. |
| User paused/cancelled or run stopped at budget | Keep the requested terminal/paused state. No recovery episode begins automatically. |

Use one toast per recovery episode and update it as the outcome changes. Persist the recovery activity/outcome on the run so a user returning after the toast still sees what happened. Keep the existing Cancel affordance operative during recovery. Do not add a recovery toggle, wizard step or confirmation dialog for the approved automatic behavior. Repeated lease heartbeats do not generate repeated toasts.

## 12. Verification matrix

| Scenario | Required evidence |
| --- | --- |
| Text/code with deterministic evaluator | Correct candidate and case reach evaluator; no unnecessary agent configuration |
| Evaluator using a model | Correct model role, credentials and usage attribution; relevant override invalidates test evidence |
| GEPA with code-based feedback | Task and optimization controls only where needed; no invented feedback-model call or picker |
| Meta-Harness model roles | Optimization selection reaches the upstream proposer; task selection reaches the candidate harness; no extra reflector or summary model |
| Optional LLM judging | Scoring defaults to the compatible optimization model only for a real judging call; resolves the correct per-role configuration, with an independent override and accurate role-specific usage |
| Model responsibility copy | Task, optimization and applicable scoring rows show actual invoked models, inline purpose and textual reuse/custom state; inherited changes update the display; English/RTL and long model names remain readable |
| Non-LLM task and deterministic scorer | Only required optimizer/proposer model shown; hidden task/scoring roles do not block validation or enter payloads |
| Legacy scorer llm helper | Existing task/judge call binding preserved; model-use detection alone does not create a third role or rewrite code |
| Model changes and engine changes | Explicit choices survive; compatible inherited bindings update; unsupported combinations fail visibly; affected checks become stale |
| Judge inherited from a later-stage choice | Earlier Continue does not invent a model or false success; later Continue completes pending checks once the effective model is available |
| Agent evaluation | Preflight actually runs the configured runner and scores its result; scorer-only success is insufficient |
| Meta-Harness | Chosen implementation's proposer/history/candidate contract matches its authoritative reference; no substitution with local prompt-only semantics |
| Auto | Exact selected upstream composition and budget behavior; metadata identifies it |
| AutoResearch before backend availability | Visible and selectable; settings and draft survive; clear status; Review cannot launch; direct API rejects unavailable execution; no silent substitution |
| AutoResearch after backend availability | Same selection becomes runnable from verified capability data; actual upstream engine executes and returns attributed progress/results |
| DSPy | Dataset/column prerequisites, signature/metric authoring, run/grid-search payloads preserved |
| Named parts | Compatible engines receive all names/content; duplicate or unsupported parts fail visibly |
| Seedless run | Objective-driven bootstrap stays algorithm-defined; objective text is not falsely presented as a tested generated artifact |
| Configuration changes during test | Stale result cannot turn the new configuration green |
| Continue-triggered testing | Required test starts from Continue; busy button and loading toast are visible; matching success updates the toast and advances once; failure updates the toast and retains the stage/field details; duplicate clicks and stale responses do not duplicate work or report false success |
| Shared setup/run budget | Billable setup model/sandbox usage reduces the run's allowance; baseline/final calls and all Auto engines count within the same approved scope; phase breakdowns do not double-count cost types |
| Budget identity and replay | Restores, refreshes, workflow switches, concurrent tabs and uncertain submissions cannot reset spend, duplicate charges or create a second full allowance |
| Budget reservations | Parallel work consumes shared available capacity; settlement and crash/cancel reconciliation release unused commitments and preserve actual usage under existing billing rules |
| Reservation correctness | Final routed request and effective token limits match the quote; unknown pricing/bounds prevent paid dispatch; cache/tool/runtime categories and minimum billing units are covered |
| User-funded settlement | Actual admitted usage settles once on success, budget stop, failure or cancellation as applicable; unused reservations are released, not billed; no success-only charging gap or duplicate parent/child charge |
| Admission exhaustion | A next operation that cannot fit is never dispatched; no fake evaluator score, silent model/limit change, automatic top-up or normal reliance on platform-funded overrun |
| Budget stop with evaluated result | Structured terminal stop persists the upstream incumbent, completed evaluation evidence, actual metrics and settled/pending usage; no generic failure, false full-test success or automatic restart |
| Budget stop without evaluated result | No fabricated candidate/score; artifacts and logs retained; explicit no-completed-evaluation message; schema remains valid |
| Stop races and distributed work | Already-covered work settles before terminal selection; temporary reservations are not mistaken for final exhaustion; user cancellation and genuine errors keep their reasons; grid parents terminate without duplicate billing |
| Budget edits and reset | Accepted total changes preserve settled/committed amounts; insufficient budgets stop new paid work; Start new preserves ledger history; cloning creates a fresh identity |
| Model/provider billing scope | Shared model choices count separate calls; managed/BYOK and mixed-role pricing stay explicit; unsupported external cost coverage is not presented as a verified all-in cap |
| Back navigation and cloned runs | Fields, manual model overrides, splits and supported legacy settings survive |
| Draft restore offer | One persistent actionable toast; no silent hydration or blank autosave overwrite; Continue draft restores exact saved setup; page exit without choosing preserves it |
| Start new reset | Saved wizard records, draft-owned data and both workflow states clear; source datasets/jobs/preferences remain; late autosaves cannot resurrect discarded data |
| Long-lived draft | No age-based expiry; saved time is informational; an old draft restores through schema/capability validation without fabricating compatibility |
| Initial carousel | Existing Anything/DSPy entries retained; fresh entry, recipe link and clone preselection work; Change preserves drafts and does not restart an interview |
| Uncertain submission response | Retry returns the same optimization ID through existing idempotency |
| Runtime unavailable/cancel/expiry | Clear status, no host fallback, no orphan workload, preserved available artifacts |
| Compatible automatic recovery | Temporary interruption restores native compatible state under the same run and budget; progress, completed evidence and cumulative charges survive; no extra user confirmation |
| Recovery concurrency and usage | Duplicate deliveries/leases cannot create two spenders; old workers cannot publish; unknown provider calls retain coverage; legitimate replay is charged once per actual attempt |
| Recovery eligibility | No automatic fresh restart, cancel/pause/budget-stop resume or incompatible-state restore; attempt limits and inadequate funds produce the correct preserved outcome |
| Recovery display | Recovering run resolves to resumed progress or a durable specific outcome; one toast per episode, existing Cancel works, returning users see the recorded state |
| English and Hebrew | Correct stage order, focus/error destination, logical direction and mixed code/text layout |

Use existing suites where they cover these behaviors. Add focused tests for new compatibility, validation-identity and runtime behavior, not snapshots that merely repeat implementation structure. Run rendered checks for the changed screens. Distinguish unit, type, build, API, runtime, and visual results in the final report.

## 13. Implementation sequence

1. Apply approved D01: pin authoritative dependencies and map engine capabilities. Document current gaps without changing algorithm definitions.
2. Apply the confirmed entry/model/validation/draft/budget/recovery decisions and verify the remaining provider/runtime capabilities without reopening approved product choices.
3. Prepare compatibility fixtures from existing supported payload shapes and clone paths; use synthetic data, not user secrets.
4. Refactor the shared stage/navigation presentation and rehome existing components with the existing hooks.
5. Implement contract-driven controls, payload normalization, validation identity and draft migration.
6. Implement the chosen engine integration and managed runner while maintaining status, accounting, cancellation and artifacts.
7. Complete localization/tutorial updates, focused regression checks and browser review.
8. Open reviewable PRs in dependency order. Production rollout follows explicit per-PR merge approval and direct runtime verification.

This sequence is a dependency plan, not permission to ship a UI claim before its runtime or engine contract is true. PR boundaries will follow the answered scope decisions and the repository state at implementation time.

## 14. Interactive decision log

| ID | Topic | State |
| --- | --- | --- |
| D01 | Upstream engine integration versus retaining current local implementations for this delivery | Approved: pinned upstream implementations own execution semantics; Skynet owns integration |
| D02 | First-screen task taxonomy and explicit DSPy entry | Approved with correction: retain the existing initial carousel before Goal; no duplicate inline workflow choice |
| D03 | Stage dependency handling when algorithm choice changes execution requirements | Preserve the agreed order; Continue checks the ready scope at Evaluation and outstanding execution readiness after Optimization |
| D04 | Minimum model-selection surface and algorithm-specific roles | Confirmed: task + optimization as primary choices when required, conditional scoring only; no duplicate feedback/reflection/proposer picker. Earlier optimizer-from-evaluation default is superseded |
| D04a | Default for an evaluator that needs LLM judging | Approved: reuse compatible Optimization model by default, retain separate override, and clearly explain the actual model and purpose for each role |
| D05 | Whether an expensive execution preflight requires an explicit test action | Approved with correction: Continue triggers tests automatically and reports progress/results through toasts; no separate mandatory test click or confirmation |
| D06 | Draft recovery across hard refresh and large-dataset storage | Approved: no timed expiry; persistent restore toast with Continue draft or Start new; reset only the saved wizard setup |
| D07 | Runtime lifetime and supported automatic recovery | Approved: automatically restore infrastructure-interrupted runs from compatible supported checkpoints within the existing budget and bounded attempt policy; no automatic fresh restart or resume after pause/cancel/budget stop. Deployed capabilities still require verification |
| D08 | Shared budget scope and presentation | Approved: one budget covers setup tests and the optimization, including billable sandbox usage; show phase spending and remaining allowance. Production coverage remains unverified |
| D08b | Pre-execution credit coverage and cost responsibility | Approved with correction: user funds actual usage; reserve verified operation bounds and headroom inside the chosen budget before dispatch, release unused holds, and do not rely on platform absorption or exact whole-run forecasts |
| D08c | User-visible result when the next operation cannot fit | Approved: end normally with Budget reached and preserve the best completed/evaluated candidate and actual metrics; show absence/incomplete tests accurately; no automatic paid restart |

Confirmed addition: AutoResearch is included despite incomplete backend support. Its selectable-but-unavailable execution behavior is specified in section 7; no question remains about whether to show it.

The original decisions above are answered. Subsequent implementation questions and their answers are recorded in section 16. Explain new consequential tradeoffs with concrete evidence and ask a focused question; do not reopen approved decisions merely because implementation needs work.

## 15. Technical verification gates before claiming completion

These are implementation responsibilities, not unanswered product questions or evidence that the feature already works.

| Gate | Required deliverable |
| --- | --- |
| Upstream authority | Immutable source/package pins for each runnable engine and the exact Auto recipe; parameter mapping and direct-versus-adapter fidelity fixtures |
| Runtime deployment | Verified installed SDK/provider plan, effective lifetime/resource bounds, pinned images/dependencies, scoped access, cancellation and cleanup behavior |
| Model routing and pricing | Role-to-request mapping, verified applicable rates and cost categories, enforced final token/resource bounds, BYOK scope, reservation/settlement evidence |
| Recovery capability | Per-engine and per-Auto-recipe recovery matrix; interruption/restore tests proving compatible state and single-owner spending |
| API and persistence | Versioned draft migration, budget/test/run linkage, typed stop/result contract, deliberate schema/status migration and supported legacy/clone fixtures |
| UX consistency | Rendered carousel and four stages, role explanations, actionable restore toast, Continue validation, budget and recovery states in English/Hebrew with keyboard/RTL behavior |
| Operational validation | Focused tests and actual sandbox integration evidence using controlled budgets; deployment/production checks only when that delivery is authorized |

Application implementation is in progress. The gates above remain the completion criteria; source changes and deterministic tests alone do not establish provider or production deployment completion.

## 16. Subsequent implementation decisions and current evidence

These decisions were explicitly approved while implementing the specification:

| Decision | Required implementation |
| --- | --- |
| Sandbox pricing | Keep the existing 1.5× model markup. Charge confirmed Vercel sandbox usage at cost inside the same Total budget. Do not add the model markup to sandbox charges. |
| Metered model transport | Optimization setup and execution may use a dedicated metered route to the same OpenRouter models. Each physical retry must obtain its own coverage; internal proxy retries must not bypass accounting. |
| Execution environment | Run every production DSPy and Anything optimization in Vercel Sandbox. Remove the runtime chooser from both wizards. Ordinary workers remain control-plane supervisors and never execute authored code or optimizer logic. Retain an internal provider seam for a future verified isolation backend without exposing it as a user choice. |
| Older API clients | If a submission lacks a shared budget ID, create its budget from the existing credit limit, or the existing funding-based default when no limit was supplied. Perform the same paid setup checks, durable evidence validation, budget attachment and protected execution as a wizard submission. Reuse the original submission idempotency key across uncertain retries. |
| Existing live MCP tools | Preserve the endpoint, credential and tool roster selected by the user through a restricted parent relay. Keep the real endpoint credential outside the sandbox, expose only the selected tools, and fence calls when the run loses admission. This does not authorize unrelated tool destinations or actions. |
| Shared ledger replaces duplicate balance controls | Preserve the approved total after setup and remove the router's second subtraction of legacy commitments. The billing service already counts existing legacy commitments plus durable operation holds; each protected dispatch still obtains an atomic reservation against both total allowance and wallet funding. |
| Whole-job sandbox boundary | Run the optimizer implementation, authored scorer, harness and workload commands inside the selected sandbox. The trusted parent may validate, admit, meter, hold credentials, relay only scoped model/evaluator/MCP calls, supervise and persist results; it must not execute the optimization loop on the ordinary worker host. Use one outer sandbox per paid Continue scope and one per run rather than nesting separately billed sandboxes. |
| User-owned external endpoints | Fees charged independently by a user-provided evaluator or MCP endpoint stay outside Skynet's Total because those services provide no authoritative usage receipt or enforceable spending limit. Skynet still meters and caps its model and sandbox usage, validates endpoint reachability, and surfaces non-success HTTP responses as setup/run errors. |
| BYOK budget scope | Total includes only Skynet's platform fee for BYOK model calls plus applicable sandbox usage. The model provider charges token usage directly through the user's key outside Skynet's budget. Reserve and settle the fee against both Total and the Skynet wallet; retain provider usage receipts as evidence without adding that external charge to Total. Reject BYOK routes without a verified metering adapter. |
| Completed-run interactions | Require `max_cost_credits` and a unique `Idempotency-Key` for every Playground, streaming, ReAct, ad hoc evaluation and shared-serve request. Create a fresh one-request budget owned by the signed-in caller, reserve every model/platform/sandbox operation against it, settle actual usage once, close it, and release unused credit. A shared viewer never spends the run owner's wallet or BYOK connection. Identical retries replay the recorded result; changing the maximum under the same key is a conflict. |

Implemented source and verification status, subject to final integration gates:

- Durable shared budgets, fixed-point operation reservations, account-wide wallet holds, measured settlement, retained uncertain usage, generation fencing, and explicit normal budget stops are present in the implementation worktree. PostgreSQL concurrency tests cover reservation races and setup claim ownership.
- Setup evidence binds the relevant input, credential revision, runtime profile, and code identity. A renewable lease prevents duplicate active checks. Expired attempts are fenced before takeover; dispatched work remains covered until reconciled. Successful completed checks can be reused after their usage settles without another paid call.
- Actual model transport now covers OpenAI-compatible chat and Anthropic-compatible messages through the parent authority. Provider-reported usage is reconciled by the original generation and credential identity. Managed usage settles its full marked-up charge; BYOK usage settles only Skynet's fee while retaining the provider receipt as evidence. A truncated stream cannot settle from an early zero-cost event. Unsupported custom BYOK endpoints are rejected rather than treated as covered. Additional harness protocol compatibility remains an integration gate.
- Authored scorer and agent dependency commands execute only inside the offline Vercel boundary. They may use packages already installed in the immutable image or deployment-owned package artifacts such as `/opt/skynet/wheels`; public package registries and `apt` networks are unavailable at run time. Continue executes scorer dependency preparation and agent dependency preparation before accepting the corresponding setup, reports missing packages as setup failures, and charges that sandbox work to the shared budget. The submitted run repeats preparation in its own isolated session. No dependency command falls back to the worker host.
- GEPA is pinned to immutable upstream commit `0632cdb5dcc052e690eab439e1b4a7e3e9cfe407`; the native adapters execute the pinned upstream entry points instead of modifying their algorithms. AutoResearch is visible in the wizard and is governed by the pinned runtime capability response rather than a simulated local algorithm.
- The worker lifecycle preserves actual incumbents and distinguishes a structured `stopped` / `budget_reached` outcome from infrastructure interruption, user cancellation, genuine failure, and billing uncertainty. Automatic recovery requires an integrity-checked checkpoint from the pinned implementation, compatible configuration, remaining allowance, and a bounded recovery attempt count.
- Both wizard flows use paid Continue checks and carry the same budget into submission. Persistent draft recovery, setup/run amounts, pending reservations, and recovery notices are implemented. The frontend unit suite currently passes 234 tests together with TypeScript, ESLint, module/i18n checks, and the production build. Final rendered mobile, English/Hebrew, RTL and keyboard verification is delegated to the user at their request.
- Protected completed-job routes return persisted, credential-scrubbed metadata without materializing authored code or pickle artifacts in the API process. Interactive inference, streaming, ReAct, evaluation and shared serving use a fresh caller-owned one-request budget, route every paid operation through the shared ledger, close after the request, and return actual spend. Historical runs use the same sandbox path; production routing cannot select the retired API-host executor.
- Verification has used deterministic provider transports, local loopback transport checks, disposable databases, and actual Linux isolation with network disabled. Read-only OpenRouter authentication and the configured Vercel Sandbox project query succeeded. A private `skynet-runtime` repository exists in the `skynet-blackbox` Vercel project. The final implementation commit is published there as a linux/amd64 image, resolved to its immutable digest, and booted in a controlled live Vercel Sandbox smoke test that verifies the embedded source identity without making a model call. The exact commit, image digest and smoke command are recorded in the implementation PR. No real paid model call or production deployment has been performed.

The implementation gates in this specification are complete. PR approval, production deployment and the user's requested rendered UI verification remain separate release gates.
