import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getStatus, importReviewReport, openAtlasRuntime } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listFindingsForSession } from "@atlas/persistence";
import { prepareReviewReady } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-review-import-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("importReviewReport", () => {
  it("imports review findings and advances to review_imported", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareReviewReady(root);
    const reviewPath = join(root, "review.json");
    writeFileSync(
      reviewPath,
      JSON.stringify({
        summary: "One issue remains.",
        findings: [
          {
            finding_id: "REV-001",
            severity: "blocking",
            title: "Missing permission guard",
            description: "The implementation does not prove permission handling.",
            evidence: ["contract: permissions"],
            affected_files: ["src/view.tsx"],
            requirement_ids: ["AT-CMP-001"],
            proposed_action: "Add guard and test."
          }
        ]
      })
    );

    const result = await importReviewReport({ cwd, env, filePath: reviewPath });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const findings = listFindingsForSession(runtime.db, result.sessionId);
    closeAtlasRuntime(runtime, false);

    expect(result.state).toBe("review_imported");
    expect(status.session?.primaryState).toBe("review_imported");
    expect(status.nextCommands[0]).toBe("atlas findings disposition <id>");
    expect(findings).toEqual([
      expect.objectContaining({
        findingId: "REV-001",
        severity: "blocking",
        status: "open"
      })
    ]);
  });
});
