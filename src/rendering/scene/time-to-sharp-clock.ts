export class TimeToSharpClock {
  private startAt: number | undefined;

  get running(): boolean {
    return this.startAt !== undefined;
  }

  zoomGestureStarted(): void {
    this.startAt = undefined;
  }

  zoomGestureEnded(atText: boolean, now: number): void {
    this.startAt = atText ? now : undefined;
  }

  leftText(): void {
    this.startAt = undefined;
  }

  check(visibleTextExact: boolean, now: number): number | undefined {
    if (!this.running || !visibleTextExact) return undefined;
    const elapsed = now - (this.startAt ?? now);
    this.startAt = undefined;
    return elapsed;
  }
}
