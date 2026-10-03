import type { EventBus } from "../shared/events";
import type {
  OpenFolderOutcome,
  WorkspaceEvent,
  WorkspaceService,
} from "../workspace";
import type { createToolbar } from "./toolbar";

interface FolderActionsOptions {
  readonly workspace: Pick<
    WorkspaceService,
    "openFolder" | "reopenLastFolder" | "lastFolderName"
  >;
  readonly toolbar: ReturnType<typeof createToolbar>;
  readonly events: EventBus<WorkspaceEvent>;
}

export function createFolderActions(options: FolderActionsOptions): {
  readonly openFolder: () => Promise<void>;
  readonly reopenLastFolder: () => Promise<void>;
  readonly offerReopenOnStart: () => Promise<void>;
} {
  options.events.subscribe("FilesDiscovered", () => {
    options.toolbar.hideReopenOffer();
  });

  return {
    openFolder: async () => {
      const outcome = await options.workspace.openFolder();
      showOutcome(outcome, options.toolbar);
    },
    reopenLastFolder: async () => {
      const outcome = await options.workspace.reopenLastFolder();
      showOutcome(outcome, options.toolbar);
    },
    offerReopenOnStart: async () => {
      const folderName = await options.workspace.lastFolderName();
      if (folderName !== undefined) options.toolbar.offerReopen(folderName);
    },
  };
}

function showOutcome(
  outcome: OpenFolderOutcome,
  toolbar: ReturnType<typeof createToolbar>,
): void {
  switch (outcome.kind) {
    case "unsupported":
      toolbar.setStatus("This browser cannot open local folders.");
      return;
    case "empty":
      toolbar.setStatus("The folder has no .ts or .tsx files.");
      return;
    case "permission-denied":
      toolbar.setStatus("Permission to read the folder was not granted.");
      return;
    case "no-last-folder":
      toolbar.setStatus("There is no folder to reopen.");
      toolbar.hideReopenOffer();
      return;
    case "cancelled":
      return;
    case "opened":
      if (outcome.overLimit) {
        toolbar.setStatus(
          `${String(outcome.fileCount)} files: the performance targets hold for up to 200 files.`,
        );
      }
      return;
  }
}
