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
  /** Cents the check debited, for the setup-spend line. */
  centsCharged?: number;
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

// The wizards recompute the identity on every render, compare it in effect deps
// and hold it in evidence, and the setup carries the dataset rows. Embedding the
// rows made a multi-MB string to build and compare per render, so each array
// enters as its length and a digest of its stable serialization, computed once
// per reference; the rows are replaced, never mutated, when the data changes.
const arrayDigests = new WeakMap<unknown[], string>();

/** 53-bit cyrb53 hash; collisions only matter between two setups of one draft. */
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function arrayDigest(value: unknown[]): string {
  let digest = arrayDigests.get(value);
  if (digest === undefined) {
    const serialized = stableStringify(value);
    // Bare `#` is not valid JSON, so a digest never equals a serialized value.
    digest = `#${serialized.length}:${cyrb53(serialized)}`;
    arrayDigests.set(value, digest);
  }
  return digest;
}

const IDENTITY_VERSION = "v2";
const LEGACY_PREFIX = '{"setup":';

/** Cosmetic review edits cannot invalidate execution evidence or repeat paid checks. */
export function preflightIdentity(workflow: "anything" | "dspy", payload: object): string {
  const {
    name: _name,
    description: _description,
    is_private: _privacy,
    estimated_cents_low: _low,
    estimated_cents_high: _high,
    ...setup
  } = payload as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of Object.keys(setup).sort()) {
    const value = setup[key];
    const serialized = Array.isArray(value) ? arrayDigest(value) : stableStringify(value);
    if (serialized !== undefined) fields.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `${IDENTITY_VERSION}|${workflow}|{${fields.join(",")}}`;
}

/**
 * Rewrite evidence identity saved before digests into today's form, so a
 * restored draft keeps the checks it already passed. Older identities were
 * `stableStringify({ setup, workflow })`; anything else passes through.
 */
export function upgradeLegacyIdentity(identity: string): string {
  if (!identity.startsWith(LEGACY_PREFIX)) return identity;
  try {
    const parsed = JSON.parse(identity) as { setup?: unknown; workflow?: unknown };
    if (
      (parsed.workflow === "anything" || parsed.workflow === "dspy") &&
      parsed.setup &&
      typeof parsed.setup === "object"
    ) {
      return preflightIdentity(parsed.workflow, parsed.setup);
    }
  } catch {
    /* unreadable: leave it, and the evidence reads as stale */
  }
  return identity;
}
