import assert from "node:assert/strict";
import { test } from "node:test";
import { committedDraftTransaction } from "./draft-transaction.ts";

function transactionFixture() {
  const tx = {
    objectStore: () => ({}),
    error: null,
    oncomplete: null,
    onabort: null,
    onerror: null,
  };
  const db = { transaction: () => tx } as unknown as IDBDatabase;
  return { db, tx: tx as unknown as IDBTransaction };
}

test("request success remains pending until the transaction commits", async () => {
  const { db, tx } = transactionFixture();
  let settled = false;
  const pending = committedDraftTransaction(db, "drafts", "readwrite", (_store, result) =>
    result("saved"),
  );
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  tx.oncomplete?.call(tx, new Event("complete"));
  assert.equal(await pending, "saved");
});

test("an abort after request success still rejects the save", async () => {
  const { db, tx } = transactionFixture();
  const pending = committedDraftTransaction(db, "drafts", "readwrite", (_store, result) =>
    result("saved"),
  );
  tx.onabort?.call(tx, new Event("abort"));
  await assert.rejects(pending, /indexeddb_aborted/);
});
