import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { disposeFinding, getStatus, openAtlasRuntime } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listFindingsForSession } from "@atlas/persistence";
import { prepareReviewImported } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-disposition-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("disposeFinding", () => {
  it("records a disposition, updates finding status, and advances state", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareReviewImported(root);

    const result = await disposeFinding({
      cwd,
      env,
      findingId: "REV-001",
      disposition: "resolve",
      reason: "Regression evidence added",
      evidence: ["basic-session-integrity"]
    });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const findings = listFindingsForSession(runtime.db, result.sessionId);
    closeAtlasRuntime(runtime, false);

    expect(result.state).toBe("findings_dispositioned");
    expect(result.status).toBe("resolved");
    expect(status.nextCommands[0]).toBe("atlas complete --check");
    expect(findings[0]?.status).toBe("resolved");
  });
});
