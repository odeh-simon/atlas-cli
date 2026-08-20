import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getStatus, importReviewReport, openAtlasRuntime } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { createFinding, listArtifactsForSession, listFindingsForSession } from "@atlas/persistence";
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

    const result = await importReviewReport({ cwd, env, filePath: reviewPath, reviewerActorId: "human:reviewer" });
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

  it("rejects an implementer attempting to review its own run", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareReviewReady(root);

    await expect(
      importReviewReport({
        cwd,
        env,
        reviewerActorId: "manual-agent",
        reviewerRunId: "reviewrun_self",
        report: {
          reviewer_actor_id: "forged:independent-reviewer",
          reviewer_run_id: "reviewrun_forged",
          summary: "Self review",
          findings: []
        }
      })
    ).rejects.toThrow("Reviewer identity/run must be independent");
  });

  it("rejects review imports without a trusted boundary identity", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareReviewReady(root);

    await expect(importReviewReport({
      cwd,
      env,
      report: { reviewer_actor_id: "payload-only", summary: "Forged identity", findings: [] }
    })).rejects.toThrow("explicit trusted reviewer actor identity");
  });

  it("does not resolve findings from free-form or substring-collision evidence", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareReviewReady(root);
    const runtime = await openAtlasRuntime({ cwd, env });
    const sessionId = runtime.db.exec("SELECT session_id FROM sessions")[0]?.values[0]?.[0] as string;
    const reviewPackage = listArtifactsForSession(runtime.db, sessionId).filter((artifact) => artifact.type === "review_package").at(-1);
    const parsedPackage = JSON.parse(readFileSync(join(runtime.paths.artifactRoot, reviewPackage?.storageUri ?? ""), "utf8")) as {
      implementation_diff_artifact_id: string;
    };
    createFinding(runtime.db, {
      findingId: "REV-OLD",
      sessionId,
      reviewReportArtifactId: reviewPackage!.artifactId,
      reviewIteration: 1,
      severity: "blocking",
      title: "Old blocker",
      description: "Must remain open without exact evidence.",
      evidence: [],
      affectedFiles: [],
      requirementIds: [],
      status: "open",
      now: new Date().toISOString()
    });
    closeAtlasRuntime(runtime);

    await expect(importReviewReport({
      cwd,
      env,
      reviewerActorId: "human:reviewer",
      report: {
        summary: "Substring forgery",
        findings: [],
        resolved_findings: [{
          finding_id: "REV-OLD",
          resolution_evidence: [`prefix:${parsedPackage.implementation_diff_artifact_id}:suffix`]
        }]
      }
    })).rejects.toThrow("free-form resolution evidence");

    await expect(importReviewReport({
      cwd,
      env,
      reviewerActorId: "human:reviewer",
      report: {
        summary: "Structured forgery",
        findings: [],
        resolved_findings: [{
          finding_id: "REV-OLD",
          resolution_evidence: [{ artifact_id: `${parsedPackage.implementation_diff_artifact_id}suffix`, claim: "forged" }]
        }]
      }
    })).rejects.toThrow("valid current diff or check artifact");
  });
});
