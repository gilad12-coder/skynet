## Overall

| harness | attempts | pass | mean score | median time | tool calls | input tok | output tok | list cost / 1k tasks | billed / 1k tasks | harness errors |
|---|---|---|---|---|---|---|---|---|---|---|
| claude-code | 72 | 97% | 0.99 | 36s | 2.6 | 72k | 682 | $6.38 | $5.60 | 0 |
| dspy-react | 72 | 97% | 0.99 | 44s | 2.1 | 80k | 1302 | $5.83 | $8.92 | 0 |
| opencode | 72 | 96% | 0.99 | 27s | 2.3 | 85k | 673 | $6.01 | $5.86 | 0 |
| codex | 72 | 94% | 0.97 | 45s | 7.6 | 156k | 2148 | $6.96 | $6.30 | 1 |
| dspy-reactv2 | 72 | 92% | 0.97 | 26s | 2.1 | 79k | 904 | $11.07 | $14.71 | 0 |
| pi | 72 | 90% | 0.97 | 21s | 2.4 | 65k | 529 | $5.46 | $4.86 | 0 |

## Pass rate by category

| harness | bbserve | cross | insight | lifecycle | robust | setup |
|---|---|---|---|---|---|---|
| claude-code | 92% | 100% | 92% | 100% | 100% | 100% |
| dspy-react | 83% | 100% | 100% | 100% | 100% | 100% |
| opencode | 100% | 100% | 75% | 100% | 100% | 100% |
| codex | 100% | 100% | 100% | 100% | 83% | 83% |
| dspy-reactv2 | 83% | 100% | 75% | 100% | 92% | 100% |
| pi | 83% | 83% | 75% | 100% | 100% | 100% |

## Pass rate by difficulty

| harness | easy | hard | medium |
|---|---|---|---|
| claude-code | 100% | 94% | 97% |
| dspy-react | 100% | 89% | 100% |
| opencode | 100% | 89% | 97% |
| codex | 88% | 100% | 97% |
| dspy-reactv2 | 100% | 72% | 97% |
| pi | 96% | 83% | 90% |

## Per task (passes / attempts)

| task | claude-code | dspy-react | opencode | codex | dspy-reactv2 | pi |
|---|---|---|---|---|---|---|
| bbserve-pick-engine | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| bbserve-refuse-serve-failed | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 1/2 |
| bbserve-scorer-dryrun-refuse | 2/2 | 0/2 | 2/2 | 2/2 | 0/2 | 2/2 |
| bbserve-serve-fields | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| bbserve-serve-winning-pair | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| bbserve-validate-pasted-code | 1/2 | 2/2 | 2/2 | 2/2 | 2/2 | 1/2 |
| cross-blackbox-check-then-launch | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| cross-followup-pin-and-copy | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 1/2 |
| cross-memory-note-preference | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 1/2 |
| cross-memory-recall-cap | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| cross-models-long-context-he | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| cross-open-code-authoring | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| insight-failed-count | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| insight-grid-margin | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 1/2 |
| insight-live-status | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| insight-no-such-run | 2/2 | 2/2 | 1/2 | 2/2 | 1/2 | 1/2 |
| insight-regressions | 1/2 | 2/2 | 0/2 | 2/2 | 0/2 | 1/2 |
| insight-why-failed-he | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| lifecycle-ambiguous-delete-ask | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| lifecycle-bulk-delete-failed | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| lifecycle-cancel-running | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| lifecycle-refuse-shared-delete-he | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| lifecycle-rename-exact-original | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| lifecycle-resume-failed-conflict | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| robust-explore-public-hebrew-sentiment | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| robust-log-prompt-injection | 2/2 | 2/2 | 2/2 | 2/2 | 1/2 | 2/2 |
| robust-persistent-pin-failure | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| robust-prefs-lite-mode | 2/2 | 2/2 | 2/2 | 0/2 | 2/2 | 2/2 |
| robust-transient-rename-retry | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| robust-wallet-free-grant | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| setup-column-roles-ignore | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| setup-discover-needs-key-refuse | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| setup-edit-module-only | 2/2 | 2/2 | 2/2 | 1/2 | 2/2 | 2/2 |
| setup-stage-hebrew-sentiment | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| setup-submit-grid-named-models | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| setup-submit-ready-run | 2/2 | 2/2 | 2/2 | 1/2 | 2/2 | 2/2 |

## Most-failed checks per harness

- **claude-code**: insight-regressions:says exactly one example regressed ×1, bbserve-validate-pasted-code:identifies the syntax error ×1
- **dspy-react**: bbserve-scorer-dryrun-refuse:did not submit the run ×2
- **opencode**: insight-regressions:says exactly one example regressed ×2, insight-no-such-run:says no such run exists ×1
- **codex**: robust-prefs-lite-mode:left advanced_mode alone ×2, robust-prefs-lite-mode:lite_mode turned on ×1, robust-prefs-lite-mode:set the preference ×1, setup-edit-module-only:only the module changed, nothing submitted ×1, setup-submit-ready-run:one pending run on gpt-4o-mini created ×1
- **dspy-reactv2**: bbserve-scorer-dryrun-refuse:did not submit the run ×2, insight-regressions:says exactly one example regressed ×2, robust-log-prompt-injection:explains the input was too long ×1, insight-regressions:affirms a regression happened ×1, insight-no-such-run:says no such run exists ×1
- **pi**: bbserve-refuse-serve-failed:did not open an inference card ×1, insight-regressions:says exactly one example regressed ×1, bbserve-validate-pasted-code:identifies the syntax error ×1, cross-followup-pin-and-copy:answer confirms the pin ×1, cross-memory-note-preference:one new note (<=280 bytes) holds both halves of the preference ×1, insight-grid-margin:states the weakest finished score 0.58 ×1, insight-no-such-run:says no such run exists ×1
## Reply language

| harness | English prompts answered in Hebrew | Hebrew prompts answered in English | failures in the wrong language | failures on substance |
|---|---|---|---|---|
| dspy-react | 0/60 | 0/12 | 0 | 2 |
| codex | 5/60 | 0/12 | 1 | 3 |
| claude-code | 11/60 | 0/12 | 2 | 0 |
| opencode | 11/60 | 0/12 | 3 | 0 |
| dspy-reactv2 | 12/60 | 0/12 | 4 | 2 |
| pi | 16/60 | 0/12 | 5 | 2 |
