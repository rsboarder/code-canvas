import type { PerfFile } from "./bridge";

interface DirectoryNode {
  readonly kind: "directory";
  readonly children: Map<string, DirectoryNode | FileNode>;
}

interface FileNode {
  readonly kind: "file";
  readonly text: string;
}

export function createInMemoryDirectory(
  files: readonly PerfFile[],
): FileSystemDirectoryHandle {
  const root: DirectoryNode = { kind: "directory", children: new Map() };
  for (const file of files) addFile(root, file);
  return toDirectoryHandle(root);
}

function addFile(root: DirectoryNode, file: PerfFile): void {
  const parts = file.path.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) return;
  let directory = root;
  for (const part of parts) {
    const child = directory.children.get(part);
    if (child?.kind === "file") return;
    if (child) {
      directory = child;
      continue;
    }
    const created: DirectoryNode = {
      kind: "directory",
      children: new Map(),
    };
    directory.children.set(part, created);
    directory = created;
  }
  directory.children.set(fileName, { kind: "file", text: file.text });
}

function toDirectoryHandle(node: DirectoryNode): FileSystemDirectoryHandle {
  const handle = {
    kind: node.kind,
    entries: async function* (): AsyncIterableIterator<
      [string, FileSystemHandle]
    > {
      await Promise.resolve();
      for (const [name, child] of node.children) {
        yield [
          name,
          child.kind === "directory"
            ? toDirectoryHandle(child)
            : toFileHandle(child),
        ];
      }
    },
  };
  return handle as unknown as FileSystemDirectoryHandle;
}

function toFileHandle(node: FileNode): FileSystemFileHandle {
  return {
    kind: node.kind,
    getFile: async () => {
      await Promise.resolve();
      return {
        text: async () => {
          await Promise.resolve();
          return node.text;
        },
      } as File;
    },
  } as unknown as FileSystemFileHandle;
}
