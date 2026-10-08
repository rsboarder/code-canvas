import type { BoardService, ViewportSize } from "../board";
import type { DocumentResidency } from "../code-view";
import {
  FileSystemAccessDirectory,
  type DirectoryPickerHost,
} from "../workspace/infrastructure/file-system-access-directory";
import { FolderHandleStore } from "../workspace/infrastructure/folder-handle-store";
import { LayoutPersistence } from "../board/infrastructure/layout-persistence";
import { LayoutStore } from "../board/infrastructure/layout-store";
import type { EventBus } from "../shared/events";
import type { SourceFileId } from "../shared/domain";
import { WorkspaceService, type WorkspaceEvent } from "../workspace";

export interface WorkspaceWiring {
  readonly workspace: WorkspaceService;
  readonly pathOfFile: (fileId: SourceFileId) => string | undefined;
  readonly fileIdForPath: (path: string) => SourceFileId | undefined;
  readonly firstFileId: () => SourceFileId | undefined;
}

interface WorkspaceWiringOptions {
  readonly board: BoardService;
  readonly residency: DocumentResidency;
  readonly events: EventBus<WorkspaceEvent>;
  readonly viewport: () => ViewportSize;
  readonly onLayoutRestored: () => void;
}

export async function createWorkspaceWiring(
  options: WorkspaceWiringOptions,
): Promise<WorkspaceWiring> {
  const folderStore = await FolderHandleStore.open(indexedDB);
  const layoutStore = await LayoutStore.open(indexedDB);
  const directory = new FileSystemAccessDirectory(
    window as unknown as DirectoryPickerHost,
    folderStore,
  );
  const workspace = new WorkspaceService(directory, directory, options.events);
  const layoutPersistence = new LayoutPersistence({
    board: options.board,
    store: layoutStore,
    viewport: options.viewport,
    onRestored: options.onLayoutRestored,
  });
  const pathsByFileId = new Map<SourceFileId, string>();
  const fileIdsByPath = new Map<string, SourceFileId>();
  let firstFileIdByPath: SourceFileId | undefined;
  options.events.subscribe("FilesDiscovered", (event) => {
    pathsByFileId.clear();
    fileIdsByPath.clear();
    firstFileIdByPath = undefined;
    let firstPath: string | undefined;
    for (const file of event.files) {
      pathsByFileId.set(file.fileId, file.path);
      fileIdsByPath.set(file.path, file.fileId);
      if (
        firstPath === undefined ||
        file.path.localeCompare(firstPath, "en") < 0
      ) {
        firstPath = file.path;
        firstFileIdByPath = file.fileId;
      }
    }
    layoutPersistence.folderDiscovered(event.folderId, event.files);
  });
  options.events.subscribe("FileContentChanged", (event) => {
    options.residency.contentChanged(
      event.fileId,
      event.contentVersion,
      event.text,
    );
  });
  return {
    workspace,
    pathOfFile: (fileId) => pathsByFileId.get(fileId),
    fileIdForPath: (path) => fileIdsByPath.get(path),
    firstFileId: () => firstFileIdByPath,
  };
}
