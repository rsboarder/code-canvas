export function databaseFrom(
  request: IDBOpenDBRequest,
  onUpgrade: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = () => {
      onUpgrade(request.result);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB open failed."));
    };
    request.onblocked = () => {
      reject(new Error("IndexedDB open was blocked."));
    };
  });
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  const transaction = request.transaction;
  if (transaction === null) {
    return Promise.reject(new Error("IndexedDB request has no transaction."));
  }
  return new Promise((resolve, reject) => {
    let result: T;
    let hasResult = false;
    let settled = false;
    const fail = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    request.onsuccess = () => {
      result = request.result;
      hasResult = true;
    };
    request.onerror = () => {
      fail(request.error ?? new Error("IndexedDB request failed."));
    };
    transaction.oncomplete = () => {
      if (!hasResult) {
        fail(new Error("IndexedDB transaction completed without a result."));
        return;
      }
      settled = true;
      resolve(result);
    };
    transaction.onerror = () => {
      fail(transaction.error ?? new Error("IndexedDB transaction failed."));
    };
    transaction.onabort = () => {
      fail(transaction.error ?? new Error("IndexedDB transaction aborted."));
    };
  });
}
