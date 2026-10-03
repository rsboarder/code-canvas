import type { WorkspaceFolderId } from "../../shared/domain";
import { databaseFrom, requestResult } from "../../shared/indexed-db";

const DATABASE_NAME = "code-canvas-workspace";
const DATABASE_VERSION = 1;
const FOLDERS_STORE = "folders";
const STATE_STORE = "state";
const LAST_FOLDER_KEY = "lastFolderId";

export interface SavedFolder {
  readonly id: WorkspaceFolderId;
  readonly name: string;
  readonly handle: FileSystemDirectoryHandle;
}

export class FolderHandleStore {
  private constructor(private readonly database: IDBDatabase) {}

  public static async open(factory: IDBFactory): Promise<FolderHandleStore> {
    const database = await databaseFrom(
      factory.open(DATABASE_NAME, DATABASE_VERSION),
      (upgrade) => {
        if (!upgrade.objectStoreNames.contains(FOLDERS_STORE)) {
          upgrade.createObjectStore(FOLDERS_STORE, { keyPath: "id" });
        }
        if (!upgrade.objectStoreNames.contains(STATE_STORE)) {
          upgrade.createObjectStore(STATE_STORE);
        }
      },
    );
    return new FolderHandleStore(database);
  }

  public async all(): Promise<readonly SavedFolder[]> {
    const transaction = this.database.transaction(FOLDERS_STORE, "readonly");
    const request = transaction
      .objectStore(FOLDERS_STORE)
      .getAll() as IDBRequest<SavedFolder[]>;
    return requestResult(request);
  }

  public async save(folder: SavedFolder): Promise<void> {
    const transaction = this.database.transaction(FOLDERS_STORE, "readwrite");
    await requestResult(transaction.objectStore(FOLDERS_STORE).put(folder));
  }

  public async markLast(id: WorkspaceFolderId): Promise<void> {
    const transaction = this.database.transaction(STATE_STORE, "readwrite");
    await requestResult(
      transaction.objectStore(STATE_STORE).put(id, LAST_FOLDER_KEY),
    );
  }

  public async last(): Promise<SavedFolder | undefined> {
    const stateTransaction = this.database.transaction(STATE_STORE, "readonly");
    const id = await requestResult<WorkspaceFolderId | undefined>(
      stateTransaction
        .objectStore(STATE_STORE)
        .get(LAST_FOLDER_KEY) as IDBRequest<WorkspaceFolderId | undefined>,
    );
    if (id === undefined) return undefined;

    const foldersTransaction = this.database.transaction(
      FOLDERS_STORE,
      "readonly",
    );
    return requestResult<SavedFolder | undefined>(
      foldersTransaction.objectStore(FOLDERS_STORE).get(id) as IDBRequest<
        SavedFolder | undefined
      >,
    );
  }

  public close(): void {
    this.database.close();
  }
}
