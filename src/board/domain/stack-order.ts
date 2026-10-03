import type { SourceFileId } from "../../shared/domain";

export class StackOrder {
  private readonly ids: SourceFileId[] = [];

  get size(): number {
    return this.ids.length;
  }

  add(id: SourceFileId): void {
    if (this.indexOf(id) !== -1) {
      throw new RangeError("Stack Order cannot contain duplicate ids.");
    }
    this.ids.push(id);
  }

  remove(id: SourceFileId): void {
    const index = this.indexOf(id);
    if (index === -1) return;
    for (let current = index; current < this.ids.length - 1; current += 1) {
      const next = this.ids[current + 1];
      if (next === undefined) break;
      this.ids[current] = next;
    }
    this.ids.pop();
  }

  bringToFront(id: SourceFileId): void {
    const index = this.indexOf(id);
    if (index === -1) {
      throw new RangeError("Cannot bring an unknown id to the front.");
    }
    for (let current = index; current < this.ids.length - 1; current += 1) {
      const next = this.ids[current + 1];
      if (next === undefined) break;
      this.ids[current] = next;
    }
    this.ids[this.ids.length - 1] = id;
  }

  indexOf(id: SourceFileId): number {
    return this.ids.indexOf(id);
  }

  idAtFromTop(index: number): SourceFileId | undefined {
    return this.ids[this.ids.length - 1 - index];
  }
}
