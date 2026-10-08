import { GestureTargeting, type WheelInput } from "../interaction";
import type { FrameLoop } from "../rendering";

interface InputWiringOptions {
  readonly canvas: HTMLCanvasElement;
  readonly editorContainer: HTMLElement;
  readonly targeting: GestureTargeting;
  readonly getFrameLoop: () => FrameLoop | undefined;
}

interface InputWiring {
  readonly wire: () => void;
}

interface EditorWheelInput extends WheelInput {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  offsetX: number;
  offsetY: number;
  timeStamp: number;
}

export function createInputWiring(options: InputWiringOptions): InputWiring {
  let forwardedEditorWheel: WheelEvent | undefined;
  const editorWheelInput: EditorWheelInput = {
    deltaX: 0,
    deltaY: 0,
    ctrlKey: false,
    metaKey: false,
    offsetX: 0,
    offsetY: 0,
    timeStamp: 0,
    preventDefault: () => forwardedEditorWheel?.preventDefault(),
  };
  return {
    wire: () => {
      wireCanvasInput(options);
      wireKeyboardInput(options);
      wireEditorWheel(
        options,
        editorWheelInput,
        (event) => {
          forwardedEditorWheel = event;
        },
        () => {
          forwardedEditorWheel = undefined;
        },
      );
    },
  };
}

function wireCanvasInput(options: InputWiringOptions): void {
  let capturedPointerId: number | undefined;
  options.canvas.addEventListener(
    "wheel",
    (event) => {
      options.targeting.wheel(event);
      options.getFrameLoop()?.invalidate();
    },
    { passive: false },
  );
  options.canvas.addEventListener("dblclick", (event) => {
    options.targeting.doubleClick(event);
    options.getFrameLoop()?.invalidate();
  });
  options.canvas.addEventListener("pointerdown", (event) => {
    options.targeting.pointerDown(event);
    if (event.button === 0) {
      capturedPointerId = event.pointerId;
      options.canvas.setPointerCapture(event.pointerId);
    }
    options.getFrameLoop()?.invalidate();
  });
  options.canvas.addEventListener("pointermove", (event) => {
    options.targeting.pointerMove(event);
    if (options.targeting.gestureInProgress) {
      options.getFrameLoop()?.invalidate();
    }
  });
  const pointerEnd = (event: PointerEvent): void => {
    options.targeting.pointerUp(event);
    if (capturedPointerId === event.pointerId) {
      options.canvas.releasePointerCapture(event.pointerId);
      capturedPointerId = undefined;
    }
    options.getFrameLoop()?.invalidate();
  };
  options.canvas.addEventListener("pointerup", pointerEnd);
  options.canvas.addEventListener("pointercancel", pointerEnd);
}

function wireKeyboardInput(options: InputWiringOptions): void {
  window.addEventListener("keydown", (event) => {
    if (isKeyboardExcludedTarget(event.target, options.editorContainer)) return;
    options.targeting.keyDown(event);
    options.getFrameLoop()?.invalidate();
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") options.targeting.keyUp(event);
  });
}

function isKeyboardExcludedTarget(
  target: EventTarget | null,
  editorContainer: HTMLElement,
): boolean {
  if (!(target instanceof Node)) return false;
  if (editorContainer.contains(target)) return true;
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.tagName === "BUTTON"
  );
}

function wireEditorWheel(
  options: InputWiringOptions,
  adapter: EditorWheelInput,
  setEvent: (event: WheelEvent) => void,
  clearEvent: () => void,
): void {
  options.editorContainer.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      setEvent(event);
      adapter.deltaX = event.deltaX;
      adapter.deltaY = event.deltaY;
      adapter.ctrlKey = event.ctrlKey;
      adapter.metaKey = event.metaKey;
      adapter.offsetX = event.clientX;
      adapter.offsetY = event.clientY;
      adapter.timeStamp = event.timeStamp;
      options.targeting.wheel(adapter);
      event.stopPropagation();
      options.getFrameLoop()?.invalidate();
      clearEvent();
    },
    { capture: true, passive: false },
  );
}
