export type EditingEndReason =
  "escape" | "pan" | "zoom" | "outside" | "another-widget";

export interface EditingSession {
  readonly widgetId: string;
  readonly text: string;
  readonly contentVersion: number;
  readonly dirty: boolean;
}

export function createEditingSession(
  widgetId: string,
  text: string,
  contentVersion: number,
): EditingSession {
  return { widgetId, text, contentVersion, dirty: false };
}
