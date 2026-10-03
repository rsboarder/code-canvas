import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { splitSourceLines } from "../../src/shared/domain";

export const FILE_COUNT = 200;
export const LINE_COUNT = 2000;
export const MAX_LINE_LENGTH = 300;

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
] as const;

type FileKind = "ts" | "tsx";
type Random = () => number;

interface GeneratedFile {
  readonly relativePath: string;
  readonly text: string;
  readonly bytes: Buffer;
}

interface FeatureCoverage {
  readonly fileCount: number;
  readonly lineCount: number;
  readonly occurrenceCount: number;
  readonly paths: readonly string[];
}

interface DatasetFeatureProfile {
  readonly fileCount: number;
  readonly linesPerFile: number;
  readonly fileKinds: Readonly<Record<FileKind, number>>;
  readonly features: {
    readonly jsx: FeatureCoverage;
    readonly templateStrings: FeatureCoverage;
    readonly multilineTemplates: FeatureCoverage;
    readonly multilineComments: FeatureCoverage;
    readonly tabs: FeatureCoverage;
    readonly nonAscii: FeatureCoverage;
    readonly denseTokens: FeatureCoverage;
  };
  readonly lineLength: {
    readonly minimum: number;
    readonly mean: number;
    readonly max: number;
    readonly atLeast200: number;
    readonly exactMax: number;
    readonly buckets: Readonly<Record<string, number>>;
  };
}

interface GeneratedDataset {
  readonly files: readonly GeneratedFile[];
  readonly profile: DatasetFeatureProfile;
}

type LineEnding = "none" | "lf" | "crlf" | "cr" | "mixed";

interface EdgeCaseExpected {
  readonly lineCount: number;
  readonly lines: readonly string[];
  readonly hasBom: boolean;
  readonly longestLineCodePoints: number;
  readonly lineEnding: LineEnding;
  readonly hasBlankLine: boolean;
  readonly hasWhitespaceOnlyLine: boolean;
  readonly hasTrailingWhitespace: boolean;
  readonly hasTrailingNewline: boolean;
  readonly tabColumns: readonly number[];
}

interface EdgeCaseFile extends GeneratedFile {
  readonly expected: EdgeCaseExpected;
}

interface EdgeCaseCorpus {
  readonly files: readonly EdgeCaseFile[];
}

interface LineFeatures {
  readonly jsx?: boolean;
  readonly templateString?: boolean;
  readonly multilineTemplate?: boolean;
  readonly multilineComment?: boolean;
  readonly tab?: boolean;
  readonly nonAscii?: boolean;
  readonly denseTokens?: boolean;
}

interface BuiltLine {
  readonly text: string;
  readonly features: LineFeatures;
}

interface BuiltDatasetFile {
  readonly file: GeneratedFile;
  readonly kind: FileKind;
  readonly lines: readonly BuiltLine[];
}

interface MutableFeatureCoverage {
  fileCount: number;
  lineCount: number;
  occurrenceCount: number;
  paths: string[];
}

interface MutableProfile {
  fileKinds: Record<FileKind, number>;
  features: Record<
    keyof DatasetFeatureProfile["features"],
    MutableFeatureCoverage
  >;
  lineLength: {
    minimum: number;
    total: number;
    count: number;
    max: number;
    atLeast200: number;
    exactMax: number;
    buckets: Record<string, number>;
  };
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
): BuiltLine {
  if (part === "start") {
    return {
      text: `/* fixture ${String(index)} block ${String(line)}: syntax and residency metadata`,
      features: { multilineComment: true },
    };
  }
  if (part === "middle") {
    return {
      text: ` * ${unicodeLabel(index, line)} keeps this multi-line comment dense and tokenizer-visible.`,
      features: { multilineComment: true, nonAscii: true },
    };
  }
  return { text: " */", features: { multilineComment: true } };
}

function templateLine(index: number, line: number, random: Random): BuiltLine {
  const first = choose(random, WORDS);
  const second = choose(random, WORDS);
  return {
    text: `\tconst ${first}Template${String(line)} = \`${first}-${second}-${String(index)}-\${fixtureId}: ${unicodeLabel(index, line)}\`;`,
    features: {
      templateString: true,
      tab: true,
      nonAscii: true,
      denseTokens: true,
    },
  };
}

function multilineTemplateLine(
  index: number,
  line: number,
  part: "start" | "body" | "end",
): BuiltLine {
  if (part === "start") {
    return {
      text: `const multilineTemplate${String(line)} = \``,
      features: { templateString: true, multilineTemplate: true },
    };
  }
  if (part === "body") {
    return {
      text: `\t  ${unicodeLabel(index, line)} / value=\${fixtureId} / line=${String(line)}`,
      features: {
        templateString: true,
        multilineTemplate: true,
        tab: true,
        nonAscii: true,
        denseTokens: true,
      },
    };
  }
  return {
    text: "  `;",
    features: { templateString: true, multilineTemplate: true },
  };
}

function jsxLine(index: number, line: number, random: Random): BuiltLine {
  const word = choose(random, WORDS);
  return {
    text: `const ${word}Element${String(line)} = <article data-id={${String(line)}} data-file={fixtureId} aria-label={sourceLabel}><span className="${word}">{unicodeText}</span><strong>{${String(line)} + ${String(index)}}</strong></article>;`,
    features: { jsx: true, denseTokens: true },
  };
}

function tsLine(index: number, line: number, random: Random): BuiltLine {
  const first = choose(random, WORDS);
  const second = choose(random, WORDS);
  const number = Math.floor(random() * 10000);
  return {
    text: `const ${first}Record${String(line)}: Record<string, number> = { ${second}: ${String(number)}, ${first}: ${String(line)}, id: ${String(index)} }; // ${unicodeLabel(index, line)}`,
    features: { nonAscii: true, denseTokens: true },
  };
}

function regularLine(
  index: number,
  line: number,
  kind: FileKind,
  random: Random,
): BuiltLine {
  return kind === "tsx"
    ? jsxLine(index, line, random)
    : tsLine(index, line, random);
}

function buildLine(
  index: number,
  line: number,
  kind: FileKind,
  random: Random,
): BuiltLine {
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
    return {
      text: maxWidthLine(`${sourceLine.text} // width=${String(line)} `),
      features: { ...sourceLine.features },
    };
  }
  if (line % 5 === 0) {
    return {
      text: `\t${sourceLine.text}`,
      features: { ...sourceLine.features, tab: true },
    };
  }
  return sourceLine;
}

function buildLines(index: number, kind: FileKind): readonly BuiltLine[] {
  const seed = 0x41c64e6d ^ Math.imul(index + 1, 0x9e3779b9);
  const random = createRandom(seed);
  return Array.from({ length: LINE_COUNT }, (_, line) =>
    buildLine(index, line, kind, random),
  );
}

function buildDatasetFile(index: number): BuiltDatasetFile {
  const kind: FileKind = index % 2 === 0 ? "tsx" : "ts";
  const relativePath = filePath(index, kind);
  const lines = buildLines(index, kind);
  if (lines.length !== LINE_COUNT) {
    throw new Error(
      `${relativePath} has ${String(lines.length)} lines, expected ${String(LINE_COUNT)}`,
    );
  }
  if (lines.some((line) => line.text.length > MAX_LINE_LENGTH)) {
    throw new Error(
      `${relativePath} contains a line longer than ${String(MAX_LINE_LENGTH)} characters`,
    );
  }
  const text = `${lines.map((line) => line.text).join("\n")}\n`;
  const sourceLines = splitSourceLines(text);
  if (
    sourceLines.length !== LINE_COUNT + 1 ||
    sourceLines[sourceLines.length - 1] !== ""
  ) {
    throw new Error(
      `${relativePath} has ${String(LINE_COUNT)} lines of content plus a final empty line after the trailing newline`,
    );
  }
  return {
    kind,
    lines,
    file: { relativePath, text, bytes: Buffer.from(text) },
  };
}

function createCoverage(): MutableFeatureCoverage {
  return { fileCount: 0, lineCount: 0, occurrenceCount: 0, paths: [] };
}

function createMutableProfile(): MutableProfile {
  return {
    fileKinds: { ts: 0, tsx: 0 },
    features: {
      jsx: createCoverage(),
      templateStrings: createCoverage(),
      multilineTemplates: createCoverage(),
      multilineComments: createCoverage(),
      tabs: createCoverage(),
      nonAscii: createCoverage(),
      denseTokens: createCoverage(),
    },
    lineLength: {
      minimum: Number.POSITIVE_INFINITY,
      total: 0,
      count: 0,
      max: 0,
      atLeast200: 0,
      exactMax: 0,
      buckets: { "0-99": 0, "100-199": 0, "200-299": 0, "300": 0 },
    },
  };
}

function featureNames(): readonly (keyof DatasetFeatureProfile["features"])[] {
  return [
    "jsx",
    "templateStrings",
    "multilineTemplates",
    "multilineComments",
    "tabs",
    "nonAscii",
    "denseTokens",
  ];
}

function featureMatches(
  feature: keyof DatasetFeatureProfile["features"],
  line: LineFeatures,
): boolean {
  if (feature === "jsx") return line.jsx === true;
  if (feature === "templateStrings") return line.templateString === true;
  if (feature === "multilineTemplates") return line.multilineTemplate === true;
  if (feature === "multilineComments") return line.multilineComment === true;
  if (feature === "tabs") return line.tab === true;
  if (feature === "nonAscii") return line.nonAscii === true;
  return line.denseTokens === true;
}

function recordFeature(
  profile: MutableProfile,
  feature: keyof DatasetFeatureProfile["features"],
  path: string,
  lines: readonly BuiltLine[],
): void {
  const coverage = profile.features[feature];
  const lineCount = lines.filter((line) =>
    featureMatches(feature, line.features),
  ).length;
  if (lineCount === 0) return;
  coverage.fileCount += 1;
  coverage.lineCount += lineCount;
  coverage.occurrenceCount +=
    feature === "multilineComments" ? lineCount / 3 : lineCount;
  coverage.paths.push(path);
}

function recordFile(
  profile: MutableProfile,
  builtFile: BuiltDatasetFile,
): void {
  const { file, kind, lines } = builtFile;
  profile.fileKinds[kind] += 1;
  featureNames().forEach((feature) => {
    recordFeature(profile, feature, file.relativePath, lines);
  });
  lines.forEach((line) => {
    const length = line.text.length;
    profile.lineLength.minimum = Math.min(profile.lineLength.minimum, length);
    profile.lineLength.total += length;
    profile.lineLength.count += 1;
    profile.lineLength.max = Math.max(profile.lineLength.max, length);
    if (length >= 200) profile.lineLength.atLeast200 += 1;
    if (length === MAX_LINE_LENGTH) profile.lineLength.exactMax += 1;
    const bucket =
      length === 300
        ? "300"
        : length >= 200
          ? "200-299"
          : length >= 100
            ? "100-199"
            : "0-99";
    profile.lineLength.buckets[bucket] =
      (profile.lineLength.buckets[bucket] ?? 0) + 1;
  });
}

function finalizeCoverage(coverage: MutableFeatureCoverage): FeatureCoverage {
  return { ...coverage, paths: [...coverage.paths] };
}

function finalizeProfile(profile: MutableProfile): DatasetFeatureProfile {
  return {
    fileCount: FILE_COUNT,
    linesPerFile: LINE_COUNT,
    fileKinds: { ...profile.fileKinds },
    features: {
      jsx: finalizeCoverage(profile.features.jsx),
      templateStrings: finalizeCoverage(profile.features.templateStrings),
      multilineTemplates: finalizeCoverage(profile.features.multilineTemplates),
      multilineComments: finalizeCoverage(profile.features.multilineComments),
      tabs: finalizeCoverage(profile.features.tabs),
      nonAscii: finalizeCoverage(profile.features.nonAscii),
      denseTokens: finalizeCoverage(profile.features.denseTokens),
    },
    lineLength: {
      minimum: profile.lineLength.minimum,
      mean: profile.lineLength.total / profile.lineLength.count,
      max: profile.lineLength.max,
      atLeast200: profile.lineLength.atLeast200,
      exactMax: profile.lineLength.exactMax,
      buckets: { ...profile.lineLength.buckets },
    },
  };
}

export function generateDataset(): GeneratedDataset {
  const profile = createMutableProfile();
  const files = Array.from({ length: FILE_COUNT }, (_, index) => {
    const builtFile = buildDatasetFile(index);
    recordFile(profile, builtFile);
    return builtFile.file;
  });
  return { files, profile: finalizeProfile(profile) };
}

function edgeCaseFile(
  relativePath: string,
  text: string,
  expected: EdgeCaseExpected,
): EdgeCaseFile {
  return { relativePath, text, bytes: Buffer.from(text, "utf8"), expected };
}

const LONG_LINE = `const long = "${"x".repeat(301)}";`;
const TAB_LINES = Array.from(
  { length: 8 },
  (_, column) =>
    `${" ".repeat(column)}\tconst tab${String(column)} = <span />;`,
).join("\n");

export const EDGE_CASE_FILES: readonly EdgeCaseFile[] = [
  edgeCaseFile("line-endings-lf.ts", "const lf = 1;\nconst next = 2;", {
    lineCount: 2,
    lines: ["const lf = 1;", "const next = 2;"],
    hasBom: false,
    longestLineCodePoints: 15,
    lineEnding: "lf",
    hasBlankLine: false,
    hasWhitespaceOnlyLine: false,
    hasTrailingWhitespace: false,
    hasTrailingNewline: false,
    tabColumns: [],
  }),
  edgeCaseFile(
    "line-endings-crlf.tsx",
    "const crlf = <span />;\r\n\r\nconst done = true;\r\n",
    {
      lineCount: 4,
      lines: ["const crlf = <span />;", "", "const done = true;", ""],
      hasBom: false,
      longestLineCodePoints: 22,
      lineEnding: "crlf",
      hasBlankLine: true,
      hasWhitespaceOnlyLine: false,
      hasTrailingWhitespace: false,
      hasTrailingNewline: true,
      tabColumns: [],
    },
  ),
  edgeCaseFile("line-endings-cr.ts", "const cr = 1;\rconst second = 2;\r", {
    lineCount: 3,
    lines: ["const cr = 1;", "const second = 2;", ""],
    hasBom: false,
    longestLineCodePoints: 17,
    lineEnding: "cr",
    hasBlankLine: true,
    hasWhitespaceOnlyLine: false,
    hasTrailingWhitespace: false,
    hasTrailingNewline: true,
    tabColumns: [],
  }),
  edgeCaseFile(
    "line-endings-mixed.ts",
    "const mixed = 1;\n\r\nconst third = 3\rconst fourth = 4\n",
    {
      lineCount: 5,
      lines: [
        "const mixed = 1;",
        "",
        "const third = 3",
        "const fourth = 4",
        "",
      ],
      hasBom: false,
      longestLineCodePoints: 16,
      lineEnding: "mixed",
      hasBlankLine: true,
      hasWhitespaceOnlyLine: false,
      hasTrailingWhitespace: false,
      hasTrailingNewline: true,
      tabColumns: [],
    },
  ),
  edgeCaseFile(
    "bom-and-blanks.ts",
    "\uFEFFconst bom = true;\n\n   \nconst value = 2;  \n",
    {
      lineCount: 5,
      lines: ["const bom = true;", "", "   ", "const value = 2;  ", ""],
      hasBom: true,
      longestLineCodePoints: 18,
      lineEnding: "lf",
      hasBlankLine: true,
      hasWhitespaceOnlyLine: true,
      hasTrailingWhitespace: true,
      hasTrailingNewline: true,
      tabColumns: [],
    },
  ),
  edgeCaseFile("empty.ts", "", {
    lineCount: 1,
    lines: [""],
    hasBom: false,
    longestLineCodePoints: 0,
    lineEnding: "none",
    hasBlankLine: true,
    hasWhitespaceOnlyLine: false,
    hasTrailingWhitespace: false,
    hasTrailingNewline: false,
    tabColumns: [],
  }),
  edgeCaseFile("bom-only.ts", "\uFEFF", {
    lineCount: 1,
    lines: [""],
    hasBom: true,
    longestLineCodePoints: 0,
    lineEnding: "none",
    hasBlankLine: true,
    hasWhitespaceOnlyLine: false,
    hasTrailingWhitespace: false,
    hasTrailingNewline: false,
    tabColumns: [],
  }),
  edgeCaseFile("single-newline.ts", "\n", {
    lineCount: 2,
    lines: ["", ""],
    hasBom: false,
    longestLineCodePoints: 0,
    lineEnding: "lf",
    hasBlankLine: true,
    hasWhitespaceOnlyLine: false,
    hasTrailingWhitespace: false,
    hasTrailingNewline: true,
    tabColumns: [],
  }),
  edgeCaseFile(
    "long-and-wide.ts",
    `const wide = "漢字😀‍👩‍💻e\u0301";\n${LONG_LINE}\n`,
    {
      lineCount: 3,
      lines: [`const wide = "漢字😀‍👩‍💻e\u0301";`, LONG_LINE, ""],
      hasBom: false,
      longestLineCodePoints: 317,
      lineEnding: "lf",
      hasBlankLine: true,
      hasWhitespaceOnlyLine: false,
      hasTrailingWhitespace: false,
      hasTrailingNewline: true,
      tabColumns: [],
    },
  ),
  edgeCaseFile("tabs-at-columns.tsx", `${TAB_LINES}\n`, {
    lineCount: 9,
    lines: [...TAB_LINES.split("\n"), ""],
    hasBom: false,
    longestLineCodePoints: 30,
    lineEnding: "lf",
    hasBlankLine: true,
    hasWhitespaceOnlyLine: false,
    hasTrailingWhitespace: false,
    hasTrailingNewline: true,
    tabColumns: [0, 1, 2, 3, 4, 5, 6, 7],
  }),
  edgeCaseFile(
    "tabs-after-wide.ts",
    `function wide() {
  const cjk = "界\tx";
  const emoji = "😀\tx";
  return [cjk, emoji];
}
`,
    {
      lineCount: 6,
      lines: [
        "function wide() {",
        '  const cjk = "界\tx";',
        '  const emoji = "😀\tx";',
        "  return [cjk, emoji];",
        "}",
        "",
      ],
      hasBom: false,
      longestLineCodePoints: 22,
      lineEnding: "lf",
      hasBlankLine: true,
      hasWhitespaceOnlyLine: false,
      hasTrailingWhitespace: false,
      hasTrailingNewline: true,
      tabColumns: [16, 19],
    },
  ),
];

export function generateEdgeCaseCorpus(): EdgeCaseCorpus {
  return {
    files: EDGE_CASE_FILES.map((file) => ({
      ...file,
      bytes: Buffer.from(file.text, "utf8"),
    })),
  };
}

async function writeFiles(
  outputDir: string,
  files: readonly GeneratedFile[],
): Promise<void> {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await Promise.all(
    files.map(async (file) => {
      const outputPath = join(outputDir, file.relativePath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, file.bytes);
    }),
  );
}

export async function writeDataset(
  outputDir: string,
  dataset: GeneratedDataset = generateDataset(),
): Promise<void> {
  await writeFiles(outputDir, dataset.files);
}

export async function writeEdgeCaseCorpus(
  outputDir: string,
  corpus: EdgeCaseCorpus = generateEdgeCaseCorpus(),
): Promise<void> {
  await writeFiles(outputDir, corpus.files);
}
