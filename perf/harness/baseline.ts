export interface BaselineFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
}

export interface BaselineUpdateOptions {
  readonly baselinePath: string;
  readonly report: string;
  readonly isTTY: boolean;
  readonly confirmation?: string;
  readonly fileSystem: BaselineFileSystem;
}

export interface BaselineUpdateResult {
  readonly exitCode: number;
  readonly changed: boolean;
}

export async function updateBaseline({
  baselinePath,
  report,
  isTTY,
  confirmation,
  fileSystem,
}: BaselineUpdateOptions): Promise<BaselineUpdateResult> {
  if (!isTTY || confirmation?.toLowerCase() !== "y") {
    return { exitCode: 1, changed: false };
  }
  const previous = await fileSystem.readFile(baselinePath).catch(() => "");
  await fileSystem.writeFile(baselinePath, report);
  return { exitCode: 0, changed: previous !== report };
}
