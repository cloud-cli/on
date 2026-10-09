import { describe, expect, it } from "vitest";
import { formatTimestampedLogLine } from "./timezone-format.mjs";

describe("log timestamp timezone formatting", () => {
  it("converts an ISO timestamp at the beginning of a line to the chosen timezone", () => {
    const line = "[2026-01-01T12:34:56.123Z] build started";
    const formatted = formatTimestampedLogLine(line, "America/Los_Angeles", "en-US");

    expect(formatted).toContain("04:34:56.123");
    expect(formatted).toContain("build started");
    expect(formatted).not.toContain("12:34:56.123Z");
  });

  it("leaves un-timestamped or invalid-zone lines unchanged", () => {
    const line = "plain log output";
    expect(formatTimestampedLogLine(line, "UTC")).toBe(line);
    expect(formatTimestampedLogLine("[2026-01-01T12:34:56Z] message", "Not/A_Zone")).toBe(
      "[2026-01-01T12:34:56Z] message",
    );
  });
});
