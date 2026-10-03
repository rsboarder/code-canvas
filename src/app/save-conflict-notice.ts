import type { SourceFileId } from "../shared/domain";
import type { EventBus } from "../shared/events";
import type { WorkspaceEvent, WorkspaceService } from "../workspace";

export interface SaveConflictEditing {
  readonly activeWidgetId: () => SourceFileId | undefined;
  readonly discard: () => void;
  readonly focus: () => void;
}

interface SaveConflictNoticeOptions {
  readonly root: HTMLElement;
  readonly events: EventBus<WorkspaceEvent>;
  readonly workspace: Pick<WorkspaceService, "resolveConflict">;
  readonly pathOf: (fileId: SourceFileId) => string | undefined;
  readonly editing: SaveConflictEditing;
}

type ConflictResolution = "disk" | "mine";

interface SaveConflictNoticeDom {
  readonly element: HTMLDivElement;
  readonly message: HTMLParagraphElement;
  readonly diskButton: HTMLButtonElement;
  readonly mineButton: HTMLButtonElement;
}

function firstPending(
  pending: ReadonlySet<SourceFileId>,
): SourceFileId | undefined {
  return pending.values().next().value;
}

function setButtonsDisabled(
  buttons: readonly HTMLButtonElement[],
  disabled: boolean,
): void {
  for (const button of buttons) button.disabled = disabled;
}

function createNoticeDom(): SaveConflictNoticeDom {
  const element = document.createElement("div");
  element.setAttribute("role", "alertdialog");
  element.setAttribute("data-testid", "save-conflict");
  element.hidden = true;
  element.style.position = "fixed";
  element.style.top = "104px";
  element.style.right = "16px";
  element.style.zIndex = "3";
  element.style.maxWidth = "420px";
  element.style.background = "#202938";
  element.style.border = "1px solid #93c5fd";
  element.style.padding = "12px";
  element.style.color = "#f8fafc";
  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.gap = "8px";
  const message = document.createElement("p");
  message.style.margin = "0";
  const buttonsWrapper = document.createElement("div");
  buttonsWrapper.style.display = "flex";
  buttonsWrapper.style.gap = "8px";
  const diskButton = document.createElement("button");
  diskButton.setAttribute("data-testid", "save-conflict-disk");
  diskButton.textContent = "Keep the version on disk";
  const mineButton = document.createElement("button");
  mineButton.setAttribute("data-testid", "save-conflict-mine");
  mineButton.textContent = "Overwrite with mine";
  buttonsWrapper.append(diskButton, mineButton);
  wrapper.append(message, buttonsWrapper);
  element.append(wrapper);
  return { element, message, diskButton, mineButton };
}

export function createSaveConflictNotice(
  options: SaveConflictNoticeOptions,
): void {
  const { element, message, diskButton, mineButton } = createNoticeDom();
  options.root.append(element);
  const buttons = [diskButton, mineButton] as const;

  const pending = new Set<SourceFileId>();
  let resolving = false;
  const render = (): void => {
    const fileId = firstPending(pending);
    if (fileId === undefined) {
      element.hidden = true;
      return;
    }
    const path = options.pathOf(fileId) ?? fileId;
    message.textContent = `${path} was changed on disk while you have unsaved edits.`;
    element.hidden = false;
  };

  const resolve = async (choice: ConflictResolution): Promise<void> => {
    const fileId = firstPending(pending);
    if (fileId === undefined || resolving) return;
    resolving = true;
    setButtonsDisabled(buttons, true);
    let succeeded = false;
    try {
      if (choice === "disk" && options.editing.activeWidgetId() === fileId) {
        options.editing.discard();
      }
      succeeded = await options.workspace.resolveConflict(fileId, choice);
      if (
        succeeded &&
        choice === "mine" &&
        options.editing.activeWidgetId() === fileId
      ) {
        options.editing.focus();
      }
    } catch {
      succeeded = false;
    } finally {
      resolving = false;
      setButtonsDisabled(buttons, false);
      if (succeeded) pending.delete(fileId);
      render();
    }
  };

  diskButton.addEventListener("click", () => void resolve("disk"));
  mineButton.addEventListener("click", () => void resolve("mine"));
  options.events.subscribe("SaveConflictDetected", (event) => {
    pending.add(event.fileId);
    render();
  });
  options.events.subscribe("FilesDiscovered", () => {
    pending.clear();
    render();
  });
}
