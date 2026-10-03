import { describe, expect, it } from "vitest";

import {
  AUTOSAVE_DELAY_MS,
  AutosavePolicy,
  EditingSession,
  type Draft,
  type EditorPlacement,
} from "../editing";
import { sourceFileId } from "../shared/domain";

const firstDraft: Draft = {
  fileId: sourceFileId("first.ts"),
  text: "const first = 1;\n",
  contentVersion: 1,
};

const firstPlacement: EditorPlacement = {
  cameraOffsetX: 12,
  cameraOffsetY: 24,
  cameraScale: 1.25,
  frame: { x: 10, y: 20, width: 300, height: 200 },
};

function beginFirst(session: EditingSession): void {
  expect(session.begin(firstDraft, firstPlacement)).toBe(true);
}

describe("EditingSession scenarios", () => {
  it("Double click on another widget", () => {
    const session = new EditingSession();
    beginFirst(session);
    const secondDraft: Draft = {
      fileId: sourceFileId("second.ts"),
      text: "second",
      contentVersion: 4,
    };
    const secondPlacement = {
      ...firstPlacement,
      frame: { ...firstPlacement.frame, x: 500 },
    };

    expect(session.begin(secondDraft, secondPlacement)).toBe(false);
    expect(session.widgetId).toBe(firstDraft.fileId);
    expect(session.draft).toEqual(firstDraft);
    expect(session.placement).toEqual(firstPlacement);
  });

  it("Opening without a change", () => {
    const session = new EditingSession();
    beginFirst(session);

    expect(session.end()).toEqual(firstDraft);
    expect(session.isEditing).toBe(false);
    expect(session.draft).toBeUndefined();
  });

  it("Autosave", () => {
    const session = new EditingSession();
    const policy = new AutosavePolicy();
    beginFirst(session);
    session.recordEdit(1000);

    expect(AUTOSAVE_DELAY_MS).toBe(1000);
    expect(policy.isDue(session, 1999)).toBe(false);
    expect(policy.isDue(session, 2000)).toBe(true);
    session.recordEdit(1500);
    expect(policy.dueAt(session)).toBe(2500);
    session.publish("changed", 2);
    expect(policy.isDue(session, 2500)).toBe(false);
    expect(policy.dueAt(session)).toBe(Number.POSITIVE_INFINITY);
    session.end();
    expect(policy.isDue(session, 3500)).toBe(false);
  });
});

describe("EditingSession invariants", () => {
  it("does not end with unpublished edits", () => {
    const session = new EditingSession();
    beginFirst(session);
    session.recordEdit(1000);

    expect(() => session.end()).toThrow(Error);
    expect(session.isEditing).toBe(true);
    session.publish("published", 2);
    expect(session.end()).toEqual({
      fileId: firstDraft.fileId,
      text: "published",
      contentVersion: 2,
    });
  });

  it("discards unpublished edits and returns the last published draft", () => {
    const session = new EditingSession();
    beginFirst(session);
    session.recordEdit(1000);

    expect(session.discard()).toEqual(firstDraft);
    expect(session.isEditing).toBe(false);
    expect(session.draft).toBeUndefined();
  });

  it("rejects a non-increasing Content Version", () => {
    const session = new EditingSession();
    beginFirst(session);
    session.recordEdit(1000);

    expect(() => {
      session.publish("same", 1);
    }).toThrow(RangeError);
    expect(session.hasUnpublishedEdits).toBe(true);
  });

  it("throws editing commands while Idle", () => {
    const session = new EditingSession();

    expect(() => {
      session.recordEdit(1000);
    }).toThrow(Error);
    expect(() => {
      session.publish("text", 1);
    }).toThrow(Error);
    expect(() => {
      session.end();
    }).toThrow(Error);
  });

  it("copies the placement", () => {
    const session = new EditingSession();
    beginFirst(session);
    firstPlacement.frame.x = 999;

    expect(session.placement?.frame.x).toBe(10);
  });
});
