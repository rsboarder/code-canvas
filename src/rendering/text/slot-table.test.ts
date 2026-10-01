import { describe, expect, it } from "vitest";

import {
  SLOT_TABLE_COMPONENTS,
  SLOT_TABLE_HEIGHT,
  SLOT_TABLE_ROWS,
  SLOT_TABLE_WIDTH,
  packSlotRecord,
  slotTableOffset,
  type SlotRecord,
} from "./slot-table";

const ATLAS_SIZE = 512;

describe("slot table packing", () => {
  it.each([0, 1, SLOT_TABLE_WIDTH - 1])(
    "stores UV and geometry at the shader rows for slot %i",
    (slot) => {
      const record: SlotRecord = {
        raster: {
          x: slot * 2,
          y: slot + 3,
          width: 12,
          height: 20,
        },
        advance: 13,
        baseline: 16,
      };
      const packed = packSlotRecord(record, ATLAS_SIZE);
      const table = new Float32Array(
        SLOT_TABLE_WIDTH * SLOT_TABLE_HEIGHT * SLOT_TABLE_COMPONENTS,
      );
      table.set(packed.uv, slotTableOffset(slot, SLOT_TABLE_ROWS.uv));
      table.set(
        packed.geometry,
        slotTableOffset(slot, SLOT_TABLE_ROWS.geometry),
      );

      expect(
        Array.from(
          table.slice(
            slotTableOffset(slot, SLOT_TABLE_ROWS.uv),
            slotTableOffset(slot, SLOT_TABLE_ROWS.uv) + SLOT_TABLE_COMPONENTS,
          ),
        ),
      ).toEqual(packed.uv);
      expect(
        Array.from(
          table.slice(
            slotTableOffset(slot, SLOT_TABLE_ROWS.geometry),
            slotTableOffset(slot, SLOT_TABLE_ROWS.geometry) +
              SLOT_TABLE_COMPONENTS,
          ),
        ),
      ).toEqual(packed.geometry);
      expect(packed.uv).toEqual([
        record.raster.x / ATLAS_SIZE,
        record.raster.y / ATLAS_SIZE,
        (record.raster.x + record.raster.width) / ATLAS_SIZE,
        (record.raster.y + record.raster.height) / ATLAS_SIZE,
      ]);
      expect(packed.geometry.slice(0, 2)).toEqual([
        record.raster.width,
        record.raster.height,
      ]);
    },
  );
});
