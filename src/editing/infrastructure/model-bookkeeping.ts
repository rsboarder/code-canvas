export interface DisposableModel {
  dispose(): void;
}

export interface ModelEditor<Model extends DisposableModel> {
  setModel(model: Model | null): void;
}

export class ModelBookkeeping<Model extends DisposableModel> {
  private model: Model | undefined;

  constructor(private readonly editor: ModelEditor<Model>) {}

  get activeModel(): Model | undefined {
    return this.model;
  }

  replace(model: Model): void {
    this.editor.setModel(null);
    this.model?.dispose();
    this.model = model;
    this.editor.setModel(model);
  }

  withProbe(probe: Model, measure: () => void): void {
    this.editor.setModel(probe);
    try {
      measure();
    } finally {
      this.editor.setModel(this.model ?? null);
      probe.dispose();
    }
  }

  close(): void {
    this.editor.setModel(null);
    this.model?.dispose();
    this.model = undefined;
  }
}
