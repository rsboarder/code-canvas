import type { WorkspaceFolderId } from "../../shared/domain";
import { databaseFrom, requestResult } from "../../shared/indexed-db";
import type { SavedLayout } from "../domain/saved-layout";

const DATABASE_NAME = "code-canvas-board";
const DATABASE_VERSION = 1;
const LAYOUTS_STORE = "layouts";

export class LayoutStore {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(factory: IDBFactory): Promise<LayoutStore> {
    const database = await databaseFrom(
      factory.open(DATABASE_NAME, DATABASE_VERSION),
      (upgrade) => {
        if (!upgrade.objectStoreNames.contains(LAYOUTS_STORE)) {
          upgrade.createObjectStore(LAYOUTS_STORE);
        }
      },
    );
    return new LayoutStore(database);
  }

  async load(folderId: WorkspaceFolderId): Promise<SavedLayout | undefined> {
    const transaction = this.database.transaction(LAYOUTS_STORE, "readonly");
    const request = transaction
      .objectStore(LAYOUTS_STORE)
      .get(folderId) as IDBRequest<SavedLayout | undefined>;
    return requestResult(request);
  }

  async save(folderId: WorkspaceFolderId, layout: SavedLayout): Promise<void> {
    const transaction = this.database.transaction(LAYOUTS_STORE, "readwrite");
    await requestResult(
      transaction.objectStore(LAYOUTS_STORE).put(layout, folderId),
    );
  }

  close(): void {
    this.database.close();
  }
}
