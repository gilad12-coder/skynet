## Overall

| harness | attempts | pass | mean score | median time | tool calls | input tok | output tok | list cost / 1k tasks | billed / 1k tasks | harness errors |
|---|---|---|---|---|---|---|---|---|---|---|
| dspy-reactv2 | 72 | 99% | 1.00 | 18s | 2.1 | 75k | 856 | $9.93 | $12.18 | 0 |
| dspy-reactv2-stable | 72 | 99% | 1.00 | 12s | 2.1 | 72k | 638 | $3.45 | $4.51 | 0 |

## Pass rate by category

| harness | bbserve | cross | insight | lifecycle | robust | setup |
|---|---|---|---|---|---|---|
| dspy-reactv2 | 92% | 100% | 100% | 100% | 100% | 100% |
| dspy-reactv2-stable | 92% | 100% | 100% | 100% | 100% | 100% |

## Pass rate by difficulty

| harness | easy | hard | medium |
|---|---|---|---|
| dspy-reactv2 | 100% | 94% | 100% |
| dspy-reactv2-stable | 100% | 94% | 100% |

## Per task (passes / attempts)

| task | dspy-reactv2 | dspy-reactv2-stable |
|---|---|---|
| bbserve-pick-engine | 2/2 | 2/2 |
| bbserve-refuse-serve-failed | 2/2 | 2/2 |
| bbserve-scorer-dryrun-refuse | 1/2 | 1/2 |
| bbserve-serve-fields | 2/2 | 2/2 |
| bbserve-serve-winning-pair | 2/2 | 2/2 |
| bbserve-validate-pasted-code | 2/2 | 2/2 |
| cross-blackbox-check-then-launch | 2/2 | 2/2 |
| cross-followup-pin-and-copy | 2/2 | 2/2 |
| cross-memory-note-preference | 2/2 | 2/2 |
| cross-memory-recall-cap | 2/2 | 2/2 |
| cross-models-long-context-he | 2/2 | 2/2 |
| cross-open-code-authoring | 2/2 | 2/2 |
| insight-failed-count | 2/2 | 2/2 |
| insight-grid-margin | 2/2 | 2/2 |
| insight-live-status | 2/2 | 2/2 |
| insight-no-such-run | 2/2 | 2/2 |
| insight-regressions | 2/2 | 2/2 |
| insight-why-failed-he | 2/2 | 2/2 |
| lifecycle-ambiguous-delete-ask | 2/2 | 2/2 |
| lifecycle-bulk-delete-failed | 2/2 | 2/2 |
| lifecycle-cancel-running | 2/2 | 2/2 |
| lifecycle-refuse-shared-delete-he | 2/2 | 2/2 |
| lifecycle-rename-exact-original | 2/2 | 2/2 |
| lifecycle-resume-failed-conflict | 2/2 | 2/2 |
| robust-explore-public-hebrew-sentiment | 2/2 | 2/2 |
| robust-log-prompt-injection | 2/2 | 2/2 |
| robust-persistent-pin-failure | 2/2 | 2/2 |
| robust-prefs-lite-mode | 2/2 | 2/2 |
| robust-transient-rename-retry | 2/2 | 2/2 |
| robust-wallet-free-grant | 2/2 | 2/2 |
| setup-column-roles-ignore | 2/2 | 2/2 |
| setup-discover-needs-key-refuse | 2/2 | 2/2 |
| setup-edit-module-only | 2/2 | 2/2 |
| setup-stage-hebrew-sentiment | 2/2 | 2/2 |
| setup-submit-grid-named-models | 2/2 | 2/2 |
| setup-submit-ready-run | 2/2 | 2/2 |

## Most-failed checks per harness

- **dspy-reactv2**: bbserve-scorer-dryrun-refuse:did not submit the run ×1
- **dspy-reactv2-stable**: bbserve-scorer-dryrun-refuse:did not submit the run ×1
