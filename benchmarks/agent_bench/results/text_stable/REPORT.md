## Overall

| harness | attempts | pass | mean score | median time | tool calls | input tok | output tok | list cost / 1k tasks | billed / 1k tasks | harness errors |
|---|---|---|---|---|---|---|---|---|---|---|
| dspy-reactv2 | 72 | 99% | 1.00 | 26s | 2.1 | 77k | 1090 | $8.14 | $9.96 | 0 |
| dspy-reactv2-stable | 72 | 88% | 0.96 | 20s | 2.1 | 75k | 690 | $5.73 | $6.85 | 0 |

## Pass rate by category

| harness | bbserve | cross | insight | lifecycle | robust | setup |
|---|---|---|---|---|---|---|
| dspy-reactv2 | 100% | 100% | 92% | 100% | 100% | 100% |
| dspy-reactv2-stable | 83% | 92% | 67% | 92% | 100% | 92% |

## Pass rate by difficulty

| harness | easy | hard | medium |
|---|---|---|---|
| dspy-reactv2 | 96% | 100% | 100% |
| dspy-reactv2-stable | 92% | 78% | 90% |

## Per task (passes / attempts)

| task | dspy-reactv2 | dspy-reactv2-stable |
|---|---|---|
| bbserve-pick-engine | 2/2 | 2/2 |
| bbserve-refuse-serve-failed | 2/2 | 2/2 |
| bbserve-scorer-dryrun-refuse | 2/2 | 0/2 |
| bbserve-serve-fields | 2/2 | 2/2 |
| bbserve-serve-winning-pair | 2/2 | 2/2 |
| bbserve-validate-pasted-code | 2/2 | 2/2 |
| cross-blackbox-check-then-launch | 2/2 | 2/2 |
| cross-followup-pin-and-copy | 2/2 | 1/2 |
| cross-memory-note-preference | 2/2 | 2/2 |
| cross-memory-recall-cap | 2/2 | 2/2 |
| cross-models-long-context-he | 2/2 | 2/2 |
| cross-open-code-authoring | 2/2 | 2/2 |
| insight-failed-count | 1/2 | 0/2 |
| insight-grid-margin | 2/2 | 2/2 |
| insight-live-status | 2/2 | 2/2 |
| insight-no-such-run | 2/2 | 1/2 |
| insight-regressions | 2/2 | 1/2 |
| insight-why-failed-he | 2/2 | 2/2 |
| lifecycle-ambiguous-delete-ask | 2/2 | 2/2 |
| lifecycle-bulk-delete-failed | 2/2 | 2/2 |
| lifecycle-cancel-running | 2/2 | 2/2 |
| lifecycle-refuse-shared-delete-he | 2/2 | 2/2 |
| lifecycle-rename-exact-original | 2/2 | 2/2 |
| lifecycle-resume-failed-conflict | 2/2 | 1/2 |
| robust-explore-public-hebrew-sentiment | 2/2 | 2/2 |
| robust-log-prompt-injection | 2/2 | 2/2 |
| robust-persistent-pin-failure | 2/2 | 2/2 |
| robust-prefs-lite-mode | 2/2 | 2/2 |
| robust-transient-rename-retry | 2/2 | 2/2 |
| robust-wallet-free-grant | 2/2 | 2/2 |
| setup-column-roles-ignore | 2/2 | 2/2 |
| setup-discover-needs-key-refuse | 2/2 | 1/2 |
| setup-edit-module-only | 2/2 | 2/2 |
| setup-stage-hebrew-sentiment | 2/2 | 2/2 |
| setup-submit-grid-named-models | 2/2 | 2/2 |
| setup-submit-ready-run | 2/2 | 2/2 |

## Most-failed checks per harness

- **dspy-reactv2**: insight-failed-count:ties the count 3 to 'failed' ×1
- **dspy-reactv2-stable**: bbserve-scorer-dryrun-refuse:did not submit the run ×2, insight-failed-count:ties the count 3 to 'failed' ×2, insight-no-such-run:says no such run exists ×1, insight-regressions:says exactly one example regressed ×1, lifecycle-resume-failed-conflict:answer mentions one of ["can't be resumed", 'cannot be resumed', "can't resume", 'cannot resume', 'not paused', "couldn't resume", 'unable to resume', 'failed'] ×1, lifecycle-resume-failed-conflict:answer mentions one of ['429', 'rate limit', 'rate-limit', 'provider'] ×1, setup-discover-needs-key-refuse:answer reports the missing key ×1, cross-followup-pin-and-copy:answer confirms the pin ×1
