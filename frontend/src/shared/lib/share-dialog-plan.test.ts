import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shareDialogPlan, type ShareDialogKind } from "./share-dialog-plan.ts";

const LINK_ONLY: ShareDialogKind[] = ["dataset", "folder", "tagger"];

void describe("shareDialogPlan in the hosted app", () => {
  for (const kind of ["optimization", ...LINK_ONLY] as ShareDialogKind[]) {
    void it(`${kind}: loads sharing and shows every control, no local notice`, () => {
      const plan = shareDialogPlan(kind, false);
      assert.equal(plan.loadSharing, true);
      assert.equal(plan.showLocalNotice, false);
      assert.equal(plan.showLinkAndPeople, true);
      assert.equal(plan.showExploreVisibility, kind === "optimization");
    });
  }
});

void describe("shareDialogPlan in the Mac app", () => {
  void it("optimization: keeps the Explore visibility control next to the notice", () => {
    assert.deepEqual(shareDialogPlan("optimization", true), {
      loadSharing: true,
      showLocalNotice: true,
      showLinkAndPeople: false,
      showExploreVisibility: true,
    });
  });

  for (const kind of LINK_ONLY) {
    void it(`${kind}: shows only the notice and loads nothing`, () => {
      assert.deepEqual(shareDialogPlan(kind, true), {
        loadSharing: false,
        showLocalNotice: true,
        showLinkAndPeople: false,
        showExploreVisibility: false,
      });
    });
  }
});
