import assert from "node:assert/strict";
import { test } from "node:test";

import { park, unpark, type Parkable } from "./park.ts";

class FakeElement implements Parkable {
  readonly props = new Map<string, string>();
  readonly style = {
    setProperty: (prop: string, value: string | null) => {
      this.props.set(prop, value ?? "");
    },
    removeProperty: (prop: string) => {
      const prior = this.props.get(prop) ?? "";
      this.props.delete(prop);
      return prior;
    },
  };
}

class FakeHost {
  readonly children: FakeElement[] = [];
  append(element: FakeElement): void {
    this.children.push(element);
  }
}

test("a parked workbench is out of rendering, not merely invisible", () => {
  const element = new FakeElement();
  const body = new FakeHost();

  park(element, body);

  // `visibility: hidden` let the editor's own visible layers keep painting.
  assert.equal(element.props.get("display"), "none");
  assert.equal(element.props.get("pointer-events"), "none");
  assert.equal(element.props.has("visibility"), false);
  assert.deepEqual(body.children, [element]);
});

test("unparking shows the workbench in the pop-up and keeps its other styles", () => {
  const element = new FakeElement();
  element.style.setProperty("width", "100%");
  const into = new FakeHost();

  park(element, new FakeHost());
  unpark(element, into);

  assert.deepEqual([...element.props], [["width", "100%"]]);
  assert.deepEqual(into.children, [element]);
});
