import { describe, expect, expectTypeOf, it } from "vitest";

import { createEventBus } from "../shared/events";

interface FooEvent {
  readonly type: "foo";
  readonly value: number;
}

interface BarEvent {
  readonly type: "bar";
  readonly label: string;
}

type TestEvent = FooEvent | BarEvent;

describe("createEventBus delivery", () => {
  it("is synchronous: publish returns only after every handler ran", () => {
    const bus = createEventBus<TestEvent>();
    const order: string[] = [];
    bus.subscribe("foo", () => {
      order.push("handler-start");
      order.push("handler-end");
    });

    bus.publish({ type: "foo", value: 1 });

    expect(order).toEqual(["handler-start", "handler-end"]);
  });

  it("runs handlers of one type in subscription order", () => {
    const bus = createEventBus<TestEvent>();
    const calls: string[] = [];
    bus.subscribe("foo", () => {
      calls.push("first");
    });
    bus.subscribe("foo", () => {
      calls.push("second");
    });
    bus.subscribe("foo", () => {
      calls.push("third");
    });

    bus.publish({ type: "foo", value: 1 });

    expect(calls).toEqual(["first", "second", "third"]);
  });
});

describe("createEventBus subscription snapshots", () => {
  it("does not skip a handler already snapshotted for the event being delivered when it unsubscribes another handler", () => {
    const bus = createEventBus<TestEvent>();
    const calls: string[] = [];
    let unsubscribeSecond = (): void => {
      /* replaced below */
    };
    bus.subscribe("foo", () => {
      calls.push("first");
      unsubscribeSecond();
    });
    unsubscribeSecond = bus.subscribe("foo", () => {
      calls.push("second");
    });

    bus.publish({ type: "foo", value: 1 });

    expect(calls).toEqual(["first", "second"]);
  });

  it("stops an unsubscribed handler from every later event", () => {
    const bus = createEventBus<TestEvent>();
    const calls: string[] = [];
    const unsubscribe = bus.subscribe("foo", () => {
      calls.push("handler");
    });

    bus.publish({ type: "foo", value: 1 });
    unsubscribe();
    bus.publish({ type: "foo", value: 2 });

    expect(calls).toEqual(["handler"]);
  });

  it("takes a subscription added during delivery into effect only from the next event", () => {
    const bus = createEventBus<TestEvent>();
    const calls: string[] = [];
    bus.subscribe("foo", () => {
      calls.push("first");
      bus.subscribe("foo", () => {
        calls.push("late");
      });
    });

    bus.publish({ type: "foo", value: 1 });
    expect(calls).toEqual(["first"]);

    calls.length = 0;
    bus.publish({ type: "foo", value: 2 });
    expect(calls).toEqual(["first", "late"]);
  });
});

describe("createEventBus nested publish and errors", () => {
  it("delivers a publish from inside a handler depth-first, before the outer delivery continues", () => {
    const bus = createEventBus<TestEvent>();
    const calls: string[] = [];
    bus.subscribe("foo", () => {
      calls.push("outer-start");
      bus.publish({ type: "bar", label: "x" });
      calls.push("outer-end");
    });
    bus.subscribe("bar", () => {
      calls.push("inner");
    });

    bus.publish({ type: "foo", value: 1 });

    expect(calls).toEqual(["outer-start", "inner", "outer-end"]);
  });

  it("propagates a handler's error out of publish, stopping remaining handlers for that event, and keeps the bus usable afterward", () => {
    const bus = createEventBus<TestEvent>();
    const calls: string[] = [];
    bus.subscribe("foo", () => {
      calls.push("before");
    });
    bus.subscribe("foo", () => {
      throw new Error("boom");
    });
    bus.subscribe("foo", () => {
      calls.push("after");
    });

    expect(() => {
      bus.publish({ type: "foo", value: 1 });
    }).toThrow("boom");
    expect(calls).toEqual(["before"]);

    bus.subscribe("bar", () => {
      calls.push("still works");
    });
    bus.publish({ type: "bar", label: "x" });

    expect(calls).toEqual(["before", "still works"]);
  });
});

describe("createEventBus types", () => {
  it("narrows the handler's event type to the subscribed event", () => {
    const bus = createEventBus<TestEvent>();
    bus.subscribe("foo", (event) => {
      expectTypeOf(event).toEqualTypeOf<FooEvent>();
    });
    bus.subscribe("bar", (event) => {
      expectTypeOf(event).toEqualTypeOf<BarEvent>();
    });
  });
});
