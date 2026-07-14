#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  exportPlanningPackage,
  getStatus,
  approveContract,
  approveCompletion,
  archiveSession,
  cancelSession,
  exportManualAgentPackage,
  disposeFinding,
  evaluateCompletion,
  runBasicCheck,
  importContextManifest,
  importContract,
  importExecutionResult,
  importReviewReport,
  pauseSession,
  prepareReviewPackage,
  resumePausedSession,
  unarchiveSession,
  startManualTask
} from "@atlas/app-services";

const version = "0.0.0";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const [command, subcommand, ...rest] = argv;

    if (command === undefined || command === "--help" || command === "-h") {
      printHelp();
      return 0;
    }

    if (command === "--version" || command === "-v") {
      console.log(version);
      return 0;
    }

    if (command === "init") {
      return initCommand(compact([subcommand, ...rest]));
    }

    if (command === "start" && subcommand === "--manual") {
      return startManualCommand(rest);
    }

    if (command === "status") {
      return statusCommand();
    }

    if (command === "resume") {
      return resumeCommand();
    }

    if (command === "pause") {
      return pauseCommand();
    }

    if (command === "archive") {
      return archiveCommand();
    }

    if (command === "unarchive") {
      return unarchiveCommand();
    }

    if (command === "cancel") {
      return cancelCommand(compact([subcommand, ...rest]));
    }

    if (command === "context" && subcommand === "import") {
      return contextImportCommand(rest);
    }

    if (command === "plan") {
      return planCommand();
    }

    if (command === "contract" && subcommand === "import") {
      return contractImportCommand(rest);
    }

    if (command === "approve" && subcommand === "contract") {
      return approveContractCommand(rest);
    }

    if (command === "implement" && subcommand === "export" && rest.includes("--manual")) {
      return implementExportManualCommand();
    }

    if (command === "execution" && subcommand === "import") {
      return executionImportCommand(rest);
    }

    if (command === "checks" && subcommand === "run") {
      return checksRunCommand();
    }

    if (command === "review" && subcommand === "prepare") {
      return reviewPrepareCommand();
    }

    if (command === "review" && subcommand === "import") {
      return reviewImportCommand(rest);
    }

    if (command === "findings" && subcommand === "disposition") {
      return findingDispositionCommand(rest);
    }

    if (command === "complete" && subcommand === "--check") {
      return completeCheckCommand();
    }

    if (command === "approve" && subcommand === "completion") {
      return approveCompletionCommand(rest);
    }

    console.error(`Unknown command: ${argv.join(" ")}`);
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function printHelp(): void {
  console.log(`Atlas ${version}

Usage:
  atlas init --yes
  atlas start --manual --title <title> --objective <objective> [--task-key <key>]
  atlas context import <file>
  atlas plan
  atlas contract import <file>
  atlas approve contract --yes
  atlas implement export --manual
  atlas execution import <file>
  atlas checks run
  atlas review prepare
  atlas review import <file>
  atlas findings disposition <id> --resolve --reason <reason>
  atlas complete --check
  atlas approve completion --yes
  atlas pause
  atlas resume
  atlas archive
  atlas unarchive
  atlas cancel --yes --reason <reason>
  atlas status
`);
}

function initCommand(args: string[]): number {
  const yes = args.includes("--yes");
  if (!yes) {
    console.error("atlas init requires --yes in the walking skeleton");
    return 2;
  }

  const configPath = join(process.cwd(), "atlas.config.json");
  if (existsSync(configPath)) {
    console.log(`Project config already exists: ${configPath}`);
    return 0;
  }

  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        $schema: "./atlas.config.schema.json",
        schemaVersion: 1,
        project: {
          name: "atlas-project",
          baseBranch: "main"
        },
        telemetry: {
          enabled: false
        }
      },
      null,
      2
    )}\n`
  );
  console.log(`Created ${configPath}`);
  return 0;
}

async function startManualCommand(args: string[]): Promise<number> {
  const title = readOption(args, "--title");
  const objective = readOption(args, "--objective");
  const taskKey = readOption(args, "--task-key", false);

  if (title === undefined || objective === undefined) {
    console.error("atlas start --manual requires --title and --objective");
    return 2;
  }

  const result = await startManualTask({ title, objective, taskKey });
  console.log(
    `${result.resumedExisting ? "Resumed" : "Created"} session ${result.session.sessionId} (${result.session.primaryState})`
  );
  console.log(`Task brief: ${result.taskBriefArtifactId || "existing"}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function statusCommand(): Promise<number> {
  const status = await getStatus();
  if (status.session === undefined) {
    console.log("No Atlas session found for this repository.");
    console.log(`Next: ${status.nextCommands[0]}`);
    return 0;
  }

  console.log(`Session: ${status.session.sessionId}`);
  console.log(`State: ${status.session.primaryState}`);
  console.log(`Artifacts: ${status.artifactCount}`);
  console.log(`Events: ${status.eventCount}`);
  console.log(`Next: ${status.nextCommands[0] ?? "no next command"}`);
  return 0;
}

async function pauseCommand(): Promise<number> {
  const result = await pauseSession();
  console.log(`Session: ${result.session.sessionId}`);
  console.log("Paused: yes");
  console.log(`State: ${result.session.primaryState}`);
  console.log(`Next: ${result.nextCommand ?? "no next command"}`);
  return 0;
}

async function resumeCommand(): Promise<number> {
  const status = await getStatus();
  if (status.session?.paused !== true) {
    return statusCommand();
  }

  const result = await resumePausedSession();
  const next = await getStatus();
  console.log(`Session: ${result.session.sessionId}`);
  console.log("Paused: no");
  console.log(`State: ${result.session.primaryState}`);
  console.log(`Next: ${next.nextCommands[0] ?? "no next command"}`);
  return 0;
}

async function archiveCommand(): Promise<number> {
  const result = await archiveSession();
  console.log(`Session: ${result.session.sessionId}`);
  console.log("Archived: yes");
  console.log(`State: ${result.session.primaryState}`);
  console.log(`Next: ${result.nextCommand ?? "no next command"}`);
  return 0;
}

async function unarchiveCommand(): Promise<number> {
  const result = await unarchiveSession();
  const next = await getStatus();
  console.log(`Session: ${result.session.sessionId}`);
  console.log("Archived: no");
  console.log(`State: ${result.session.primaryState}`);
  console.log(`Next: ${next.nextCommands[0] ?? "no next command"}`);
  return 0;
}

async function cancelCommand(args: string[]): Promise<number> {
  if (!args.includes("--yes")) {
    console.error("atlas cancel requires --yes in the walking skeleton");
    return 2;
  }

  const result = await cancelSession({ reason: readOption(args, "--reason", false) });
  console.log(`Session: ${result.session.sessionId}`);
  console.log("Disposition: cancelled");
  console.log(`State: ${result.session.primaryState}`);
  console.log("Next: no next command");
  return 0;
}

async function contextImportCommand(args: string[]): Promise<number> {
  const filePath = args[0];
  if (filePath === undefined) {
    console.error("atlas context import requires a file path");
    return 2;
  }

  const result = await importContextManifest({ filePath });
  console.log(`Imported context ${result.contextArtifactId}`);
  console.log(`Session: ${result.sessionId}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function planCommand(): Promise<number> {
  const result = await exportPlanningPackage();
  console.log(`Planning package: ${result.planningArtifactId}`);
  console.log(`Session: ${result.sessionId}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function contractImportCommand(args: string[]): Promise<number> {
  const filePath = args[0];
  if (filePath === undefined) {
    console.error("atlas contract import requires a file path");
    return 2;
  }

  const result = await importContract({ filePath });
  console.log(`Contract: ${result.contractArtifactId}`);
  console.log(`Session: ${result.sessionId}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function approveContractCommand(args: string[]): Promise<number> {
  if (!args.includes("--yes")) {
    console.error("atlas approve contract requires --yes in the walking skeleton");
    return 2;
  }

  const result = await approveContract();
  console.log(`Approved contract: ${result.contractArtifactId}`);
  console.log(`Approval: ${result.approvalId}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function implementExportManualCommand(): Promise<number> {
  const result = await exportManualAgentPackage();
  console.log(`Agent package: ${result.packageArtifactId}`);
  console.log(`Session: ${result.sessionId}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function executionImportCommand(args: string[]): Promise<number> {
  const filePath = args[0];
  if (filePath === undefined) {
    console.error("atlas execution import requires a file path");
    return 2;
  }

  const result = await importExecutionResult({ filePath });
  console.log(`Execution report: ${result.executionReportArtifactId}`);
  console.log(`Process status: ${result.processStatus}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function checksRunCommand(): Promise<number> {
  const result = await runBasicCheck();
  console.log(`Check result: ${result.checkResultArtifactId}`);
  console.log(`Status: ${result.status}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function reviewPrepareCommand(): Promise<number> {
  const result = await prepareReviewPackage();
  console.log(`Review package: ${result.reviewPackageArtifactId}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function reviewImportCommand(args: string[]): Promise<number> {
  const filePath = args[0];
  if (filePath === undefined) {
    console.error("atlas review import requires a file path");
    return 2;
  }

  const result = await importReviewReport({ filePath });
  console.log(`Review report: ${result.reviewReportArtifactId}`);
  console.log(`Findings: ${result.findingIds.join(", ") || "none"}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function findingDispositionCommand(args: string[]): Promise<number> {
  const findingId = args[0];
  if (findingId === undefined) {
    console.error("atlas findings disposition requires a finding id");
    return 2;
  }
  const reason = readOption(args, "--reason") ?? "Accepted in walking skeleton";
  const disposition = args.includes("--resolve") ? "resolve" : "reject";
  const result = await disposeFinding({ findingId, disposition, reason });
  console.log(`Finding: ${result.findingId}`);
  console.log(`Status: ${result.status}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function completeCheckCommand(): Promise<number> {
  const result = await evaluateCompletion();
  console.log("Completion gates: passed");
  console.log(`Session: ${result.sessionId}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function approveCompletionCommand(args: string[]): Promise<number> {
  if (!args.includes("--yes")) {
    console.error("atlas approve completion requires --yes in the walking skeleton");
    return 2;
  }

  const result = await approveCompletion();
  console.log(`Completion report: ${result.completionReportArtifactId}`);
  console.log(`Approval: ${result.approvalId}`);
  console.log(`State: ${result.state}`);
  console.log("Next: no next command");
  return 0;
}

function readOption(args: string[], name: string, required = true): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    if (required) return undefined;
    return undefined;
  }

  return args[index + 1];
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => value !== undefined);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
