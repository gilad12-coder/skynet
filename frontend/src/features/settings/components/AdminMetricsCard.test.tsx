/*
 * node --test cannot load .tsx, so run it from frontend/ through jiti:
 * JITI_JSX=1 JITI_ALIAS="{\"@/\":\"$PWD/src/\"}" npx jiti <this file>
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiError, type NorthStarMetricsResponse } from "@/shared/lib/api";

// The classic JSX transform the test loader applies reads a global React.
(globalThis as { React?: typeof React }).React = React;
const { AdminMetricsView, northStarRows, stateFromError } = await import("./AdminMetricsCard");

function mondays(count: number): string[] {
  const newest = Date.UTC(2026, 9, 12);
  return Array.from({ length: count }, (_, i) =>
    new Date(newest - i * 7 * 86_400_000).toISOString().slice(0, 10),
  );
}

function seeded(overrides: Partial<NorthStarMetricsResponse> = {}): NorthStarMetricsResponse {
  const weeks = mondays(8);
  return {
    weeks: 8,
    first_lifts: weeks.map((week, i) => ({
      signup_week: week,
      signups: 20 - i,
      first_lifts: 7 - (i % 3),
    })),
    lifted_users: weeks.map((week, i) => ({ week, new_lifted: 3 + i, returning_lifted: 2 })),
    lifted_in_use: weeks.map((week, i) => ({ week, users_in_use: 11 + i })),
    ...overrides,
  };
}

function rowCount(html: string): number {
  const body = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  return body.split("<tr").length - 1;
}

void describe("AdminMetricsView", () => {
  void it("shows the latest week's First Lifts as the headline and 8 rows", () => {
    const html = renderToStaticMarkup(
      <AdminMetricsView state={{ kind: "ready", data: seeded() }} />,
    );
    const headline = html.split('data-testid="admin-metrics-headline"')[1] ?? "";
    assert.match(headline, /^>[^]*?>7<\/p>/);
    assert.match(headline, /20/);
    assert.equal(rowCount(html), 8);
    assert.equal(html.split("<th ").length - 1, 6);
  });

  void it("renders nothing for a non-admin (403)", () => {
    const state = stateFromError(new ApiError("Forbidden", { status: 403 }));
    assert.deepEqual(state, { kind: "forbidden" });
    assert.equal(renderToStaticMarkup(<AdminMetricsView state={state} />), "");
  });

  void it("shows an error row for any other failure", () => {
    const state = stateFromError(new ApiError("boom", { status: 500 }));
    assert.deepEqual(state, { kind: "error" });
    assert.match(renderToStaticMarkup(<AdminMetricsView state={state} />), /role="alert"/);
    assert.deepEqual(stateFromError(new Error("offline")), { kind: "error" });
  });

  void it("shows the empty state when no week has signups", () => {
    const data = seeded();
    data.first_lifts = data.first_lifts.map((row) => ({ ...row, signups: 0, first_lifts: 0 }));
    const html = renderToStaticMarkup(<AdminMetricsView state={{ kind: "ready", data }} />);
    assert.equal(html.includes("<table"), false);
    assert.match(html, /settings\.admin\.metrics\.empty|No signups yet|אין נרשמים עדיין/);
  });

  void it("shows a loader while loading", () => {
    assert.match(
      renderToStaticMarkup(<AdminMetricsView state={{ kind: "loading" }} />),
      /role="status"/,
    );
  });
});

void describe("northStarRows", () => {
  void it("joins the series by week, not by position", () => {
    const data = seeded();
    data.lifted_users = [...data.lifted_users].reverse();
    data.lifted_in_use = data.lifted_in_use.slice(1);
    const rows = northStarRows(data);
    assert.equal(rows.length, 8);
    assert.deepEqual(rows[0], {
      week: "2026-10-12",
      signups: 20,
      firstLifts: 7,
      newLifted: 3,
      returningLifted: 2,
      inUse: 0,
    });
    assert.equal(rows[1]?.inUse, 12);
  });
});
