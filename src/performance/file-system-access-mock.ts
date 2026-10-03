import type { PerfFile } from "./bridge";

const DATASET_DIRECTORY = "reference-dataset";
let directoryCounter = 0;

interface DirectoryHandleWithEntries extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

export async function createReferenceDirectory(
  files: readonly PerfFile[],
): Promise<FileSystemDirectoryHandle> {
  const opfs = await navigator.storage.getDirectory();
  await removeExistingDatasets(opfs);
  const directoryName = `${DATASET_DIRECTORY}-${String(directoryCounter++)}`;
  const directory = await opfs.getDirectoryHandle(directoryName, {
    create: true,
  });
  for (const file of files) await writeFile(directory, file);
  return directory;
}

async function removeExistingDatasets(
  opfs: FileSystemDirectoryHandle,
): Promise<void> {
  const directory = opfs as unknown as DirectoryHandleWithEntries;
  for await (const [name] of directory.entries()) {
    if (!name.startsWith(DATASET_DIRECTORY)) continue;
    await opfs.removeEntry(name, { recursive: true });
  }
}

async function writeFile(
  root: FileSystemDirectoryHandle,
  file: PerfFile,
): Promise<void> {
  const parts = file.path.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) return;
  let directory = root;
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  const handle = await directory.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file.text);
  await writable.close();
}
