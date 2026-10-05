export const MIN_LINE_NUMBER_DIGITS = 4;
export const LINE_NUMBER_GAP_CSS = 8;

export class LineNumberGutter {
  constructor(private readonly digitAdvance: number) {}

  numberAreaWidth(lineCount: number): number {
    return Math.round(this.digitCount(lineCount) * this.digitAdvance);
  }

  codeLeft(lineCount: number): number {
    return this.numberAreaWidth(lineCount) + LINE_NUMBER_GAP_CSS;
  }

  codeX(lineCount: number, bodyX: number): number {
    return bodyX - this.codeLeft(lineCount);
  }

  private digitCount(lineCount: number): number {
    let value = Math.max(1, Math.floor(lineCount));
    let digits = 1;
    while (value >= 10) {
      value = Math.floor(value / 10);
      digits += 1;
    }
    return Math.max(MIN_LINE_NUMBER_DIGITS, digits);
  }
}
