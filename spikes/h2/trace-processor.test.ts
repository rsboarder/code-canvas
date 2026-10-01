import { describe, expect, it } from "vitest";

import { parseCsvRow } from "./trace-processor";

describe("Perfetto CSV parsing", () => {
  it("maps the first CSV data row without parsing the protobuf trace", () => {
    expect(
      parseCsvRow("presented_all,presented_partial,dropped\n10,2,1\n"),
    ).toEqual({ presented_all: "10", presented_partial: "2", dropped: "1" });
  });

  it("strips the quotes trace_processor_shell wraps every field in", () => {
    // trace_processor_shell's real default output quotes both the header
    // and the data row; parseCsvRow previously left the quotes in the keys
    // (e.g. `"presented_all"`), so every lookup by the bare field name
    // silently returned undefined.
    expect(
      parseCsvRow(
        '"presented_all","presented_partial","dropped"\n"928","1","32"\n',
      ),
    ).toEqual({ presented_all: "928", presented_partial: "1", dropped: "32" });
  });
});
