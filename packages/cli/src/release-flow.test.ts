import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "./index.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release workflow smoke", () => {
  it("runs the manual CLI flow from intake through audited completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "sigil-release-flow-"));
    tempRoots.push(root);
    const repository = join(root, "repo");
    const sigilHome = join(root, "home");
    mkdirSync(repository, { recursive: true });
    writeFileSync(join(repository, "README.md"), "# Release flow fixture\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "sigil-tests@example.invalid"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Sigil Tests"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["add", "README.md"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: repository, stdio: "ignore" });
    const contractPath = join(root, "contract.json");
    const executionPath = join(root, "execution.json");
    const reviewPath = join(root, "review.json");
    writeFileSync(contractPath, JSON.stringify(validContract()));
    writeFileSync(
      executionPath,
      JSON.stringify({
        process_status: "succeeded",
        agent_claims_complete: true,
        changed_files: ["README.md"],
        limitations: []
      })
    );
    writeFileSync(reviewPath, JSON.stringify({ summary: "Release smoke review passed.", findings: [] }));

    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const transcript: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => transcript.push(values.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...values) => transcript.push(values.join(" ")));

    try {
      process.chdir(repository);
      process.env.SIGIL_HOME = sigilHome;
      const commands: readonly string[][] = [
        ["start", "--manual", "--title", "Release smoke", "--objective", "Prove the complete CLI flow"],
        ["context", "build"],
        ["plan"],
        ["contract", "import", contractPath],
        ["approve", "contract", "--yes"],
        ["implement", "export", "--manual"],
        ["execution", "import", executionPath],
        ["checks", "run"],
        ["review", "prepare"],
        ["review", "import", reviewPath, "--actor", "human:release-reviewer"],
        ["complete", "--check"],
        ["approve", "completion", "--yes"],
        ["writebacks", "run", "--provider", "linear", "--target", "REL-1", "--summary", "Completed", "--dry-run"],
        ["status"],
        ["doctor"]
      ];

      for (const command of commands) {
        const code = await main([...command]);
        expect(code, `sigil ${command.join(" ")}\n${transcript.slice(-8).join("\n")}`).toBe(0);
      }

      expect(transcript).toContain("State: completed");
      expect(transcript).toContain("Doctor: passed");
      expect(transcript).toContain("Next: sigil complete --check");
      expect(transcript.some((line) => line.startsWith("Writeback: art_"))).toBe(true);
      const sessionDirectories = readdirSync(join(sigilHome, "artifacts")).filter((name) => name.startsWith("ses_"));
      expect(sessionDirectories).toHaveLength(1);
      const artifactTypes = readdirSync(join(sigilHome, "artifacts", sessionDirectories[0]!));
      expect(artifactTypes).toEqual(
        expect.arrayContaining([
          "task_brief",
          "context_manifest",
          "implementation_contract",
          "execution_report",
          "check_result",
          "review_report",
          "completion_report",
          "adapter_writeback"
        ])
      );
    } finally {
      process.chdir(previousCwd);
      if (previousSigilHome === undefined) delete process.env.SIGIL_HOME;
      else process.env.SIGIL_HOME = previousSigilHome;
    }
  });
});

function validContract(): Record<string, unknown> {
  return {
    status: "valid",
    objective: { heading: "Objective", body_markdown: "Prove the packaged Sigil workflow." },
    scope: { in_scope: ["Release smoke"], out_of_scope: ["Live provider writes"] },
    approved_decisions: [{ id: "release-decision", decision: "Use fixtures", rationale: "Keep release tests deterministic." }],
    technical_approach: { heading: "Technical Approach", body_markdown: "Exercise every manual workflow gate." },
    affected_subsystems: ["cli", "app-services"],
    reuse: ["Existing workflow services"],
    constraints: ["No external network calls"],
    data_state_permissions: { heading: "Data State Permissions", body_markdown: "Use isolated temporary state." },
    required_states: ["loading", "error"],
    accessibility_observability: { heading: "Accessibility Observability", body_markdown: "Verify stable CLI output." },
    edge_cases: ["Missing external credentials"],
    acceptance_criteria: ["Completion is explicitly approved"],
    tests_and_validation: ["Release flow smoke passes"],
    unresolved_questions: [],
    prohibitions: ["No real writebacks"]
  };
}
