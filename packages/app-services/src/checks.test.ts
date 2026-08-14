import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

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

  it("runs required visual checks and records their evidence artifacts", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);
    const png = pngFixture([255, 255, 255, 255]);
    writeFileSync(join(cwd, "dashboard-baseline.png"), png);
    writeVisualConfig(cwd);

    const result = await runBasicCheck({
      cwd,
      env,
      visualRuntime: {
        captureAdapter: {
          capture: async (input) => ({
            png,
            url: input.url,
            title: "Dashboard",
            viewport: input.viewport,
            fullPage: false,
            browserChannel: "msedge"
          })
        }
      }
    });
    const check = readLatestJsonArtifact(root, result.sessionId, "check_result") as {
      visual_config_fingerprint?: unknown;
      metadata?: { visual_evidence_artifact_ids?: unknown[] };
    };

    expect(result).toMatchObject({ status: "passed", checkCount: 2 });
    expect(check.visual_config_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(check.metadata?.visual_evidence_artifact_ids?.length).toBeGreaterThanOrEqual(5);
  });

  it("blocks a required visual check when AI findings meet its severity policy", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);
    const png = pngFixture([255, 255, 255, 255]);
    writeFileSync(join(cwd, "dashboard-baseline.png"), png);
    writeVisualConfig(cwd, {
      ai: {
        defaultProviderAlias: "ollama.vision",
        providers: [
          {
            alias: "ollama.vision",
            provider: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            model: "vision-model",
            capabilities: ["text", "vision"]
          }
        ]
      },
      aiReview: { required: true, failOn: ["important"] }
    });

    await expect(
      runBasicCheck({
        cwd,
        env,
        visualRuntime: {
          captureAdapter: {
            capture: async (input) => ({
              png,
              url: input.url,
              title: "Dashboard",
              viewport: input.viewport,
              fullPage: false,
              browserChannel: "msedge"
            })
          },
          completionImpl: async () => ({
            providerAlias: "ollama.vision",
            model: "vision-model",
            content: JSON.stringify({
              status: "findings",
              summary: "A spacing regression is visible.",
              findings: [
                {
                  severity: "important",
                  category: "spacing",
                  title: "Header spacing differs",
                  detail: "The actual header spacing does not match the reference.",
                  evidence: ["reference", "actual"],
                  confidence: 0.9
                }
              ]
            })
          })
        }
      })
    ).rejects.toThrow("Required check failed");
  });

  it("records an optional visual failure without blocking the check set", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);
    writeFileSync(join(cwd, "dashboard-baseline.png"), pngFixture([255, 255, 255, 255]));
    writeVisualConfig(cwd, { required: false });

    const result = await runBasicCheck({
      cwd,
      env,
      visualRuntime: {
        captureAdapter: {
          capture: async (input) => ({
            png: pngFixture([0, 0, 0, 255]),
            url: input.url,
            title: "Dashboard",
            viewport: input.viewport,
            fullPage: false,
            browserChannel: "msedge"
          })
        }
      }
    });

    expect(result).toMatchObject({ status: "passed", checkCount: 2 });
    expect(result.evidenceCount).toBeGreaterThanOrEqual(5);
  });

  it("rejects invalid visual thresholds instead of silently using defaults", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);
    writeFileSync(join(cwd, "dashboard-baseline.png"), pngFixture([255, 255, 255, 255]));
    writeVisualConfig(cwd);
    const configPath = join(cwd, "atlas.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { checks: Array<Record<string, unknown>> };
    config.checks[0]!.allowedDiffRatio = 2;
    writeFileSync(configPath, JSON.stringify(config));

    await expect(runBasicCheck({ cwd, env })).rejects.toThrow(
      "dashboard-visual.allowedDiffRatio must be between 0 and 1"
    );
  });
});

function writeVisualConfig(
  cwd: string,
  options: { readonly ai?: unknown; readonly aiReview?: unknown; readonly required?: boolean } = {}
): void {
  writeFileSync(
    join(cwd, "atlas.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      project: { name: "fixture", baseBranch: "main" },
      ...(options.ai === undefined ? {} : { ai: options.ai }),
      checks: [
        {
          name: "dashboard-visual",
          kind: "visual",
          required: options.required ?? true,
          dependsOn: ["basic-session-integrity"],
          url: "http://127.0.0.1:3000/dashboard",
          referencePath: "dashboard-baseline.png",
          viewport: { width: 800, height: 600 },
          allowedDiffRatio: 0,
          ...(options.aiReview === undefined ? {} : { aiReview: options.aiReview })
        }
      ]
    })
  );
}

function pngFixture(color: readonly [number, number, number, number]): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  for (let offset = 0; offset < image.data.length; offset += 4) image.data.set(color, offset);
  return PNG.sync.write(image);
}

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
