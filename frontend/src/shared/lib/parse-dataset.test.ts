/** Contract: CSV uploads parse per RFC 4180, whatever the line endings or quoting. */

import assert from "node:assert/strict";
import test from "node:test";

import { parseDatasetFile } from "./parse-dataset.ts";

const parse = (text: string) => parseDatasetFile(new File([text], "data.csv"));

test("plain rows trim fields and skip blank lines", async () => {
  const out = await parse("a, b\n1 ,2\n\n3,4\n");
  assert.deepEqual(out.columns, ["a", "b"]);
  assert.deepEqual(out.rows, [
    { a: "1", b: "2" },
    { a: "3", b: "4" },
  ]);
});

test("quoted fields keep commas, newlines and escaped quotes", async () => {
  const out = await parse('q,n\n"x, ""y""\nz",7\n');
  assert.deepEqual(out.rows, [{ q: 'x, "y"\nz', n: "7" }]);
});

test("CRLF and bare CR both end rows", async () => {
  const out = await parse("a,b\r\n1,2\r3,4");
  assert.deepEqual(out.rows, [
    { a: "1", b: "2" },
    { a: "3", b: "4" },
  ]);
});

test("an unterminated quote runs to the end of the file", async () => {
  const out = await parse('a,b\n1,"open\nstill open');
  assert.deepEqual(out.rows, [{ a: "1", b: "open\nstill open" }]);
});

test("missing trailing fields become empty strings", async () => {
  const out = await parse("a,b,c\n1\n");
  assert.deepEqual(out.rows, [{ a: "1", b: "", c: "" }]);
});
