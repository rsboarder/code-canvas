import { describe, expect, it } from "vitest";

import { TileSlotAllocator } from "./tile-slot-allocator";

describe("TileSlotAllocator", () => {
  it("reuses an existing slot for the same key without evicting anything", () => {
    const allocator = new TileSlotAllocator(2);
    const first = allocator.acquire("a", false);
    allocator.acquire("b", false);
    const again = allocator.acquire("a", false);
    expect(again.slot).toBe(first.slot);
    expect(again.evictedKey).toBeUndefined();
  });

  it("evicts the least-recently-used unpinned slot when the pool is full", () => {
    const allocator = new TileSlotAllocator(2);
    allocator.acquire("a", false);
    allocator.acquire("b", false);
    allocator.touch("b");
    const result = allocator.acquire("c", false);
    expect(result.evictedKey).toBe("a");
    expect(allocator.slotFor("a")).toBeUndefined();
    expect(allocator.slotFor("c")).toBe(result.slot);
  });

  it("never evicts a pinned slot", () => {
    const allocator = new TileSlotAllocator(2);
    allocator.acquire("a", true);
    allocator.acquire("b", false);
    const result = allocator.acquire("c", false);
    expect(result.evictedKey).toBe("b");
    expect(allocator.slotFor("a")).toBeDefined();
  });

  it("reports a missing slot when every slot is pinned", () => {
    const allocator = new TileSlotAllocator(1);
    allocator.acquire("a", true);
    const result = allocator.acquire("b", false);
    expect(result.slot).toBe(-1);
    expect(allocator.slotFor("a")).toBe(0);
  });

  it("unpinning a slot makes it eligible for LRU eviction again", () => {
    const allocator = new TileSlotAllocator(2);
    allocator.acquire("a", true);
    allocator.acquire("b", false);
    allocator.setPinned("a", false);
    const result = allocator.acquire("c", false);
    expect(result.evictedKey).toBe("a");
  });

  it("frees a slot on release so a new key can claim it without eviction", () => {
    const allocator = new TileSlotAllocator(1);
    const first = allocator.acquire("a", false);
    allocator.release("a");
    const result = allocator.acquire("b", false);
    expect(result.slot).toBe(first.slot);
    expect(result.evictedKey).toBeUndefined();
  });

  it("grows without moving existing keys and fills new slots before evicting", () => {
    const allocator = new TileSlotAllocator(2);
    const first = allocator.acquire("a", true);
    const firstSlot = first.slot;
    const second = allocator.acquire("b", false);
    const secondSlot = second.slot;
    allocator.touch("b");

    allocator.grow(4);

    expect(allocator.capacity).toBe(4);
    expect(allocator.slotFor("a")).toBe(firstSlot);
    expect(allocator.slotFor("b")).toBe(secondSlot);
    expect(allocator.isPinned("a")).toBe(true);
    expect(allocator.pinnedCount()).toBe(1);
    expect(allocator.acquire("c", false).evictedKey).toBeUndefined();
    expect(allocator.acquire("d", false).evictedKey).toBeUndefined();
    expect(allocator.slotFor("c")).toBe(2);
    expect(allocator.slotFor("d")).toBe(3);
  });
});
