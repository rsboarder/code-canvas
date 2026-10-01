export interface FontDefinition {
  readonly family: string;
  readonly size: number;
  readonly rasterScale: number;
  readonly lineHeight: number;
  readonly bodyTop: number;
  readonly tabSize: number;
  readonly fontFeatureSettings: string;
  readonly letterSpacing: number;
}

export const DEFAULT_CODE_FONT: FontDefinition = {
  family: "Menlo, Monaco, monospace",
  size: 16,
  rasterScale: typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  lineHeight: 20,
  bodyTop: 42,
  tabSize: 4,
  fontFeatureSettings: '"liga" 0, "calt" 0',
  letterSpacing: 0,
};
