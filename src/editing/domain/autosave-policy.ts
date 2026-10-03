import type { EditingSession } from "./editing-session";

export const AUTOSAVE_DELAY_MS = 1000;

export class AutosavePolicy {
  constructor(private readonly delayMs = AUTOSAVE_DELAY_MS) {}

  isDue(session: EditingSession, now: number): boolean {
    return (
      session.isEditing &&
      session.hasUnpublishedEdits &&
      now - session.lastEditAt >= this.delayMs
    );
  }

  dueAt(session: EditingSession): number {
    if (!session.isEditing || !session.hasUnpublishedEdits) {
      return Number.POSITIVE_INFINITY;
    }
    return session.lastEditAt + this.delayMs;
  }
}
