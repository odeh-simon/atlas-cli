import { describe, expect, it } from "vitest";

import {
  assertTelemetryEventIsContentFree,
  buildTelemetryEvent,
  createTelemetryPreview,
  telemetryEnabled
} from "./index.js";

describe("diagnostics telemetry", () => {
  it("builds content-free telemetry events", () => {
    const event = buildTelemetryEvent({
      eventName: "adapter.inspect.completed",
      category: "adapter",
      status: "succeeded",
      adapter: "figma",
      counts: { nodes: 4 }
    });

    expect(event).toMatchObject({
      schema_version: 1,
      product: "atlas-cli",
      event_name: "adapter.inspect.completed",
      adapter: "figma"
    });
    expect(JSON.stringify(createTelemetryPreview())).not.toContain("prompt");
  });

  it("rejects content-bearing telemetry fields", () => {
    expect(() => assertTelemetryEventIsContentFree({ prompt: "implement this" })).toThrow("content-bearing");
    expect(() => assertTelemetryEventIsContentFree({ metadata: { token: "secret" } })).toThrow("content-bearing");
    expect(() => assertTelemetryEventIsContentFree({ counts: { checks_passed: 1 } })).not.toThrow();
  });

  it("treats telemetry as opt-in", () => {
    expect(telemetryEnabled(undefined)).toBe(false);
    expect(telemetryEnabled({ enabled: false })).toBe(false);
    expect(telemetryEnabled({ enabled: true })).toBe(true);
  });
});
