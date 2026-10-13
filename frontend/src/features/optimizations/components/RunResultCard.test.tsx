/*
 * node --test cannot load .tsx, so run it from frontend/ through jiti:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  BlackboxRunResult,
  OptimizationStatusResponse,
  OptimizedPredictor,
} from "@/shared/types/api";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { RunResultCard, resultArtifactText, runResultScores } = await import("./RunResultCard");

function job(overrides: Record<string, unknown>): OptimizationStatusResponse {
  return {
    optimization_id: "run-1",
    optimization_type: "run",
    status: "success",
    progress_events: [],
    ...overrides,
  } as unknown as OptimizationStatusResponse;
}

function blackboxResult(overrides: Partial<BlackboxRunResult>): BlackboxRunResult {
  return {
    optimizer_name: "gepa",
    strategy_mode: "single",
    engine_used: "gepa",
    baseline_score: 0.2,
    best_score: 0.7,
    metric_improvement: 0.5,
    seed_candidate: "seed text",
    best_candidate: "best text",
    regression_guard_applied: false,
    lanes: [],
    total_scorer_runs: 4,
    runtime_seconds: 1,
    num_lm_calls: 0,
    usage_by_model: [],
    optimization_metadata: {},
    details: {},
    ...overrides,
  } as BlackboxRunResult;
}

const predictor: OptimizedPredictor = {
  predictor_name: "predict",
  instructions: "Answer briefly.",
  input_fields: ["question"],
  output_fields: ["answer"],
  demos: [],
  formatted_prompt: "Answer briefly.\n\nQuestion: {question}",
};

const scores = { baseline: 40, optimized: 75, improvement: 35, isBlackbox: false };

void describe("runResultScores", () => {
  void it("reads a DSPy run's scores from job.result", () => {
    const result = runResultScores(
      job({
        result: { baseline_test_metric: 40, optimized_test_metric: 75, metric_improvement: 35 },
      }),
    );
    assert.deepEqual(result, { baseline: 40, optimized: 75, improvement: 35, isBlackbox: false });
  });

  void it("reads a black-box run's scores from blackbox_result", () => {
    const result = runResultScores(
      job({ optimization_type: "blackbox", blackbox_result: blackboxResult({}) }),
    );
    assert.deepEqual(result, { baseline: 0.2, optimized: 0.7, improvement: 0.5, isBlackbox: true });
  });

  void it("falls back to the evaluation progress events", () => {
    const result = runResultScores(
      job({
        progress_events: [
          { event: "baseline_evaluated", metrics: { baseline_test_metric: 10 } },
          { event: "optimized_evaluated", metrics: { optimized_test_metric: 30 } },
        ],
      }),
    );
    assert.deepEqual(result, { baseline: 10, optimized: 30, improvement: 20, isBlackbox: false });
  });

  void it("leaves missing scores null when the run had no test split", () => {
    const result = runResultScores(job({ result: { optimized_test_metric: null } }));
    assert.equal(result.baseline, null);
    assert.equal(result.optimized, null);
    assert.equal(result.improvement, null);
  });
});

void describe("resultArtifactText", () => {
  void it("uses the optimized prompt's formatted text", () => {
    assert.equal(
      resultArtifactText({ job: job({}), optimizedPrompt: predictor }),
      predictor.formatted_prompt,
    );
  });

  void it("prefers rewritten program code over the prompt", () => {
    assert.equal(
      resultArtifactText({
        job: job({}),
        optimizedPrompt: predictor,
        optimizedModuleSrc: "class Program: ...",
      }),
      "class Program: ...",
    );
  });

  void it("lists a react agent's tuned tool descriptions under their display names", () => {
    const text = resultArtifactText({
      job: job({}),
      reactOverlay: {
        tool_descriptions: { search: "Search the web.", calc: "Do math." },
        tool_arg_descriptions: {},
        tool_schema_hashes: {},
        max_iters: 5,
        tool_names: { search: "web_search" },
      },
    });
    assert.equal(text, "web_search: Search the web.\ncalc: Do math.");
  });

  void it("joins a workflow's nodes, each under its key", () => {
    const text = resultArtifactText({
      job: job({}),
      optimizedPrompt: predictor,
      optimizedNodes: {
        n_a: { optimized_prompt: predictor },
        n_b: { optimized_src: "def run(): ..." },
        n_c: {},
      },
    });
    assert.equal(text, `## n_a\n${predictor.formatted_prompt}\n\n## n_b\ndef run(): ...`);
  });

  void it("uses a black-box run's best version", () => {
    const text = resultArtifactText({
      job: job({ optimization_type: "blackbox", blackbox_result: blackboxResult({}) }),
    });
    assert.equal(text, "best text");
  });

  void it("is empty when the run produced no artifact", () => {
    assert.equal(resultArtifactText({ job: job({}) }), "");
  });
});

void describe("RunResultCard", () => {
  void it("shows the score line, the artifact, Copy, Try it and See details", () => {
    const html = renderToStaticMarkup(
      <RunResultCard
        scores={scores}
        artifactText="Improved artifact body"
        onTryIt={() => {}}
        onSeeDetails={() => {}}
      />,
    );
    assert.match(html, /data-result-scores=""/);
    assert.match(html, /40\.0%/);
    assert.match(html, /75\.0%/);
    assert.match(html, /Improved artifact body/);
    assert.match(html, /data-result-copy=""/);
    assert.match(html, /data-result-try=""/);
    assert.match(html, /data-result-details=""/);
  });

  void it("shows the artifact without the score line when a score is missing", () => {
    const html = renderToStaticMarkup(
      <RunResultCard
        scores={{ baseline: null, optimized: 75, improvement: null, isBlackbox: false }}
        artifactText="Improved artifact body"
      />,
    );
    assert.doesNotMatch(html, /data-result-scores=""/);
    assert.match(html, /Improved artifact body/);
    assert.match(html, /data-result-copy=""/);
  });

  void it("hides Try it and See details when no handler is given", () => {
    const html = renderToStaticMarkup(<RunResultCard scores={scores} artifactText="x" />);
    assert.doesNotMatch(html, /data-result-try=""/);
    assert.doesNotMatch(html, /data-result-details=""/);
  });

  void it("calls it an artifact, never a prompt, in Hebrew and English", () => {
    const catalogRoot = path.join(process.cwd(), "..", "i18n", "locales", "ui");
    for (const locale of ["en", "he"]) {
      const catalog = JSON.parse(
        fs.readFileSync(path.join(catalogRoot, `${locale}.json`), "utf8"),
      ) as Record<string, string>;
      const copy = Object.entries(catalog).filter(([key]) =>
        key.startsWith("optimization.result."),
      );
      assert.equal(copy.length, 5, locale);
      for (const [key, value] of copy) {
        assert.doesNotMatch(value, /prompt|פרומפט|הנחיה/i, `${locale}:${key}`);
      }
    }
    assert.match(
      JSON.parse(fs.readFileSync(path.join(catalogRoot, "en.json"), "utf8"))[
        "optimization.result.title"
      ],
      /artifact/,
    );
  });
});
