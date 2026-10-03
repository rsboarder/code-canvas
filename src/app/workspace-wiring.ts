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
import {
  WorkspaceService,
  type DiscoveredFile,
  type FileContentChanged,
  type WorkspaceEvent,
} from "../workspace";

export interface DocumentFile {
  readonly fileId: SourceFileId;
  readonly path: string;
  readonly text: string;
  readonly contentVersion: number;
}

export interface WorkspaceWiring {
  readonly workspace: WorkspaceService;
  readonly documentFile: (fileId: SourceFileId) => DocumentFile | undefined;
  readonly firstDocumentFile: () => DocumentFile | undefined;
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
  const discoveredFiles = new Map<SourceFileId, DiscoveredFile>();
  const content = new Map<SourceFileId, FileContentChanged>();
  options.events.subscribe("FilesDiscovered", (event) => {
    discoveredFiles.clear();
    for (const file of event.files) discoveredFiles.set(file.fileId, file);
    layoutPersistence.folderDiscovered(event.folderId, event.files);
  });
  options.events.subscribe("FileContentChanged", (event) => {
    content.set(event.fileId, event);
    options.residency.contentChanged(
      event.fileId,
      event.contentVersion,
      event.text,
    );
  });
  return {
    workspace,
    documentFile: (fileId) => documentFile(fileId, discoveredFiles, content),
    firstDocumentFile: () => firstDocumentFile(discoveredFiles, content),
  };
}

function documentFile(
  fileId: SourceFileId,
  discoveredFiles: ReadonlyMap<SourceFileId, DiscoveredFile>,
  content: ReadonlyMap<SourceFileId, FileContentChanged>,
): DocumentFile | undefined {
  const discovered = discoveredFiles.get(fileId);
  const changed = content.get(fileId);
  if (!discovered || !changed) return undefined;
  return {
    fileId,
    path: discovered.path,
    text: changed.text,
    contentVersion: changed.contentVersion,
  };
}

function firstDocumentFile(
  discoveredFiles: ReadonlyMap<SourceFileId, DiscoveredFile>,
  content: ReadonlyMap<SourceFileId, FileContentChanged>,
): DocumentFile | undefined {
  let first: DiscoveredFile | undefined;
  for (const file of discoveredFiles.values()) {
    if (!first || file.path.localeCompare(first.path, "en") < 0) first = file;
  }
  return first
    ? documentFile(first.fileId, discoveredFiles, content)
    : undefined;
}
