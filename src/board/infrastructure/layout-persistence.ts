import type { WorkspaceFolderId } from "../../shared/domain";
import type { BoardService } from "../application/board-service";
import type { ViewportSize } from "../application/board-read-model";
import type { BoardFile } from "../domain/board-file";
import type { SavedLayout } from "../domain/saved-layout";
import { LayoutStore } from "./layout-store";

interface LayoutPersistenceOptions {
  readonly board: BoardService;
  readonly store: LayoutStore;
  readonly viewport: () => ViewportSize;
  readonly onRestored?: () => void;
}

export class LayoutPersistence {
  private readonly board: BoardService;
  private readonly store: LayoutStore;
  private readonly viewport: LayoutPersistenceOptions["viewport"];
  private readonly onRestored: LayoutPersistenceOptions["onRestored"];
  private readonly interval: ReturnType<typeof setInterval>;
  private readonly lastSavedRevision = new Map<WorkspaceFolderId, number>();
  private readonly pendingSaves = new Map<WorkspaceFolderId, Promise<void>>();
  private discoveryVersion = 0;

  constructor(options: LayoutPersistenceOptions) {
    this.board = options.board;
    this.store = options.store;
    this.viewport = options.viewport;
    this.onRestored = options.onRestored;
    this.interval = setInterval(() => {
      void this.saveOpenFolder();
    }, 1000);
  }

  dispose(): void {
    clearInterval(this.interval);
  }

  folderDiscovered(
    folderId: WorkspaceFolderId,
    files: readonly BoardFile[],
  ): void {
    const version = this.discoveryVersion + 1;
    this.discoveryVersion = version;
    void this.restore(folderId, files, version);
  }

  private async restore(
    folderId: WorkspaceFolderId,
    files: readonly BoardFile[],
    version: number,
  ): Promise<void> {
    await this.saveOpenFolder();
    let saved: SavedLayout | undefined;
    try {
      saved = await this.store.load(folderId);
    } catch {
      saved = undefined;
    }
    if (version !== this.discoveryVersion) return;
    this.board.restoreBoard(folderId, files, saved, this.viewport());
    this.onRestored?.();
  }

  private async saveOpenFolder(): Promise<void> {
    const folderId = this.board.folderId;
    if (folderId === undefined) return;
    await this.saveIfChanged(folderId);
  }

  private async saveIfChanged(folderId: WorkspaceFolderId): Promise<void> {
    const revision = this.board.savedLayoutRevision;
    if (this.lastSavedRevision.get(folderId) === revision) return;
    const pending = this.pendingSaves.get(folderId);
    if (pending !== undefined) {
      await pending;
      const latestRevision = this.board.savedLayoutRevision;
      if (this.lastSavedRevision.get(folderId) === latestRevision) return;
      await this.saveIfChanged(folderId);
      return;
    }
    const layout = this.board.savedLayout();
    const save = this.store
      .save(folderId, layout)
      .then(() => {
        this.lastSavedRevision.set(folderId, revision);
      })
      .catch(() => {
        this.lastSavedRevision.delete(folderId);
      })
      .finally(() => {
        this.pendingSaves.delete(folderId);
      });
    this.pendingSaves.set(folderId, save);
    await save;
  }
}
