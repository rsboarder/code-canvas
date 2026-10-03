export class DrainBudget {
  private elapsed = 0;
  private budgetMs = 0;
  private startedAt = 0;

  constructor(private readonly now: () => number) {}

  restart(budgetMs: number): void {
    this.budgetMs = budgetMs;
    this.elapsed = 0;
    this.startedAt = this.now();
  }

  get exhausted(): boolean {
    return this.elapsed >= this.budgetMs;
  }

  completeUnit(): void {
    this.elapsed = this.now() - this.startedAt;
  }
}
