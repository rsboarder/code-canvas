import {
  editor as monacoEditor,
  languages,
} from "monaco-editor/editor/editor.api.js";
import type { IGrammar, StateStack } from "vscode-textmate";

import { createTextMateRuntime, metadataForeground } from "./textmate";
import { monacoTokenName } from "./theme-rules";
import { monacoTheme } from "./theme";

class TextMateState implements languages.IState {
  constructor(readonly stack: StateStack | null) {}

  clone(): TextMateState {
    return new TextMateState(this.stack?.clone() ?? null);
  }

  equals(other: languages.IState): boolean {
    return (
      other instanceof TextMateState &&
      (this.stack === null
        ? other.stack === null
        : other.stack !== null && this.stack.equals(other.stack))
    );
  }
}

export async function configureMonacoTextMate(): Promise<
  readonly { dispose(): void }[]
> {
  const runtime = await createTextMateRuntime();
  monacoEditor.defineTheme("code-canvas-dark", monacoTheme);
  monacoEditor.setTheme("code-canvas-dark");
  languages.register({ id: "typescriptreact" });
  languages.register({ id: "typescript" });
  return [
    languages.setTokensProvider(
      "typescript",
      createTokensProvider(runtime.typescript),
    ),
    languages.setTokensProvider(
      "typescriptreact",
      createTokensProvider(runtime.tsx),
    ),
  ];
}

function createTokensProvider(grammar: IGrammar): languages.TokensProvider {
  return {
    getInitialState: () => new TextMateState(null),
    tokenize: (line, state) => {
      const previous = state instanceof TextMateState ? state.stack : null;
      const result = grammar.tokenizeLine2(line, previous);
      const tokens = [];
      for (let index = 0; index < result.tokens.length; index += 2) {
        const offset = result.tokens[index] ?? 0;
        const metadata = result.tokens[index + 1] ?? 0;
        tokens.push({
          startIndex: offset,
          scopes: monacoTokenName(metadataForeground(metadata)),
        });
      }
      return { endState: new TextMateState(result.ruleStack), tokens };
    },
  };
}
