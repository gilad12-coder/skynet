/**
 * Validation evidence for the submission wizard.
 *
 * A passed check only vouches for the exact inputs it ran against, so each
 * piece of evidence carries the identity of those inputs. The identity is a
 * stable serialization — never raw credentials: a remote scorer's secret
 * enters as a revision counter, a model as its credential-free identity.
 */

export type EvidenceStatus = "idle" | "running" | "passed" | "failed" | "stale";

export interface ValidationEvidence {
  /** Identity of the inputs the check covered (see `evaluatorIdentity`). */
  identity: string;
  ok: boolean;
  error: string | null;
  /** `Date.now()` when the check finished. */
  checkedAt: number;
  /** The scoring model the check ran with, when the evaluator invoked one. */
  modelName: string | null;
  /** Credits the check debited, for the setup-spend line. */
  creditsCharged?: number;
}

/** JSON with object keys sorted at every depth, so equal inputs serialize equal. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return current;
  });
}

export interface EvaluatorIdentityInput {
  /** The candidate the check scores — the seed, or the objective standing in for it. */
  candidate: unknown;
  /** The example row the check scores against, if any. */
  example: unknown;
  scorer: {
    kind: "python" | "remote";
    code: string;
    url: string;
    install: string;
    /** Bumped whenever the remote secret changes; the secret itself never enters the identity. */
    secretRevision: number;
  };
  /** Credential-free identity of the resolved scoring model, or null when the evaluator needs none. */
  scoringModel: string | null;
}

/** The inputs an evaluator check depends on, as one comparable string. */
export function evaluatorIdentity(input: EvaluatorIdentityInput): string {
  const scorer =
    input.scorer.kind === "python"
      ? { kind: "python", code: input.scorer.code, install: input.scorer.install.trim() }
      : {
          kind: "remote",
          url: input.scorer.url.trim(),
          secretRevision: input.scorer.secretRevision,
        };
  return stableStringify({
    candidate: input.candidate,
    example: input.example,
    scorer,
    scoringModel: input.scoringModel,
  });
}

/** Where a check stands for the inputs as they are now. */
export function evidenceStatus(
  evidence: ValidationEvidence | null,
  runningIdentity: string | null,
  identity: string,
): EvidenceStatus {
  if (runningIdentity === identity) return "running";
  if (!evidence) return "idle";
  if (evidence.identity !== identity) return "stale";
  return evidence.ok ? "passed" : "failed";
}

/** Cosmetic review edits cannot invalidate execution evidence or repeat paid checks. */
export function preflightIdentity(workflow: "anything" | "dspy", payload: object): string {
  const {
    name: _name,
    description: _description,
    is_private: _privacy,
    estimated_credits_low: _low,
    estimated_credits_high: _high,
    ...setup
  } = payload as Record<string, unknown>;
  return stableStringify({ workflow, setup });
}
