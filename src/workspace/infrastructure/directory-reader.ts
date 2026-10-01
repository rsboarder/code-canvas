interface OpenSourceFile {
  readonly fileId: string;
  readonly path: string;
  readonly text: string;
}

interface DirectoryLike {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

function isSourceFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".tsx");
}

async function firstSourceFile(
  directory: DirectoryLike,
  prefix = "",
): Promise<OpenSourceFile | undefined> {
  const entries: [string, FileSystemHandle][] = [];
  for await (const entry of directory.entries()) entries.push(entry);
  entries.sort(([left], [right]) => left.localeCompare(right));
  for (const [name, handle] of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "file" && isSourceFile(name)) {
      const file = await (handle as FileSystemFileHandle).getFile();
      return { fileId: path, path, text: await file.text() };
    }
    if (handle.kind === "directory") {
      const found = await firstSourceFile(
        handle as unknown as DirectoryLike,
        path,
      );
      if (found) return found;
    }
  }
  return undefined;
}

export async function openSourceFile(): Promise<OpenSourceFile | undefined> {
  const picker = (
    window as Window & {
      showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) return undefined;
  const directory = (await picker()) as unknown as DirectoryLike;
  return firstSourceFile(directory);
}
