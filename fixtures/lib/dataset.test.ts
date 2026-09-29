import { describe, expect, it } from "vitest";

import {
  EDGE_CASE_FILES,
  FILE_COUNT,
  LINE_COUNT,
  MAX_LINE_LENGTH,
  generateDataset,
  generateEdgeCaseCorpus,
  splitSourceLines,
} from "./dataset";

describe("Reference Dataset", () => {
  it("generates byte-identical files twice", () => {
    const first = generateDataset();
    const second = generateDataset();

    expect(first.files.map((file) => file.relativePath)).toEqual(
      second.files.map((file) => file.relativePath),
    );
    expect(first.files).toHaveLength(FILE_COUNT);
    first.files.forEach((file, index) => {
      expect(
        Buffer.compare(
          file.bytes,
          second.files[index]?.bytes ?? Buffer.alloc(0),
        ),
      ).toBe(0);
    });
  });

  it("declares the task 1.9 feature profile", () => {
    const dataset = generateDataset();
    const { profile } = dataset;

    expect(profile.fileCount).toBe(FILE_COUNT);
    expect(profile.linesPerFile).toBe(LINE_COUNT);
    expect(profile.fileKinds.ts).toBe(100);
    expect(profile.fileKinds.tsx).toBe(100);
    expect(profile.features.jsx.lineCount).toBeGreaterThanOrEqual(300);
    expect(profile.features.templateStrings.lineCount).toBeGreaterThanOrEqual(
      100,
    );
    expect(profile.features.multilineComments.lineCount).toBeGreaterThanOrEqual(
      20,
    );
    expect(profile.features.tabs.lineCount).toBeGreaterThanOrEqual(200);
    expect(profile.features.nonAscii.lineCount).toBeGreaterThanOrEqual(100);
    expect(profile.features.denseTokens.lineCount).toBeGreaterThan(0);
    expect(profile.lineLength.max).toBe(MAX_LINE_LENGTH);
    expect(profile.lineLength.atLeast200).toBeGreaterThanOrEqual(100);

    const independentLines = dataset.files.flatMap((file) =>
      splitSourceLines(file.text),
    );
    expect(independentLines).toHaveLength(FILE_COUNT * (LINE_COUNT + 1));
    expect(independentLines.some((line) => line.includes("\t"))).toBe(true);
    expect(
      independentLines.some((line) =>
        Array.from(line).some(
          (character) => (character.codePointAt(0) ?? 0) > 127,
        ),
      ),
    ).toBe(true);
    expect(independentLines.some((line) => line.length === 300)).toBe(true);
    expect(
      dataset.files.some((file) => file.relativePath.endsWith(".tsx")),
    ).toBe(true);
    expect(
      dataset.files.some((file) => file.relativePath.endsWith(".ts")),
    ).toBe(true);
  });
});

describe("Edge-case Corpus", () => {
  it("matches every declared property of every generated file", () => {
    const corpus = generateEdgeCaseCorpus();

    expect(corpus.files).toHaveLength(EDGE_CASE_FILES.length);
    corpus.files.forEach((file) => {
      const { expected } = file;
      const sourceLines = splitSourceLines(file.text);
      const linesWithoutBom = file.text.replace(/^\uFEFF/u, "");
      const longestLine = Math.max(
        0,
        ...sourceLines.map((line) => Array.from(line).length),
      );

      expect(sourceLines).toHaveLength(expected.lineCount);
      expect(sourceLines).toEqual(expected.lines);
      expect(file.bytes).toEqual(Buffer.from(file.text, "utf8"));
      expect(file.text.startsWith("\uFEFF")).toBe(expected.hasBom);
      expect(longestLine).toBe(expected.longestLineCodePoints);
      expect(/(?<!\r)\n/u.test(linesWithoutBom)).toBe(
        expected.lineEnding === "lf" || expected.lineEnding === "mixed",
      );
      expect(linesWithoutBom.includes("\r\n")).toBe(
        expected.lineEnding === "crlf" || expected.lineEnding === "mixed",
      );
      expect(/\r(?!\n)/u.test(linesWithoutBom)).toBe(
        expected.lineEnding === "cr" || expected.lineEnding === "mixed",
      );
      expect(sourceLines.some((line) => line.length === 0)).toBe(
        expected.hasBlankLine,
      );
      expect(
        sourceLines.some((line) => line.trim().length === 0 && line.length > 0),
      ).toBe(expected.hasWhitespaceOnlyLine);
      expect(sourceLines.some((line) => /\s$/u.test(line))).toBe(
        expected.hasTrailingWhitespace,
      );
      expect(file.text.endsWith("\n") || file.text.endsWith("\r")).toBe(
        expected.hasTrailingNewline,
      );
      expect(
        file.relativePath.endsWith(".ts") || file.relativePath.endsWith(".tsx"),
      ).toBe(true);
      expected.tabColumns.forEach((column) => {
        expect(sourceLines.some((line) => line[column] === "\t")).toBe(true);
      });
    });
  });
});
