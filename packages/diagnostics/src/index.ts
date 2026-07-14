export const diagnosticsPackage = "@atlas/diagnostics";

export type TelemetryCategory = "workflow" | "adapter" | "check" | "error";
export type TelemetryStatus = "started" | "succeeded" | "failed" | "blocked" | "cancelled";

export interface TelemetryEventInput {
  readonly eventName: string;
  readonly category: TelemetryCategory;
  readonly status: TelemetryStatus;
  readonly emittedAt?: string | undefined;
  readonly atlasVersion?: string | undefined;
  readonly adapter?: string | undefined;
  readonly workflowState?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly counts?: Readonly<Record<string, number>> | undefined;
}

export interface TelemetryEvent {
  readonly schema_version: 1;
  readonly product: "atlas-cli";
  readonly event_name: string;
  readonly category: TelemetryCategory;
  readonly status: TelemetryStatus;
  readonly emitted_at: string;
  readonly atlas_version?: string | undefined;
  readonly adapter?: string | undefined;
  readonly workflow_state?: string | undefined;
  readonly duration_ms?: number | undefined;
  readonly counts?: Readonly<Record<string, number>> | undefined;
}

const forbiddenTelemetryKeyFragments = [
  "apikey",
  "api_key",
  "body",
  "content",
  "description",
  "designtext",
  "design_text",
  "diff",
  "filename",
  "file_name",
  "filepath",
  "file_path",
  "objective",
  "prompt",
  "repourl",
  "repo_url",
  "secret",
  "stderr",
  "stdout",
  "text",
  "title",
  "token"
] as const;

export function buildTelemetryEvent(input: TelemetryEventInput): TelemetryEvent {
  const event: TelemetryEvent = {
    schema_version: 1,
    product: "atlas-cli",
    event_name: input.eventName,
    category: input.category,
    status: input.status,
    emitted_at: input.emittedAt ?? new Date().toISOString(),
    atlas_version: input.atlasVersion,
    adapter: input.adapter,
    workflow_state: input.workflowState,
    duration_ms: input.durationMs,
    counts: input.counts
  };
  assertTelemetryEventIsContentFree(event);
  return removeUndefinedTelemetryEvent(event);
}

export function createTelemetryPreview(atlasVersion = "0.0.0"): TelemetryEvent {
  return buildTelemetryEvent({
    eventName: "workflow.command.completed",
    category: "workflow",
    status: "succeeded",
    atlasVersion,
    workflowState: "checks_completed",
    durationMs: 123,
    counts: {
      artifacts: 8,
      checks_failed: 0,
      checks_passed: 3
    }
  });
}

export function telemetryEnabled(input: { readonly enabled?: boolean | undefined } | undefined): boolean {
  return input?.enabled === true;
}

export function assertTelemetryEventIsContentFree(value: unknown, path = "event"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertTelemetryEventIsContentFree(item, `${path}[${index}]`));
    return;
  }

  if (typeof value !== "object" || value === null) return;

  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9_]/g, "");
    if (forbiddenTelemetryKeyFragments.some((fragment) => normalized.includes(fragment))) {
      throw new TypeError(`Telemetry payload cannot include content-bearing field: ${path}.${key}`);
    }
    assertTelemetryEventIsContentFree(nested, `${path}.${key}`);
  }
}

function removeUndefinedTelemetryEvent(value: TelemetryEvent): TelemetryEvent {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined)) as unknown as TelemetryEvent;
}
