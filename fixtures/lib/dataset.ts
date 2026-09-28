import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export const FILE_COUNT = 200;
export const LINE_COUNT = 2000;
export const MAX_LINE_LENGTH = 300;
export const MIN_TAB_LINES = 200;
export const MIN_COMMENT_BLOCKS = 20;
export const MIN_TEMPLATE_LINES = 100;
export const MIN_MULTILINE_TEMPLATES = 10;
export const MIN_NON_ASCII_LINES = 100;
export const MIN_LONG_LINES = 100;
export const MIN_JSX_LINES = 300;
export const MIN_MEAN_LINE_LENGTH = 80;

const WORDS = [
  "anchor",
  "branch",
  "cursor",
  "delta",
  "glyph",
  "layout",
  "margin",
  "offset",
  "palette",
  "range",
  "stride",
  "token",
  "widget",
];

type FileKind = "ts" | "tsx";
type Random = () => number;

export interface DatasetFile {
  contents: string;
  relativePath: string;
}

function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function choose(random: Random, values: readonly string[]): string {
  const value = values[Math.floor(random() * values.length)];
  return value ?? values[0] ?? "value";
}

function filePath(index: number, kind: FileKind): string {
  const group = String(index % 10).padStart(2, "0");
  return join(
    `group-${group}`,
    `widget-${String(index).padStart(3, "0")}.${kind}`,
  );
}

function unicodeLabel(index: number, line: number): string {
  return `Привет-${String(index)}-${String(line)} 東京-${String(line)} 🧭`;
}

function maxWidthLine(prefix: string): string {
  if (prefix.length > MAX_LINE_LENGTH) {
    throw new Error(
      `Cannot pad a ${String(prefix.length)}-character line to ${String(MAX_LINE_LENGTH)}`,
    );
  }
  return `${prefix}${"x".repeat(MAX_LINE_LENGTH - prefix.length)}`;
}

function commentLine(
  index: number,
  line: number,
  part: "start" | "middle" | "end",
): string {
  if (part === "start") {
    return `/* fixture ${String(index)} block ${String(line)}: syntax and residency metadata`;
  }
  if (part === "middle") {
    return ` * ${unicodeLabel(index, line)} keeps this multi-line comment dense and tokenizer-visible.`;
  }
  return " */";
}

function templateLine(index: number, line: number, random: Random): string {
  const first = choose(random, WORDS);
  const second = choose(random, WORDS);
  return `\tconst ${first}Template${String(line)} = \`${first}-${second}-${String(index)}-\${fixtureId}: ${unicodeLabel(index, line)}\`;`;
}

function multilineTemplateLine(
  index: number,
  line: number,
  part: "start" | "body" | "end",
): string {
  if (part === "start") {
    return `const multilineTemplate${String(line)} = \``;
  }
  if (part === "body") {
    return `\t  ${unicodeLabel(index, line)} / value=\${fixtureId} / line=${String(line)}`;
  }
  return "  `;";
}

function jsxLine(index: number, line: number, random: Random): string {
  const word = choose(random, WORDS);
  return `const ${word}Element${String(line)} = <article data-id={${String(line)}} data-file={fixtureId} aria-label={sourceLabel}><span className="${word}">{unicodeText}</span><strong>{${String(line)} + ${String(index)}}</strong></article>;`;
}

function tsLine(index: number, line: number, random: Random): string {
  const first = choose(random, WORDS);
  const second = choose(random, WORDS);
  const number = Math.floor(random() * 10000);
  return `const ${first}Record${String(line)}: Record<string, number> = { ${second}: ${String(number)}, ${first}: ${String(line)}, id: ${String(index)} }; // ${unicodeLabel(index, line)}`;
}

function regularLine(
  index: number,
  line: number,
  kind: FileKind,
  random: Random,
): string {
  return kind === "tsx"
    ? jsxLine(index, line, random)
    : tsLine(index, line, random);
}

function buildLine(
  index: number,
  line: number,
  kind: FileKind,
  random: Random,
): string {
  if (line % 80 === 0) {
    return commentLine(index, line, "start");
  }
  if (line % 80 === 1) {
    return commentLine(index, line, "middle");
  }
  if (line % 80 === 2) {
    return commentLine(index, line, "end");
  }
  if (line % 160 === 20) {
    return multilineTemplateLine(index, line, "start");
  }
  if (line % 160 === 21) {
    return multilineTemplateLine(index, line, "body");
  }
  if (line % 160 === 22) {
    return multilineTemplateLine(index, line, "end");
  }
  if (line % 4 === 1) {
    return templateLine(index, line, random);
  }
  const sourceLine = regularLine(index, line, kind, random);
  if (line % 10 === 0) {
    return maxWidthLine(`${sourceLine} // width=${String(line)} `);
  }
  return line % 5 === 0 ? `\t${sourceLine}` : sourceLine;
}

function buildLines(index: number, kind: FileKind): string[] {
  const seed = 0x41c64e6d ^ Math.imul(index + 1, 0x9e3779b9);
  const random = createRandom(seed);
  return Array.from({ length: LINE_COUNT }, (_, line) =>
    buildLine(index, line, kind, random),
  );
}

export function buildDatasetFile(index: number): DatasetFile {
  const kind: FileKind = index % 2 === 0 ? "tsx" : "ts";
  const relativePath = filePath(index, kind);
  const lines = buildLines(index, kind);
  if (lines.length !== LINE_COUNT) {
    throw new Error(
      `${relativePath} has ${String(lines.length)} lines, expected ${String(LINE_COUNT)}`,
    );
  }
  if (lines.some((line) => line.length > MAX_LINE_LENGTH)) {
    throw new Error(
      `${relativePath} contains a line longer than ${String(MAX_LINE_LENGTH)} characters`,
    );
  }
  return { relativePath, contents: `${lines.join("\n")}\n` };
}

export async function generateDataset(outputDir: string): Promise<void> {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const files = Array.from({ length: FILE_COUNT }, (_, index) =>
    buildDatasetFile(index),
  );
  const directories = new Set(
    files.map((file) => dirname(join(outputDir, file.relativePath))),
  );
  await Promise.all(
    [...directories].map((directory) => mkdir(directory, { recursive: true })),
  );
  await Promise.all(
    files.map((file) =>
      writeFile(join(outputDir, file.relativePath), file.contents, "utf8"),
    ),
  );
}

async function collectDatasetFiles(
  rootDir: string,
  currentDir: string,
): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDatasetFiles(rootDir, entryPath)));
      continue;
    }
    files.push(relative(rootDir, entryPath));
  }
  return files.sort();
}

export async function listDatasetFiles(rootDir: string): Promise<string[]> {
  return collectDatasetFiles(rootDir, rootDir);
}

export async function readDatasetFile(
  rootDir: string,
  relativePath: string,
): Promise<Buffer> {
  return readFile(join(rootDir, relativePath));
}
