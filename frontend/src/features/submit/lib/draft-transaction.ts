/** Complete draft operations only after IndexedDB commits the whole transaction. */
export function committedDraftTransaction<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? new Error("indexeddb_aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("indexeddb_failed"));
      op(tx.objectStore(storeName), (result) => {
        value = result;
      });
    } catch (error) {
      reject(error);
    }
  });
}
