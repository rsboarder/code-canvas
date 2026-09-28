import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FILE_COUNT,
  LINE_COUNT,
  MAX_LINE_LENGTH,
  MIN_COMMENT_BLOCKS,
  MIN_JSX_LINES,
  MIN_LONG_LINES,
  MIN_MEAN_LINE_LENGTH,
  MIN_MULTILINE_TEMPLATES,
  MIN_NON_ASCII_LINES,
  MIN_TAB_LINES,
  MIN_TEMPLATE_LINES,
  generateDataset,
  listDatasetFiles,
  readDatasetFile,
} from "./lib/dataset";

const fixturesDir = join(process.cwd(), "fixtures");
const outputDir = join(fixturesDir, "reference-dataset");
const SPREAD_BUCKETS = 10;

interface CommentMetrics {
  blockStarts: number[];
  shortBlocks: number;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertMinimum(
  relativePath: string,
  metric: string,
  actual: number,
  minimum: number,
): void {
  assert(
    actual >= minimum,
    `${relativePath}: ${metric} ${String(actual)} < ${String(minimum)}`,
  );
}

function commentMetrics(lines: string[]): CommentMetrics {
  const blockStarts: number[] = [];
  let shortBlocks = 0;
  for (let line = 0; line < lines.length; line += 1) {
    if (!lines[line]?.startsWith("/*")) {
      continue;
    }
    const start = line;
    while (line < lines.length && !lines[line]?.includes("*/")) {
      line += 1;
    }
    blockStarts.push(start);
    if (line - start + 1 < 3) {
      shortBlocks += 1;
    }
  }
  return { blockStarts, shortBlocks };
}

function hasNonAscii(line: string): boolean {
  return Array.from(line).some(
    (character) => (character.codePointAt(0) ?? 0) > 127,
  );
}

function assertSpread(
  relativePath: string,
  lines: string[],
  metric: string,
  predicate: (line: string) => boolean,
): void {
  const bucketSize = LINE_COUNT / SPREAD_BUCKETS;
  for (let bucket = 0; bucket < SPREAD_BUCKETS; bucket += 1) {
    const start = bucket * bucketSize;
    const end = start + bucketSize;
    const found = lines.slice(start, end).some(predicate);
    assert(
      found,
      `${relativePath}: ${metric} missing from spread bucket ${String(bucket + 1)}`,
    );
  }
}

function assertUnicodeMix(relativePath: string, contents: string): void {
  assert(
    /[\u0400-\u04ff]/u.test(contents),
    `${relativePath}: missing Cyrillic text`,
  );
  assert(
    /[\u4e00-\u9fff]/u.test(contents),
    `${relativePath}: missing CJK text`,
  );
  assert(
    /[\u{1f300}-\u{1faff}]/u.test(contents),
    `${relativePath}: missing emoji`,
  );
}

function assertLineFeatures(
  relativePath: string,
  contents: string,
  lines: string[],
): void {
  const lengths = lines.map((line) => line.length);
  const comments = commentMetrics(lines);
  const tabLines = lines.filter((line) => line.startsWith("\t")).length;
  const templateLines = lines.filter(
    (line) => line.includes("`") && line.includes("${"),
  ).length;
  const multilineTemplates = lines.filter(
    (line) => line.includes(" = `") && line.includes("multilineTemplate"),
  ).length;
  const nonAsciiLines = lines.filter(hasNonAscii).length;
  const longLines = lines.filter(
    (line) => line.length >= 200 && line.length <= MAX_LINE_LENGTH,
  ).length;
  const exactMaxLines = lines.filter(
    (line) => line.length === MAX_LINE_LENGTH,
  ).length;
  const meanLength =
    lengths.reduce((total, length) => total + length, 0) / lines.length;

  assert(
    lines.length === LINE_COUNT,
    `${relativePath}: lines ${String(lines.length)} !== ${String(LINE_COUNT)}`,
  );
  assert(
    lengths.every((length) => length <= MAX_LINE_LENGTH),
    `${relativePath}: line exceeds ${String(MAX_LINE_LENGTH)}`,
  );
  assert(
    lengths.every((length) => length > 0),
    `${relativePath}: empty line found`,
  );
  assertMinimum(relativePath, "tab-indented lines", tabLines, MIN_TAB_LINES);
  assertMinimum(
    relativePath,
    "multi-line comment blocks",
    comments.blockStarts.length,
    MIN_COMMENT_BLOCKS,
  );
  assert(
    comments.shortBlocks === 0,
    `${relativePath}: comment block shorter than 3 lines`,
  );
  assertMinimum(
    relativePath,
    "template lines with ${}",
    templateLines,
    MIN_TEMPLATE_LINES,
  );
  assertMinimum(
    relativePath,
    "multi-line template strings",
    multilineTemplates,
    MIN_MULTILINE_TEMPLATES,
  );
  assertMinimum(
    relativePath,
    "non-ASCII lines",
    nonAsciiLines,
    MIN_NON_ASCII_LINES,
  );
  assertMinimum(
    relativePath,
    "lines from 200 to 300 characters",
    longLines,
    MIN_LONG_LINES,
  );
  assertMinimum(relativePath, "exactly-300-character lines", exactMaxLines, 3);
  assert(
    meanLength >= MIN_MEAN_LINE_LENGTH,
    `${relativePath}: mean line length ${String(meanLength)} < ${String(MIN_MEAN_LINE_LENGTH)}`,
  );
  assertUnicodeMix(relativePath, contents);
}

function checkFeatures(contents: string, relativePath: string): void {
  const lines = contents.endsWith("\n")
    ? contents.slice(0, -1).split("\n")
    : contents.split("\n");
  assertLineFeatures(relativePath, contents, lines);

  assertSpread(relativePath, lines, "tab-indented lines", (line) =>
    line.startsWith("\t"),
  );
  assertSpread(relativePath, lines, "comment blocks", (line) =>
    line.startsWith("/*"),
  );
  assertSpread(relativePath, lines, "template lines", (line) =>
    line.includes("${"),
  );
  assertSpread(relativePath, lines, "non-ASCII lines", hasNonAscii);
  assertSpread(relativePath, lines, "long lines", (line) => line.length >= 200);
  if (relativePath.endsWith(".tsx")) {
    const jsxLines = lines.filter(
      (line) =>
        line.includes("<article ") &&
        line.includes("<span ") &&
        line.includes("<strong>") &&
        line.includes("{"),
    ).length;
    assertMinimum(relativePath, "nested JSX lines", jsxLines, MIN_JSX_LINES);
    assertSpread(
      relativePath,
      lines,
      "nested JSX lines",
      (line) => line.includes("<article ") && line.includes("<span "),
    );
  }
}

async function verifyDataset(rootDir: string): Promise<void> {
  const files = await listDatasetFiles(rootDir);
  assert(
    files.length === FILE_COUNT,
    `expected ${String(FILE_COUNT)} files, found ${String(files.length)}`,
  );
  assert(
    files.some((file) => file.endsWith(".ts")),
    "dataset has no .ts files",
  );
  assert(
    files.some((file) => file.endsWith(".tsx")),
    "dataset has no .tsx files",
  );
  for (const relativePath of files) {
    const contents = (await readDatasetFile(rootDir, relativePath)).toString(
      "utf8",
    );
    checkFeatures(contents, relativePath);
  }
}

async function compareDatasets(
  firstDir: string,
  secondDir: string,
): Promise<void> {
  const firstFiles = await listDatasetFiles(firstDir);
  const secondFiles = await listDatasetFiles(secondDir);
  assert(
    firstFiles.join("\n") === secondFiles.join("\n"),
    "generated file lists differ",
  );
  for (const relativePath of firstFiles) {
    const first = await readDatasetFile(firstDir, relativePath);
    const second = await readDatasetFile(secondDir, relativePath);
    assert(first.equals(second), `generated bytes differ for ${relativePath}`);
  }
}

async function main(): Promise<void> {
  await verifyDataset(outputDir);
  const firstDir = await mkdtemp(join(tmpdir(), "reference-dataset-a-"));
  const secondDir = await mkdtemp(join(tmpdir(), "reference-dataset-b-"));
  try {
    await generateDataset(firstDir);
    await generateDataset(secondDir);
    await verifyDataset(firstDir);
    await verifyDataset(secondDir);
    await compareDatasets(firstDir, secondDir);
  } finally {
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log(
    `verified ${String(FILE_COUNT)} deterministic files of ${String(LINE_COUNT)} lines`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
