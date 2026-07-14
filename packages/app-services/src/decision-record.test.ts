import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openAtlasRuntime, recordDecision, startManualTask } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession, listDecisionRecordsForSession } from "@atlas/persistence";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-decision-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("recordDecision", () => {
  it("records approved decision artifacts and durable decision records", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-usage" });

    const result = await recordDecision({
      cwd,
      env,
      kind: "deviation",
      title: "Accept CLI-only trace for M3",
      rationale: "External trace UI is not available yet.",
      category: "design_constraints",
      actorId: "tester"
    });
    const runtime = await openAtlasRuntime({ cwd, env });
    const records = listDecisionRecordsForSession(runtime.db, result.sessionId);
    const artifacts = listArtifactsForSession(runtime.db, result.sessionId).filter(
      (artifact) => artifact.type === "decision_record"
    );
    closeAtlasRuntime(runtime, false);

    expect(result.kind).toBe("deviation");
    expect(records[0]).toMatchObject({
      decisionId: result.decisionId,
      kind: "deviation",
      category: "design_constraints",
      approvedBy: "tester"
    });
    expect(artifacts[0]).toMatchObject({ artifactId: result.artifactId, status: "approved" });
  });
});
