import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getStatus, openAtlasRuntime, runBasicCheck } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@atlas/persistence";
import { prepareApprovedContract, prepareExecution } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-checks-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runBasicCheck", () => {
  it("passes with an approved contract and execution report", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);

    const result = await runBasicCheck({ cwd, env });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const checkArtifacts = listArtifactsForSession(runtime.db, result.sessionId).filter(
      (artifact) => artifact.type === "check_result"
    );
    const runLogArtifacts = listArtifactsForSession(runtime.db, result.sessionId).filter(
      (artifact) => artifact.type === "check_run_log"
    );
    closeAtlasRuntime(runtime, false);

    expect(result.status).toBe("passed");
    expect(result.checkCount).toBe(1);
    expect(result.state).toBe("checks_completed");
    expect(status.session?.primaryState).toBe("checks_completed");
    expect(status.nextCommands[0]).toBe("atlas review prepare");
    expect(checkArtifacts).toHaveLength(1);
    expect(runLogArtifacts).toHaveLength(1);
  });

  it("fails before an execution report is imported", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);

    await expect(runBasicCheck({ cwd, env })).rejects.toThrow("Required check failed");
  });

  it("runs configured process checks after built-in integrity passes", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);
    writeFileSync(
      join(cwd, "atlas.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        checks: [
          {
            name: "node-smoke",
            required: true,
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            dependsOn: ["basic-session-integrity"]
          }
        ]
      })
    );

    const result = await runBasicCheck({ cwd, env });

    expect(result.status).toBe("passed");
    expect(result.checkCount).toBe(2);
  });

  it("records Git fingerprints on check artifacts when the repo is available", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);
    git(cwd, "init");
    writeFileSync(join(cwd, "README.md"), "Initial docs\n");
    git(cwd, "add", "README.md");
    git(cwd, "-c", "user.email=atlas@example.test", "-c", "user.name=Atlas", "commit", "-m", "Initial");

    const result = await runBasicCheck({ cwd, env });
    const check = readLatestJsonArtifact(root, result.sessionId, "check_result") as {
      git_fingerprint?: unknown;
      metadata?: { git?: { dirty?: unknown } };
    };

    expect(typeof check.git_fingerprint).toBe("string");
    expect(check.metadata?.git?.dirty).toBe(false);
  });

  it("runs configured design scans and writes a rejected check log when required violations exist", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);
    writeFileSync(join(cwd, "view.tsx"), '<div className="bg-[#123456]" />\n');
    writeFileSync(
      join(cwd, "atlas.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        checks: [{ name: "design", kind: "design-scan", required: true, dependsOn: ["basic-session-integrity"] }]
      })
    );

    await expect(runBasicCheck({ cwd, env })).rejects.toThrow("Required check failed");
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const runLogs = listArtifactsForSession(runtime.db, status.session?.sessionId ?? "").filter(
      (artifact) => artifact.type === "check_run_log"
    );
    closeAtlasRuntime(runtime, false);

    expect(runLogs.at(-1)?.status).toBe("rejected");
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function readLatestJsonArtifact(root: string, sessionId: string, type: string): unknown {
  const artifactDir = join(root, "home", "artifacts", sessionId, type);
  const latest = readdirSync(artifactDir).sort().at(-1);
  if (latest === undefined) throw new Error(`No ${type} artifact found`);
  return JSON.parse(readFileSync(join(artifactDir, latest), "utf8")) as unknown;
}
