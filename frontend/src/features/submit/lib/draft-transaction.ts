/** Complete draft operations only after IndexedDB commits the whole transaction. */
export function committedDraftTransaction<T>(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore, result: (value: T) => void, tx: IDBTransaction) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      const tx = db.transaction(storeNames, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? new Error("indexeddb_aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("indexeddb_failed"));
      const first = Array.isArray(storeNames) ? (storeNames[0] as string) : storeNames;
      op(
        tx.objectStore(first),
        (result) => {
          value = result;
        },
        tx,
      );
    } catch (error) {
      reject(error);
    }
  });
}
