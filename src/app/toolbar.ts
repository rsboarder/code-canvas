export function createToolbar(root: HTMLElement): {
  readonly enable: (actions: {
    readonly openFolder: () => void;
    readonly reopenFolder: () => void;
    readonly fitAll: () => void;
    readonly zoomTo100: () => void;
  }) => void;
  readonly setStatus: (text: string) => void;
  readonly offerReopen: (folderName: string) => void;
  readonly hideReopenOffer: () => void;
} {
  const toolbar = document.createElement("div");
  toolbar.style.position = "fixed";
  toolbar.style.zIndex = "2";
  toolbar.style.top = "16px";
  toolbar.style.left = "16px";
  toolbar.style.display = "flex";
  toolbar.style.gap = "12px";

  const openButton = createButton("Open folder", "open-folder");
  const reopenButton = createButton("Reopen folder", "reopen-folder");
  reopenButton.hidden = true;
  const fitButton = createButton("Fit all", "fit-all");
  fitButton.title = "Fit all (Shift+1)";
  const zoomButton = createButton("100%", "zoom-100");
  zoomButton.title = "Zoom to 100% (Shift+0)";
  const status = document.createElement("span");
  const initialStatus = "Choose a folder to open a TypeScript source file.";
  status.textContent = initialStatus;
  status.style.padding = "8px 0";
  toolbar.append(openButton, reopenButton, fitButton, zoomButton, status);
  root.append(toolbar);

  let currentStatus = initialStatus;
  return {
    enable: (actions) => {
      openButton.addEventListener("click", actions.openFolder);
      reopenButton.addEventListener("click", actions.reopenFolder);
      fitButton.addEventListener("click", actions.fitAll);
      zoomButton.addEventListener("click", actions.zoomTo100);
      openButton.disabled = false;
      fitButton.disabled = false;
      zoomButton.disabled = false;
      reopenButton.disabled = false;
    },
    setStatus: (text) => {
      if (text === currentStatus) return;
      currentStatus = text;
      status.textContent = text;
    },
    offerReopen: (folderName) => {
      reopenButton.textContent = `Reopen ${folderName}`;
      reopenButton.hidden = false;
    },
    hideReopenOffer: () => {
      reopenButton.hidden = true;
    },
  };
}

function createButton(text: string, testId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.disabled = true;
  button.textContent = text;
  button.setAttribute("data-testid", testId);
  button.style.padding = "8px 14px";
  button.style.cursor = "pointer";
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  return button;
}
