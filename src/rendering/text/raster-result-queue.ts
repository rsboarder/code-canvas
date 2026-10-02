export class RasterResultQueue<T> {
  private write: T[] = [];
  private read: T[] = [];

  push(value: T): void {
    this.write.push(value);
  }

  drain(): T[] {
    const results = this.write;
    this.write = this.read;
    this.read = results;
    this.write.length = 0;
    return results;
  }

  clear(): void {
    this.write.length = 0;
    this.read.length = 0;
  }
}
