declare module "monaco-editor/editor/common/languages.js" {
  export const TokenizationRegistry: {
    getColorMap(): { toString(): string }[] | null;
  };
}

declare module "monaco-editor/editor/common/languages/supports/tokenization.js" {
  export class TokenTheme {
    static createFromRawTokenTheme(
      source: { token: string; foreground?: string }[],
      encodedTokensColors: string[],
    ): TokenTheme;
    _match(token: string): { metadata: number };
    getColorMap(): { toString(): string }[];
  }
}

declare module "monaco-editor/editor/standalone/common/themes.js" {
  export const vs_dark: {
    rules: { token: string; foreground?: string }[];
  };
}

declare module "monaco-editor/languages/definitions/typescript/typescript.js" {
  export const language: unknown;
}

declare module "monaco-editor/editor/editor.worker.js?worker" {
  export default class EditorWorker extends Worker {
    constructor();
  }
}
