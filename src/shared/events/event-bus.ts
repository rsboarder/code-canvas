interface BusEvent {
  readonly type: string;
}
type TypeOf<E extends BusEvent> = E["type"];
type EventOfType<E extends BusEvent, Type extends TypeOf<E>> = Extract<
  E,
  { type: Type }
>;

export type EventHandler<E> = (event: E) => void;
export type Unsubscribe = () => void;

export interface EventBus<E extends BusEvent> {
  subscribe<Type extends TypeOf<E>>(
    type: Type,
    handler: EventHandler<EventOfType<E, Type>>,
  ): Unsubscribe;
  publish(event: E): void;
}

export function createEventBus<E extends BusEvent>(): EventBus<E> {
  const handlersByType = new Map<TypeOf<E>, EventHandler<E>[]>();

  function subscribe<Type extends TypeOf<E>>(
    type: Type,
    handler: EventHandler<EventOfType<E, Type>>,
  ): Unsubscribe {
    const handlers = handlersByType.get(type) ?? [];
    if (!handlersByType.has(type)) {
      handlersByType.set(type, handlers);
    }
    const stored = handler as unknown as EventHandler<E>;
    handlers.push(stored);
    return () => {
      const index = handlers.indexOf(stored);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    };
  }

  function publish(event: E): void {
    const handlers = handlersByType.get(event.type);
    if (handlers === undefined) {
      return;
    }
    for (const handler of handlers.slice()) {
      handler(event);
    }
  }

  return { subscribe, publish };
}
