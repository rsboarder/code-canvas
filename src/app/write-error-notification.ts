import type { SourceFileId } from "../shared/domain";
import type { EventBus } from "../shared/events";
import type { WorkspaceEvent, WorkspaceService } from "../workspace";

const INITIAL_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 30000;

interface WriteErrorNotificationOptions {
  readonly root: HTMLElement;
  readonly events: EventBus<WorkspaceEvent>;
  readonly workspace: Pick<WorkspaceService, "retryFailedWrites">;
}

export function createWriteErrorNotification(
  options: WriteErrorNotificationOptions,
): void {
  const element = document.createElement("div");
  element.setAttribute("role", "alert");
  element.setAttribute("data-testid", "write-error");
  element.hidden = true;
  element.textContent =
    "Could not save changes to disk. Your edits are kept and saving is retried.";
  element.style.position = "fixed";
  element.style.top = "56px";
  element.style.right = "16px";
  element.style.zIndex = "3";
  options.root.append(element);

  const failingFiles = new Set<SourceFileId>();
  let retryTimer: number | undefined;
  let retryDelay = INITIAL_RETRY_DELAY;

  const cancelRetry = (): void => {
    if (retryTimer === undefined) return;
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  const reset = (): void => {
    cancelRetry();
    retryDelay = INITIAL_RETRY_DELAY;
  };
  const scheduleRetry = (): void => {
    if (retryTimer !== undefined) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
      options.workspace.retryFailedWrites();
    }, retryDelay);
  };

  options.events.subscribe("DraftWriteFailed", (event) => {
    failingFiles.add(event.fileId);
    element.hidden = false;
    scheduleRetry();
  });
  options.events.subscribe("DraftWritten", (event) => {
    failingFiles.delete(event.fileId);
    if (failingFiles.size !== 0) return;
    element.hidden = true;
    reset();
  });
  options.events.subscribe("FilesDiscovered", () => {
    failingFiles.clear();
    element.hidden = true;
    reset();
  });
}
