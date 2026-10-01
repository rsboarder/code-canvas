import { describe, expect, it } from "vitest";

import {
  ModelBookkeeping,
  type DisposableModel,
  type ModelEditor,
} from "../editing/infrastructure/model-bookkeeping";

class FakeModel implements DisposableModel {
  disposed = false;

  dispose(): void {
    this.disposed = true;
  }
}

class FakeMonacoEditor implements ModelEditor<FakeModel> {
  model: FakeModel | null = null;
  readonly attachedModels: (FakeModel | null)[] = [];
  readonly disposedAtAttachment: boolean[] = [];

  setModel(model: FakeModel | null): void {
    if (model?.disposed) throw new Error("disposed model attached");
    this.model = model;
    this.attachedModels.push(model);
    this.disposedAtAttachment.push(model?.disposed ?? false);
  }
}

describe("Monaco model bookkeeping", () => {
  it("never reattaches a disposed model across the host lifecycle", () => {
    const editor = new FakeMonacoEditor();
    const bookkeeping = new ModelBookkeeping(editor);
    const createModel = () => new FakeModel();

    expect(editor.model).toBeNull();
    bookkeeping.withProbe(createModel(), () => undefined);
    bookkeeping.replace(createModel());
    bookkeeping.close();
    bookkeeping.withProbe(createModel(), () => undefined);

    expect(editor.model).toBeNull();
    expect(editor.disposedAtAttachment).toEqual(
      editor.disposedAtAttachment.map(() => false),
    );
  });
});
