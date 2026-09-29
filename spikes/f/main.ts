type PermissionStateValue = PermissionState;

interface DiscoveredFile {
  path: string;
  handle: FileSystemFileHandle;
  size: number;
}

interface LogEntry {
  step: string;
  status: "ok" | "error" | "info";
  durationMs?: number;
  details?: string;
  timestamp: string;
}

interface SaveBaseline {
  path: string;
  text: string;
  hash: string;
}

interface StoredFolder {
  handle: DirectoryHandle;
  storedAt: string;
}

interface DirectoryHandle extends FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<DirectoryEntry | FileEntry>;
  queryPermission(descriptor: {
    mode: "read" | "readwrite";
  }): Promise<PermissionState>;
  requestPermission(descriptor: {
    mode: "read" | "readwrite";
  }): Promise<PermissionState>;
}

interface DirectoryEntry extends DirectoryHandle {
  kind: "directory";
}

interface FileEntry extends FileSystemFileHandle {
  kind: "file";
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker(options: {
    mode: "read" | "readwrite";
  }): Promise<DirectoryHandle>;
}

const databaseName = "spike-f-file-system-access";
const databaseVersion = 1;
const storeName = "handles";
const storedHandleKey = "last-folder";
const excludedDirectories = new Set(["node_modules", ".git", "dist", "build"]);

const supportStatus = getElement("support-status") as HTMLParagraphElement;
const folderStatus = getElement("folder-status") as HTMLParagraphElement;
const conflictStatus = getElement("conflict-status") as HTMLParagraphElement;
const fileSelect = getElement("file-select") as HTMLSelectElement;
const logElement = getElement("log") as HTMLPreElement;

let folderHandle: DirectoryHandle | undefined;
let discoveredFiles: DiscoveredFile[] = [];
let saveBaseline: SaveBaseline | undefined;
const logEntries: LogEntry[] = [];

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing element: ${id}`);
  }
  return element;
}

function hasFileSystemAccess(): boolean {
  return (
    "showDirectoryPicker" in window && "FileSystemDirectoryHandle" in window
  );
}

function now(): string {
  return new Date().toISOString();
}

function addLog(
  step: string,
  status: LogEntry["status"],
  durationMs?: number,
  details?: string,
): void {
  logEntries.push({
    step,
    status,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(details === undefined ? {} : { details }),
    timestamp: now(),
  });
  renderLog();
}

function renderLog(): void {
  logElement.textContent = logEntries
    .map((entry) => {
      const duration =
        entry.durationMs === undefined
          ? ""
          : ` (${String(entry.durationMs)} ms)`;
      const details = entry.details === undefined ? "" : ` — ${entry.details}`;
      return `[${entry.timestamp}] ${entry.status.toUpperCase()} ${entry.step}${duration}${details}`;
    })
    .join("\n");
}

function detailsForError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

async function measure<T>(
  step: string,
  action: () => Promise<T>,
): Promise<T | undefined> {
  const started = performance.now();
  try {
    const result = await action();
    addLog(step, "ok", Math.round(performance.now() - started));
    return result;
  } catch (error) {
    addLog(
      step,
      "error",
      Math.round(performance.now() - started),
      detailsForError(error),
    );
    return undefined;
  }
}

function requireFolder(): DirectoryHandle {
  if (folderHandle === undefined) {
    throw new Error("Pick or restore a folder first");
  }
  return folderHandle;
}

function selectedFile(): DiscoveredFile {
  const selectedPath = fileSelect.value;
  const file = discoveredFiles.find(
    (candidate) => candidate.path === selectedPath,
  );
  if (file === undefined) {
    throw new Error("Scan the folder and select a file first");
  }
  return file;
}

function updateFolderStatus(extra = ""): void {
  const fileCount = discoveredFiles.length;
  folderStatus.textContent = folderHandle
    ? `${folderHandle.name}: ${String(fileCount)} TypeScript files${extra ? ` — ${extra}` : ""}`
    : "No folder selected.";
}

function updateFileSelect(): void {
  fileSelect.replaceChildren();
  for (const file of discoveredFiles) {
    const option = document.createElement("option");
    option.value = file.path;
    option.textContent = file.path;
    fileSelect.append(option);
  }
}

function isSourceFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".tsx");
}

function isExcludedDirectory(name: string): boolean {
  return name.startsWith(".") || excludedDirectories.has(name);
}

async function scanDirectory(
  directory: DirectoryHandle,
  parentPath: string,
  files: DiscoveredFile[],
): Promise<void> {
  for await (const entry of directory.values()) {
    const entryPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      if (!isExcludedDirectory(entry.name)) {
        await scanDirectory(entry, entryPath, files);
      }
    } else if (isSourceFile(entry.name)) {
      const file = await entry.getFile();
      files.push({ path: entryPath, handle: entry, size: file.size });
    }
  }
}

async function scanFolder(): Promise<void> {
  const directory = requireFolder();
  const result = await measure("scan folder", async () => {
    const files: DiscoveredFile[] = [];
    await scanDirectory(directory, "", files);
    files.sort((left, right) => left.path.localeCompare(right.path));
    return files;
  });
  if (result === undefined) {
    return;
  }
  discoveredFiles = result;
  saveBaseline = undefined;
  updateFileSelect();
  const totalBytes = result.reduce((total, file) => total + file.size, 0);
  updateFolderStatus(`${String(totalBytes)} bytes`);
  addLog(
    "scan summary",
    "info",
    undefined,
    `${String(result.length)} files, ${String(totalBytes)} bytes`,
  );
}

async function readAll(): Promise<void> {
  const files = discoveredFiles.length > 0 ? discoveredFiles : undefined;
  if (files === undefined) {
    await scanFolder();
  }
  const filesToRead = discoveredFiles;
  const result = await measure("read all", async () => {
    let totalBytes = 0;
    for (const file of filesToRead) {
      const contents = await (await file.handle.getFile()).arrayBuffer();
      totalBytes += contents.byteLength;
    }
    return totalBytes;
  });
  if (result !== undefined) {
    updateFolderStatus(`read ${String(result)} bytes`);
    addLog(
      "read all summary",
      "info",
      undefined,
      `${String(filesToRead.length)} files, ${String(result)} bytes`,
    );
  }
}

async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function readTextAndHash(
  file: DiscoveredFile,
): Promise<{ text: string; hash: string }> {
  const text = await (await file.handle.getFile()).text();
  return { text, hash: await hashText(text) };
}

async function prepareConflictCheck(): Promise<void> {
  const file = selectedFile();
  const result = await measure("read baseline and hash", () =>
    readTextAndHash(file),
  );
  if (result === undefined) {
    return;
  }
  saveBaseline = { path: file.path, ...result };
  conflictStatus.textContent = `Baseline ready for ${file.path}. Change it externally, then save.`;
  addLog(
    "conflict instructions",
    "info",
    undefined,
    "External change can now be tested before Edit + Save",
  );
}

async function editAndSave(): Promise<void> {
  const file = selectedFile();
  if (saveBaseline?.path !== file.path) {
    await prepareConflictCheck();
  }
  if (saveBaseline === undefined) {
    return;
  }

  const baseline = saveBaseline;
  const draft = `${baseline.text.replace(/\n?$/, "\n")}// Spike F edit ${now()}\n`;
  const result = await measure(
    "re-read and hash immediately before write",
    async () => {
      const current = await readTextAndHash(file);
      if (current.hash !== baseline.hash) {
        return { conflict: true, currentHash: current.hash };
      }
      const writable = await file.handle.createWritable();
      await writable.write(draft);
      await writable.close();
      return { conflict: false, currentHash: current.hash };
    },
  );
  if (result === undefined) {
    return;
  }
  if (result.conflict) {
    conflictStatus.textContent = `SaveConflict detected for ${file.path}; no write was attempted.`;
    addLog(
      "save conflict",
      "info",
      undefined,
      `expected ${baseline.hash}, found ${result.currentHash}`,
    );
    return;
  }
  conflictStatus.textContent = `Saved one appended comment line to ${file.path}.`;
  saveBaseline = undefined;
  addLog(
    "save result",
    "info",
    undefined,
    "write completed after matching SHA-256",
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB open failed"));
    };
  });
}

async function storeFolderHandle(): Promise<void> {
  const handle = requireFolder();
  await measure("store handle in IndexedDB", async () => {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction(storeName, "readwrite")
        .objectStore(storeName)
        .put(
          { handle, storedAt: now() } satisfies StoredFolder,
          storedHandleKey,
        );
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error ?? new Error("IndexedDB write failed"));
      };
    });
    database.close();
  });
}

async function loadStoredFolder(): Promise<StoredFolder | undefined> {
  const database = await openDatabase();
  const stored = await new Promise<StoredFolder | undefined>(
    (resolve, reject) => {
      const request = database
        .transaction(storeName, "readonly")
        .objectStore(storeName)
        .get(storedHandleKey);
      request.onsuccess = () => {
        resolve(request.result as StoredFolder | undefined);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("IndexedDB read failed"));
      };
    },
  );
  database.close();
  return stored;
}

async function permission(
  handle: DirectoryHandle,
  action: "query" | "request",
): Promise<PermissionStateValue> {
  return action === "query"
    ? handle.queryPermission({ mode: "readwrite" })
    : handle.requestPermission({ mode: "readwrite" });
}

async function restoreHandle(): Promise<void> {
  const stored = await measure(
    "restore handle from IndexedDB",
    loadStoredFolder,
  );
  if (stored === undefined) {
    addLog("restore result", "info", undefined, "No stored folder handle");
    return;
  }
  const restoredHandle = stored.handle;
  folderHandle = restoredHandle;
  const queried = await measure("queryPermission after restore", () =>
    permission(restoredHandle, "query"),
  );
  if (queried === "prompt") {
    addLog(
      "permission prompt",
      "info",
      undefined,
      "Click action is requesting readwrite permission",
    );
    const requested = await measure("requestPermission on click", () =>
      permission(restoredHandle, "request"),
    );
    if (requested !== "granted") {
      const permissionState = requested ?? "unknown";
      addLog(
        "restore result",
        "info",
        undefined,
        `Permission ${permissionState}; read skipped`,
      );
      return;
    }
  } else if (queried !== "granted") {
    addLog(
      "restore result",
      "info",
      undefined,
      `Permission ${String(queried)}; read skipped`,
    );
    return;
  }
  updateFolderStatus("permission granted; reading again");
  await scanFolder();
  await readAll();
}

async function repickAndCompare(): Promise<void> {
  if (!hasFileSystemAccess()) {
    throw new Error("File System Access API is unavailable");
  }
  const repicked = await (
    window as unknown as DirectoryPickerWindow
  ).showDirectoryPicker({ mode: "readwrite" });
  const stored = await loadStoredFolder();
  if (stored === undefined) {
    addLog(
      "isSameEntry",
      "info",
      undefined,
      "No stored handle; store a handle first",
    );
    return;
  }
  const sameEntry = await repicked.isSameEntry(stored.handle);
  addLog(
    "isSameEntry",
    "info",
    undefined,
    `${String(sameEntry)} (${repicked.name})`,
  );
}

function resultsAsJson(): string {
  return JSON.stringify(
    {
      spike: "F",
      generatedAt: now(),
      browser: navigator.userAgent,
      folder: folderHandle?.name ?? null,
      fileCount: discoveredFiles.length,
      selectedFile: fileSelect.value || null,
      logs: logEntries,
    },
    null,
    2,
  );
}

async function copyResults(): Promise<void> {
  await navigator.clipboard.writeText(resultsAsJson());
  addLog("copy results as JSON", "ok", undefined, "JSON copied to clipboard");
}

function wireButton(id: string, action: () => Promise<void>): void {
  (getElement(id) as HTMLButtonElement).addEventListener("click", () => {
    void measure(id, action);
  });
}

function setup(): void {
  if (hasFileSystemAccess()) {
    supportStatus.textContent =
      "File System Access API is available. Use Chrome on the reference MacBook for the manual run.";
  } else {
    supportStatus.textContent =
      "File System Access API is unavailable; use Chrome to run this spike.";
  }
  wireButton("pick-folder", async () => {
    if (!hasFileSystemAccess()) {
      throw new Error("File System Access API is unavailable");
    }
    folderHandle = await (
      window as unknown as DirectoryPickerWindow
    ).showDirectoryPicker({ mode: "readwrite" });
    discoveredFiles = [];
    saveBaseline = undefined;
    updateFileSelect();
    updateFolderStatus("picked; scan is ready");
  });
  wireButton("scan-folder", scanFolder);
  wireButton("read-all", readAll);
  wireButton("prepare-conflict", prepareConflictCheck);
  wireButton("edit-save", editAndSave);
  wireButton("store-handle", storeFolderHandle);
  wireButton("restore-handle", restoreHandle);
  wireButton("repick-compare", repickAndCompare);
  wireButton("copy-results", copyResults);
  (getElement("clear-log") as HTMLButtonElement).addEventListener(
    "click",
    () => {
      logEntries.length = 0;
      renderLog();
    },
  );
}

setup();
