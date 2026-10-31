/** Tests for reading files of any type into composer attachments. */

import assert from "node:assert/strict";
import test from "node:test";

import { MAX_ATTACHMENT_MB, readAttachments } from "./file-attachments.ts";

test("any file type is sent for reading, in the order picked", async () => {
  const files = [
    new File(["MZ"], "tool.exe"),
    new File(["png"], "photo.png", { type: "image/png" }),
    new File(["%PDF"], "report.pdf", { type: "application/pdf" }),
    new File(["plain"], "README"),
  ];
  const seen: string[] = [];
  const result = await readAttachments(files, async (file) => {
    seen.push(file.name);
    return `text of ${file.name}`;
  });
  assert.deepEqual(seen, ["tool.exe", "photo.png", "report.pdf", "README"]);
  assert.deepEqual(
    result.attached.map((f) => f.name),
    ["tool.exe", "photo.png", "report.pdf", "README"],
  );
  assert.equal(result.attached[2].text, "text of report.pdf");
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.tooLarge, []);
});

test("oversized files are skipped and failed reads are reported", async () => {
  const big = new File(["x"], "huge.bin");
  Object.defineProperty(big, "size", { value: MAX_ATTACHMENT_MB * 1024 * 1024 + 1 });
  const result = await readAttachments(
    [big, new File(["a"], "bad.docx"), new File(["b"], "ok.txt")],
    async (file) => {
      if (file.name === "bad.docx") throw new Error("500");
      return "ok";
    },
  );
  assert.deepEqual(result.tooLarge, ["huge.bin"]);
  assert.deepEqual(result.failed, ["bad.docx"]);
  assert.deepEqual(result.attached, [{ name: "ok.txt", text: "ok" }]);
});
