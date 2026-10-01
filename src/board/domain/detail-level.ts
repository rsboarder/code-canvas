export type DetailLevelName = "text" | "minimap";

interface DetailLevelThresholds {
  readonly textToMinimap: number;
  readonly minimapToText: number;
}

export class DetailLevel {
  private _value: DetailLevelName = "text";

  constructor(
    private readonly thresholds: DetailLevelThresholds = {
      textToMinimap: 9,
      minimapToText: 11,
    },
  ) {}

  get value(): DetailLevelName {
    return this._value;
  }

  update(onScreenLineHeight: number): DetailLevelName {
    if (
      this._value === "text" &&
      onScreenLineHeight < this.thresholds.textToMinimap
    ) {
      this._value = "minimap";
    } else if (
      this._value === "minimap" &&
      onScreenLineHeight > this.thresholds.minimapToText
    ) {
      this._value = "text";
    }
    return this._value;
  }
}
