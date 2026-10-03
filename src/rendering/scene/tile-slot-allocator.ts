// Pure slot bookkeeping for the tile pool (design D6 "Tile pool": "Slots are
// reused least-recently-used; visible and fallback tiles are never
// evicted"). Kept free of WebGL so the LRU/pinning policy is unit-tested
// without a context; `TilePool` (same directory) wraps this with the actual
// `TEXTURE_2D_ARRAY` layer.

export interface SlotAcquireResult {
  readonly slot: number;
  readonly evictedKey: string | undefined;
}

export class TileSlotAllocator {
  private readonly keyToSlot = new Map<string, number>();
  private readonly slotKey: (string | undefined)[];
  private readonly slotPinned: boolean[];
  private readonly slotLastUsed: number[];
  private readonly result: { slot: number; evictedKey: string | undefined } = {
    slot: -1,
    evictedKey: undefined,
  };
  private tick = 0;

  private capacityValue: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        "TileSlotAllocator capacity must be a positive integer",
      );
    }
    this.capacityValue = capacity;
    this.slotKey = new Array<string | undefined>(capacity).fill(undefined);
    this.slotPinned = new Array<boolean>(capacity).fill(false);
    this.slotLastUsed = new Array<number>(capacity).fill(0);
  }

  get capacity(): number {
    return this.capacityValue;
  }

  grow(newCapacity: number): void {
    if (newCapacity <= this.capacityValue) return;
    if (!Number.isInteger(newCapacity)) {
      throw new RangeError(
        "TileSlotAllocator capacity must be a positive integer",
      );
    }
    const added = newCapacity - this.capacityValue;
    this.slotKey.push(...new Array<string | undefined>(added).fill(undefined));
    this.slotPinned.push(...new Array<boolean>(added).fill(false));
    this.slotLastUsed.push(...new Array<number>(added).fill(0));
    this.capacityValue = newCapacity;
  }

  slotFor(key: string): number | undefined {
    return this.keyToSlot.get(key);
  }

  isPinned(key: string): boolean {
    const slot = this.keyToSlot.get(key);
    return slot === undefined ? false : (this.slotPinned[slot] ?? false);
  }

  pinnedCount(): number {
    let count = 0;
    for (let slot = 0; slot < this.capacity; slot += 1) {
      if (this.slotKey[slot] !== undefined && this.slotPinned[slot]) count += 1;
    }
    return count;
  }

  touch(key: string): void {
    const slot = this.keyToSlot.get(key);
    if (slot !== undefined) this.slotLastUsed[slot] = this.nextTick();
  }

  setPinned(key: string, pinned: boolean): void {
    const slot = this.keyToSlot.get(key);
    if (slot !== undefined) this.slotPinned[slot] = pinned;
  }

  // Claims a slot for `key`: an existing resident slot is reused and
  // re-touched; otherwise a free slot is used, and failing that the oldest
  // unpinned slot is evicted. A fully pinned pool is a visible missing-tile
  // condition, not an exception the frame loop can recover from.
  acquire(key: string, pinned: boolean): SlotAcquireResult {
    this.result.evictedKey = undefined;
    const existing = this.keyToSlot.get(key);
    if (existing !== undefined) {
      this.slotPinned[existing] = pinned;
      this.slotLastUsed[existing] = this.nextTick();
      this.result.slot = existing;
      return this.result;
    }
    const free = this.slotKey.indexOf(undefined);
    if (free !== -1) return this.place(free, key, pinned);
    const lruSlot = this.findLru();
    if (lruSlot === undefined) {
      this.result.slot = -1;
      return this.result;
    }
    const evictedKey = this.slotKey[lruSlot];
    if (evictedKey !== undefined) this.keyToSlot.delete(evictedKey);
    const placed = this.place(lruSlot, key, pinned);
    this.result.evictedKey = evictedKey;
    return placed;
  }

  release(key: string): void {
    const slot = this.keyToSlot.get(key);
    if (slot === undefined) return;
    this.keyToSlot.delete(key);
    this.slotKey[slot] = undefined;
    this.slotPinned[slot] = false;
  }

  private place(slot: number, key: string, pinned: boolean): SlotAcquireResult {
    this.slotKey[slot] = key;
    this.slotPinned[slot] = pinned;
    this.slotLastUsed[slot] = this.nextTick();
    this.keyToSlot.set(key, slot);
    this.result.slot = slot;
    return this.result;
  }

  private findLru(): number | undefined {
    let best: number | undefined;
    for (let slot = 0; slot < this.capacity; slot += 1) {
      if (this.slotPinned[slot] || this.slotKey[slot] === undefined) continue;
      const lastUsed = this.slotLastUsed[slot] ?? 0;
      if (best === undefined || lastUsed < (this.slotLastUsed[best] ?? 0)) {
        best = slot;
      }
    }
    return best;
  }

  private nextTick(): number {
    this.tick += 1;
    return this.tick;
  }
}
