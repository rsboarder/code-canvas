/**
 * Synchronous, in-process, typed event bus. It carries only low-frequency
 * events between contexts; per-frame state is pulled, never published here
 * (design D5).
 */
export { createEventBus } from "./event-bus";
export type { EventBus, EventHandler, Unsubscribe } from "./event-bus";
