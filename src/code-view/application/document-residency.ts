export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface TokenizedLines {
  readonly fileId: string;
  readonly contentVersion: number;
  readonly lineRange: LineRange;
  readonly runs: Uint32Array;
  readonly lineRunOffsets: Uint32Array;
  readonly palette: readonly string[];
  readonly minimap?: Uint8Array;
  readonly minimapHeight?: number;
}

export interface Tokenizer {
  contentChanged(fileId: string, contentVersion: number, text: string): void;
  wanted(fileId: string, lineRanges: readonly LineRange[]): void;
}

export interface GpuUploader {
  uploadFallback?(document: FallbackDocument): void;
  uploadTokens(document: TokenizedLines): void;
}

export interface FallbackDocument {
  readonly fileId: string;
  readonly contentVersion: number;
  readonly text: string;
}

interface DocumentState {
  fileId: string;
  version: number;
  text: string;
  visible: readonly LineRange[];
  pending: TokenizedLines[];
  fallbackPending: boolean;
  priority: boolean;
}

export class DocumentResidency {
  private readonly documents = new Map<string, DocumentState>();

  constructor(private readonly tokenizer: Tokenizer) {}

  contentChanged(fileId: string, contentVersion: number, text: string): void {
    const current = this.documents.get(fileId);
    if (current && contentVersion < current.version) {
      return;
    }
    this.documents.set(fileId, {
      fileId,
      version: contentVersion,
      text,
      visible: current?.visible ?? [],
      pending: [],
      fallbackPending: true,
      priority: current?.priority ?? false,
    });
    this.tokenizer.contentChanged(fileId, contentVersion, text);
  }

  visibleRangesChanged(
    ranges: ReadonlyMap<string, readonly LineRange[]>,
  ): void {
    for (const [fileId, visible] of ranges) {
      const document = this.documents.get(fileId);
      if (!document) continue;
      document.visible = visible;
      this.tokenizer.wanted(fileId, visible);
    }
  }

  prioritize(fileId: string): void {
    const document = this.documents.get(fileId);
    if (document) document.priority = true;
  }

  receiveTokens(document: TokenizedLines): boolean {
    const current = this.documents.get(document.fileId);
    if (current?.version !== document.contentVersion) {
      return false;
    }
    current.pending.push(document);
    return true;
  }

  drain(budgetMs: number, uploader: GpuUploader): number {
    const startedAt = performance.now();
    let uploaded = 0;
    const documents = [...this.documents.values()].sort(
      (left, right) => Number(right.priority) - Number(left.priority),
    );
    for (const document of documents) {
      document.priority = false;
      if (document.fallbackPending) {
        uploader.uploadFallback?.({
          fileId: document.fileId,
          contentVersion: document.version,
          text: document.text,
        });
        document.fallbackPending = false;
        uploaded += 1;
        if (performance.now() - startedAt >= budgetMs) return uploaded;
      }
      while (document.pending.length > 0) {
        const result = document.pending.shift();
        if (!result) break;
        if (result.contentVersion === document.version) {
          uploader.uploadTokens(result);
          uploaded += 1;
        }
        if (performance.now() - startedAt >= budgetMs) return uploaded;
      }
    }
    return uploaded;
  }
}
