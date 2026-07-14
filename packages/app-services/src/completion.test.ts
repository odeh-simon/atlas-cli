import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { approveCompletion, disposeFinding, evaluateCompletion, getStatus, openAtlasRuntime } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listApprovalsForSession, listArtifactsForSession } from "@atlas/persistence";
import { prepareReviewImported } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-completion-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("completion approval", () => {
  it("requires clear gates, then records final approval and completes the session", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareReviewImported(root);
    await disposeFinding({
      cwd,
      env,
      findingId: "REV-001",
      disposition: "resolve",
      reason: "Regression evidence added"
    });

    const evaluated = await evaluateCompletion({ cwd, env });
    const approved = await approveCompletion({ cwd, env, actorId: "tester" });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const artifacts = listArtifactsForSession(runtime.db, approved.sessionId);
    const approvals = listApprovalsForSession(runtime.db, approved.sessionId);
    closeAtlasRuntime(runtime, false);

    expect(evaluated.state).toBe("completion_ready");
    expect(approved.state).toBe("completed");
    expect(status.session?.primaryState).toBe("completed");
    expect(status.nextCommands).toHaveLength(0);
    expect(artifacts.some((artifact) => artifact.type === "completion_report" && artifact.status === "approved")).toBe(
      true
    );
    expect(approvals.some((approval) => approval.approvalType === "completion" && approval.actorId === "tester")).toBe(
      true
    );
  });

  it("blocks completion while a blocking review finding is unresolved", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareReviewImported(root);

    await expect(evaluateCompletion({ cwd, env })).rejects.toThrow("Completion gates failed");
  });
});
