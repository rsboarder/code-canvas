declare module "monaco-editor/editor/standalone/common/themes.js" {
  export const vs_dark: {
    rules: { token: string; foreground?: string }[];
  };
}

declare module "monaco-editor/editor/editor.api.js" {
  export const editor: {
    createModel(value: string, language?: string, uri?: unknown): unknown;
    setTheme(themeName: string): void;
  };
  export const languages: {
    register(language: { id: string }): void;
    setMonarchTokensProvider(languageId: string, language: unknown): unknown;
  };
  export const Uri: {
    parse(value: string): unknown;
  };
}

declare module "monaco-editor/editor/common/encodedTokenAttributes.js" {
  export const TokenMetadata: {
    getForeground(metadata: number): number;
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

declare module "monaco-editor/editor/common/languages.js" {
  export const TokenizationRegistry: {
    getColorMap(): { toString(): string }[] | null;
  };
}

declare module "monaco-editor/editor/standalone/common/monarch/monarchCompile.js" {
  export function compile(languageId: string, language: unknown): unknown;
}

declare module "monaco-editor/editor/standalone/common/monarch/monarchLexer.js" {
  export interface MonarchToken {
    offset: number;
    type: string;
  }

  export interface MonarchTokenizationResult {
    tokens: MonarchToken[];
    endState: unknown;
  }

  export class MonarchTokenizer {
    constructor(
      languageService: unknown,
      standaloneThemeService: unknown,
      languageId: string,
      lexer: unknown,
      configurationService: unknown,
    );
    getInitialState(): unknown;
    tokenize(
      line: string,
      hasEOL: boolean,
      state: unknown,
    ): MonarchTokenizationResult;
  }
}

declare module "monaco-editor/languages/definitions/typescript/typescript.js" {
  export const language: unknown;
}
