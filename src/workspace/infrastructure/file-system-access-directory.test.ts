import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";

import { filePath } from "../domain/file-path";
import { fileRevisionOf } from "../domain/file-revision";
import type { PickedFolder } from "../application/ports";
import type { DirectoryPickerHost } from "./file-system-access-directory";
import { FileSystemAccessDirectory } from "./file-system-access-directory";
import { FolderHandleStore } from "./folder-handle-store";

class FakeFile {
  public constructor(
    private readonly bytes: Uint8Array,
    public readonly lastModified: number,
  ) {}

  public get size(): number {
    return this.bytes.byteLength;
  }

  public arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new Uint8Array(this.bytes).buffer);
  }
}

class FakeWritable {
  public aborted = false;

  public constructor(
    private readonly file: FakeFileHandle,
    private readonly failWrite: boolean,
  ) {}

  public write(bytes: Uint8Array): Promise<void> {
    if (this.failWrite) throw new Error("write failed");
    this.file.setBytes(bytes);
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  public abort(): Promise<void> {
    this.aborted = true;
    return Promise.resolve();
  }
}

class FakeFileHandle {
  public readonly kind = "file" as const;
  public readonly name: string;
  public readonly entryKey: string;
  public failWrite = false;
  public lastWritable: FakeWritable | undefined;

  public constructor(
    name: string,
    private bytes: Uint8Array,
    private modified = 1,
    entryKey = name,
  ) {
    this.name = name;
    this.entryKey = entryKey;
  }

  public getFile(): Promise<FakeFile> {
    return Promise.resolve(new FakeFile(this.bytes, this.modified));
  }

  public createWritable(): Promise<FakeWritable> {
    this.lastWritable = new FakeWritable(this, this.failWrite);
    return Promise.resolve(this.lastWritable);
  }

  public setBytes(bytes: Uint8Array): void {
    this.bytes = new Uint8Array(bytes);
    this.modified += 1;
  }
}

class FakeDirectoryHandle {
  public readonly kind = "directory" as const;
  public readonly name: string;
  public readonly entryKey: string;
  private readonly children = new Map<
    string,
    FakeDirectoryHandle | FakeFileHandle
  >();
  private permission: PermissionState = "granted";
  private requestedPermission: PermissionState = "granted";
  public queryCalls = 0;
  public requestCalls = 0;
  public rejectRequest = false;

  public constructor(name: string, entryKey = name) {
    this.name = name;
    this.entryKey = entryKey;
  }

  public addDirectory(directory: FakeDirectoryHandle): this {
    this.children.set(directory.name, directory);
    return this;
  }

  public addFile(file: FakeFileHandle): this {
    this.children.set(file.name, file);
    return this;
  }

  public entries(): AsyncIterableIterator<
    [string, FakeDirectoryHandle | FakeFileHandle]
  > {
    return this.iterateEntries();
  }

  public async *iterateEntries(): AsyncIterableIterator<
    [string, FakeDirectoryHandle | FakeFileHandle]
  > {
    await Promise.resolve();
    for (const entry of this.children) yield entry;
  }

  public getDirectoryHandle(name: string): Promise<FakeDirectoryHandle> {
    const child = this.children.get(name);
    if (!(child instanceof FakeDirectoryHandle)) {
      return Promise.reject(new Error(`Missing directory ${name}`));
    }
    return Promise.resolve(child);
  }

  public getFileHandle(name: string): Promise<FakeFileHandle> {
    const child = this.children.get(name);
    if (!(child instanceof FakeFileHandle)) {
      return Promise.reject(new Error(`Missing file ${name}`));
    }
    return Promise.resolve(child);
  }

  public isSameEntry(other: FileSystemDirectoryHandle): Promise<boolean> {
    return Promise.resolve(
      this.entryKey ===
        (other as unknown as { readonly entryKey?: string }).entryKey,
    );
  }

  public queryPermission(): Promise<PermissionState> {
    this.queryCalls += 1;
    return Promise.resolve(this.permission);
  }

  public requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    if (this.rejectRequest) return Promise.reject(new Error("activation"));
    return Promise.resolve(this.requestedPermission);
  }

  public setPermission(
    permission: PermissionState,
    requestedPermission = permission,
  ): void {
    this.permission = permission;
    this.requestedPermission = requestedPermission;
  }
}

function asDirectoryHandle(
  directory: FakeDirectoryHandle,
): FileSystemDirectoryHandle {
  return directory as unknown as FileSystemDirectoryHandle;
}

function sourceBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function adapterFor(
  root: FakeDirectoryHandle,
  factory = new IDBFactory(),
): Promise<{
  readonly adapter: FileSystemAccessDirectory;
  readonly store: FolderHandleStore;
}> {
  const store = await FolderHandleStore.open(factory);
  const host: DirectoryPickerHost = {
    showDirectoryPicker: vi.fn(() => Promise.resolve(asDirectoryHandle(root))),
  };
  return { adapter: new FileSystemAccessDirectory(host, store), store };
}

async function pickedAdapter(root: FakeDirectoryHandle): Promise<{
  readonly adapter: FileSystemAccessDirectory;
  readonly store: FolderHandleStore;
  readonly folder: PickedFolder;
}> {
  const context = await adapterFor(root);
  const folder = await context.adapter.pickFolder();
  if (folder === undefined) throw new Error("Expected folder");
  return { ...context, folder };
}

it("Project folder", async () => {
  const root = new FakeDirectoryHandle("project", "project");
  const source = new FakeDirectoryHandle("src");
  const nested = new FakeDirectoryHandle("nested");
  source.addFile(new FakeFileHandle("z.ts", sourceBytes("z")));
  nested.addFile(new FakeFileHandle("a.tsx", sourceBytes("tsx")));
  source.addDirectory(nested);
  root
    .addFile(new FakeFileHandle("root.ts", sourceBytes("root")))
    .addDirectory(source)
    .addDirectory(
      new FakeDirectoryHandle("node_modules").addFile(
        new FakeFileHandle("ignored.ts", sourceBytes("ignored")),
      ),
    )
    .addDirectory(new FakeDirectoryHandle(".git"))
    .addDirectory(new FakeDirectoryHandle("dist"))
    .addDirectory(new FakeDirectoryHandle("build"))
    .addDirectory(
      new FakeDirectoryHandle(".hidden").addFile(
        new FakeFileHandle("ignored.ts", sourceBytes("ignored")),
      ),
    )
    .addFile(new FakeFileHandle("README.md", sourceBytes("ignored")));
  const { adapter, store, folder } = await pickedAdapter(root);

  const entries = await adapter.listSourceFiles(folder);

  expect(entries.map((entry) => [entry.path, entry.size])).toEqual([
    ["root.ts", 4],
    ["src/nested/a.tsx", 3],
    ["src/z.ts", 1],
  ]);
  store.close();
});

it("readFile", async () => {
  const bytes = sourceBytes("const value = 1;");
  const file = new FakeFileHandle("value.ts", bytes, 17);
  const source = new FakeDirectoryHandle("src").addFile(file);
  const root = new FakeDirectoryHandle("project").addDirectory(source);
  const { adapter, store, folder } = await pickedAdapter(root);

  await expect(
    adapter.readFile(folder, filePath("src/value.ts")),
  ).resolves.toEqual({
    revision: fileRevisionOf(bytes),
    text: "const value = 1;",
    size: bytes.byteLength,
    lastModified: 17,
  });
  const invalid = new FakeFileHandle(
    "invalid.ts",
    new Uint8Array([0xc3, 0x28]),
    23,
  );
  root.addFile(invalid);
  await expect(
    adapter.readFile(folder, filePath("invalid.ts")),
  ).resolves.toEqual({
    revision: fileRevisionOf(new Uint8Array([0xc3, 0x28])),
    text: undefined,
    size: 2,
    lastModified: 23,
  });
  store.close();
});

it("writeFile", async () => {
  const file = new FakeFileHandle("value.ts", sourceBytes("old"), 4);
  const root = new FakeDirectoryHandle("project").addFile(file);
  const { adapter, store, folder } = await pickedAdapter(root);
  const bytes = sourceBytes("new text");

  const written = await adapter.writeFile(
    folder,
    filePath("value.ts"),
    "new text",
  );

  expect(written).toEqual({
    revision: fileRevisionOf(bytes),
    text: "new text",
    size: bytes.byteLength,
    lastModified: 5,
  });
  await expect(adapter.readFile(folder, filePath("value.ts"))).resolves.toEqual(
    written,
  );
  file.failWrite = true;
  await expect(
    adapter.writeFile(folder, filePath("value.ts"), "failed"),
  ).rejects.toThrow();
  expect(file.lastWritable?.aborted).toBe(true);
  store.close();
});

it("pickFolder", async () => {
  const factory = new IDBFactory();
  const first = await adapterFor(
    new FakeDirectoryHandle("project", "same"),
    factory,
  );
  const firstFolder = await first.adapter.pickFolder();
  expect(firstFolder).toBeDefined();
  first.store.close();
  const second = await adapterFor(
    new FakeDirectoryHandle("project", "same"),
    factory,
  );
  const secondFolder = await second.adapter.pickFolder();
  expect(secondFolder?.id).toBe(firstFolder?.id);
  second.store.close();
  const different = await adapterFor(
    new FakeDirectoryHandle("other", "other"),
    factory,
  );
  const differentFolder = await different.adapter.pickFolder();
  expect(differentFolder?.id).not.toBe(firstFolder?.id);
  different.store.close();

  const cancelledHost: DirectoryPickerHost = {
    showDirectoryPicker: vi.fn(() =>
      Promise.reject(
        new DOMException("The user aborted a request.", "AbortError"),
      ),
    ),
  };
  const cancelledStore = await FolderHandleStore.open(new IDBFactory());
  const cancelled = new FileSystemAccessDirectory(
    cancelledHost,
    cancelledStore,
  );
  await expect(cancelled.pickFolder()).resolves.toBeUndefined();
  cancelledStore.close();

  const pickerError = new DOMException("Not allowed.", "SecurityError");
  const errorHost: DirectoryPickerHost = {
    showDirectoryPicker: vi.fn(() => Promise.reject(pickerError)),
  };
  const errorStore = await FolderHandleStore.open(new IDBFactory());
  const errorAdapter = new FileSystemAccessDirectory(errorHost, errorStore);
  await expect(errorAdapter.pickFolder()).rejects.toBe(pickerError);
  errorStore.close();
});

it("lastFolder", async () => {
  const factory = new IDBFactory();
  const root = new FakeDirectoryHandle("project", "same");
  const first = await adapterFor(root, factory);
  const picked = await first.adapter.pickFolder();
  first.store.close();
  const second = await adapterFor(new FakeDirectoryHandle("unused"), factory);

  await expect(second.adapter.lastFolder()).resolves.toEqual(picked);
  second.store.close();
});

it("ensurePermission", async () => {
  const root = new FakeDirectoryHandle("project");
  const { adapter, store, folder } = await pickedAdapter(root);
  root.setPermission("granted", "denied");
  await expect(adapter.ensurePermission(folder)).resolves.toBe(true);
  expect(root.requestCalls).toBe(0);
  root.setPermission("prompt", "granted");
  await expect(adapter.ensurePermission(folder)).resolves.toBe(true);
  root.setPermission("prompt", "denied");
  await expect(adapter.ensurePermission(folder)).resolves.toBe(false);
  root.rejectRequest = true;
  await expect(adapter.ensurePermission(folder)).resolves.toBe(false);
  store.close();
});

it("isSupported", async () => {
  const supported = await adapterFor(new FakeDirectoryHandle("project"));
  expect(supported.adapter.isSupported()).toBe(true);
  supported.store.close();
  const unsupportedStore = await FolderHandleStore.open(new IDBFactory());
  const unsupported = new FileSystemAccessDirectory({}, unsupportedStore);
  expect(unsupported.isSupported()).toBe(false);
  unsupportedStore.close();
});
