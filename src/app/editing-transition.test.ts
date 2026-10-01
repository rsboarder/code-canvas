import { describe, expect, it } from "vitest";

import { registerEditingTransitionTests } from "../editing/application/editing-transition-test-cases";
import { FakeEditorHost } from "../editing/infrastructure/fake-editor-host";

describe("EditingTransition", () => {
  registerEditingTransitionTests(
    (name, callback) => {
      it(name, callback);
    },
    {
      equal: (actual, expected) => {
        expect(actual).toEqual(expected);
      },
      match: (actual, expected) => {
        expect(actual).toMatchObject(expected as object);
      },
      true: (actual) => {
        expect(actual).toBe(true);
      },
    },
    () => new FakeEditorHost(),
  );
});
