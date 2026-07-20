#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  exportPlanningPackage,
  getStatus,
  approveContract,
  approveCompletion,
  archiveSession,
  buildContextManifest,
  cancelSession,
  exportManualAgentPackage,
  disposeFinding,
  evaluateCompletion,
  invokeImplementationAgent,
  runBasicCheck,
  runAiContextScout,
  runDoctor,
  importContextManifest,
  importContract,
  importExecutionResult,
  importReviewReport,
  orchestrateRun,
  pauseSession,
  prepareReviewPackage,
  prepareFixBatch,
  recordDecision,
  recordAdapterWriteback,
  resumePausedSession,
  unarchiveSession,
  startLinearIssueTask,
  startManualTask
} from "@atlas/app-services";
import { getClaudeCodeAdapterHealth } from "@atlas/adapters-claude-code";
import { getCodexAdapterHealth } from "@atlas/adapters-codex";
import { fetchFigmaFileSnapshot, getFigmaAdapterHealth, parseFigmaReference, readFigmaFixture } from "@atlas/adapters-figma";
import {
  commentGitHubPullRequest,
  fetchGitHubRepositorySnapshot,
  getGitHubAdapterHealth,
  parseGitHubReference,
  readGitHubFixture
} from "@atlas/adapters-github";
import {
  commentLinearIssue,
  fetchLinearIssue,
  getLinearAdapterHealth,
  isLinearIssueKey,
  readLinearIssueFixture
} from "@atlas/adapters-linear";
import { scanDesignPolicies } from "@atlas/checks";
import { createTelemetryPreview, telemetryEnabled } from "@atlas/diagnostics";
import { AtlasError } from "@atlas/domain";
import { preflightGitBranch, readGitRepositoryFacts, summarizeGitDiffSafeguards } from "@atlas/git";
import {
  defaultOllamaProvider,
  getAiProviderHealth,
  listAiModels,
  type AiProviderConfig
} from "@atlas/llm";
import {
  getCredentialToken,
  listCredentials,
  removeCredential,
  storeCredential,
  type CredentialProvider
} from "@atlas/security";

const version = "0.0.0";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    argv = normalizeArgv(argv);
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
      return await startManualCommand(rest);
    }

    if (command === "start" && subcommand !== undefined && isLinearIssueKey(subcommand)) {
      return await startLinearCommand(subcommand);
    }

    if (command === "status") {
      return await statusCommand();
    }

    if (command === "doctor") {
      return await doctorCommand();
    }

    if (command === "auth" && subcommand === "add") {
      return authAddCommand(rest);
    }

    if (command === "auth" && subcommand === "list") {
      return authListCommand();
    }

    if (command === "auth" && subcommand === "remove") {
      return authRemoveCommand(rest);
    }

    if (command === "adapters" && subcommand === "health") {
      return adaptersHealthCommand();
    }

    if (command === "ai") {
      return await aiCommand(compact([subcommand, ...rest]));
    }

    if (command === "telemetry") {
      return telemetryCommand(compact([subcommand, ...rest]));
    }

    if (command === "orchestrate" && subcommand === "run") {
      return await orchestrateRunCommand(rest);
    }

    if (command === "writebacks" && subcommand === "run") {
      return await writebacksRunCommand(rest);
    }

    if (command === "git" && subcommand === "status") {
      return gitStatusCommand();
    }

    if (command === "git" && subcommand === "preflight") {
      return gitPreflightCommand(rest);
    }

    if (command === "git" && subcommand === "diff-safeguards") {
      return gitDiffSafeguardsCommand(rest);
    }

    if (command === "linear" && subcommand === "inspect") {
      return linearInspectCommand(rest);
    }

    if (command === "figma" && subcommand === "inspect") {
      return await figmaInspectCommand(rest);
    }

    if (command === "decisions" && subcommand === "record") {
      return await decisionsRecordCommand(rest);
    }

    if (command === "github" && subcommand === "inspect") {
      return await githubInspectCommand(rest);
    }

    if (command === "resume") {
      return await resumeCommand();
    }

    if (command === "pause") {
      return await pauseCommand();
    }

    if (command === "archive") {
      return await archiveCommand();
    }

    if (command === "unarchive") {
      return await unarchiveCommand();
    }

    if (command === "cancel") {
      return await cancelCommand(compact([subcommand, ...rest]));
    }

    if (command === "context" && subcommand === "import") {
      return await contextImportCommand(rest);
    }

    if (command === "context" && subcommand === "build") {
      return await contextBuildCommand(rest);
    }

    if (command === "plan") {
      return await planCommand(compact([subcommand, ...rest]));
    }

    if (command === "contract" && subcommand === "import") {
      return await contractImportCommand(rest);
    }

    if (command === "approve" && subcommand === "contract") {
      return await approveContractCommand(rest);
    }

    if (command === "implement" && subcommand === "export" && rest.includes("--manual")) {
      return await implementExportManualCommand();
    }

    if (command === "implement" && subcommand === "--agent") {
      return await implementAgentCommand(rest);
    }

    if (command === "execution" && subcommand === "import") {
      return await executionImportCommand(rest);
    }

    if (command === "checks" && subcommand === "run") {
      return await checksRunCommand();
    }

    if (command === "checks" && subcommand === "design-scan") {
      return checksDesignScanCommand(rest);
    }

    if (command === "review" && subcommand === "prepare") {
      return await reviewPrepareCommand();
    }

    if (command === "review" && subcommand === "import") {
      return await reviewImportCommand(rest);
    }

    if (command === "findings" && subcommand === "disposition") {
      return await findingDispositionCommand(rest);
    }

    if (command === "fix" && subcommand === "prepare") {
      return await fixPrepareCommand();
    }

    if (command === "complete" && subcommand === "--check") {
      return await completeCheckCommand();
    }

    if (command === "approve" && subcommand === "completion") {
      return await approveCompletionCommand(rest);
    }

    console.error(`Unknown command: ${argv.join(" ")}`);
    return 2;
  } catch (error) {
    return reportCliError(error);
  }
}

function normalizeArgv(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

function reportCliError(error: unknown): number {
  if (error instanceof AtlasError) {
    console.error(error.message);
    if (error.details !== undefined) {
      const failures = error.details.failures;
      if (Array.isArray(failures)) {
        for (const failure of failures) console.error(`- ${String(failure)}`);
      }
      const checkResultArtifactId = error.details.checkResultArtifactId;
      if (typeof checkResultArtifactId === "string") {
        console.error(`Check result: ${checkResultArtifactId}`);
      }
    }
    return error.exitCode;
  }

  console.error(error instanceof Error ? error.message : String(error));
  return 1;
}

function printHelp(): void {
  console.log(`Atlas ${version}

Usage:
  atlas init --yes
  atlas start --manual --title <title> --objective <objective> [--task-key <key>]
  atlas start <LINEAR-ISSUE-KEY>
  atlas context import <file>
  atlas context build [--ai] [--ai-provider <alias>] [--max-files <n>] [--max-bytes <n>]
  atlas decisions record --kind <decision|deviation> --title <title> --rationale <text> --category <category> --yes
  atlas plan [--ai] [--ai-provider <alias>]
  atlas contract import <file>
  atlas approve contract --yes
  atlas implement export --manual
  atlas implement --agent <codex|claude>
  atlas execution import <file>
  atlas checks run
  atlas checks design-scan [--root <path>]
  atlas review prepare
  atlas review import <file>
  atlas findings disposition <id> --resolve --reason <reason>
  atlas fix prepare
  atlas complete --check
  atlas approve completion --yes
  atlas pause
  atlas resume
  atlas archive
  atlas unarchive
  atlas cancel --yes --reason <reason>
  atlas git status
  atlas git preflight [--base <branch>] [--target <branch>] [--allow-dirty]
  atlas git diff-safeguards [--base <ref>]
  atlas figma inspect <figma-url|fixture.json>
  atlas github inspect <github-url|fixture.json>
  atlas linear inspect <fixture.json>
  atlas status
  atlas doctor
  atlas auth add --provider <figma|github|linear|ai> --alias <alias> --value-env <ENV_VAR>
  atlas auth list
  atlas auth remove --alias <alias>
  atlas adapters health
  atlas ai providers health
  atlas ai models [--provider <alias>]
  atlas orchestrate run --until <context-ready|planning-ready|checks-completed|completion-ready>
  atlas writebacks run --provider <linear|github|figma> --target <id|url> --summary <text> [--dry-run|--yes]
  atlas telemetry status
  atlas telemetry preview
  atlas telemetry enable
  atlas telemetry disable
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

async function startLinearCommand(issueKey: string): Promise<number> {
  const config = readAtlasConfig();
  const tokenAlias = config.adapters?.linear?.tokenAlias ?? "linear.default";
  const token = getCredentialToken({ alias: tokenAlias, provider: "linear" });
  if (token === undefined) {
    console.error(`Linear credential alias is missing: ${tokenAlias}`);
    console.error(`Next: atlas auth add --provider linear --alias ${tokenAlias} --value-env LINEAR_API_KEY`);
    return 2;
  }

  const issue = await fetchLinearIssue({ apiKey: token, issueKey });
  const result = await startLinearIssueTask({ issue });
  console.log(`${result.resumedExisting ? "Resumed" : "Created"} Linear session ${result.session.sessionId} (${result.session.primaryState})`);
  console.log(`Issue: ${issue.issueKey}`);
  console.log(`Title: ${issue.title}`);
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

async function doctorCommand(): Promise<number> {
  const result = await runDoctor();
  console.log(`Doctor: ${result.status}`);
  console.log(`Session: ${result.sessionId ?? "(none)"}`);
  console.log(`Artifacts: ${result.artifactCount}`);
  console.log(`Issues: ${result.issues.length}`);
  for (const issue of result.issues) {
    console.log(`${issue.severity.toUpperCase()} ${issue.code}: ${issue.summary}`);
    console.log(`Recovery: ${issue.recovery}`);
  }
  return result.status === "passed" ? 0 : 1;
}

function authAddCommand(args: string[]): number {
  const provider = readCredentialProvider(readOption(args, "--provider"));
  const alias = readOption(args, "--alias");
  const valueEnv = readOption(args, "--value-env");
  if (provider === undefined || alias === undefined || valueEnv === undefined) {
    console.error("atlas auth add requires --provider, --alias, and --value-env");
    return 2;
  }
  const token = process.env[valueEnv];
  if (token === undefined || token.length === 0) {
    console.error(`Environment variable is not set or empty: ${valueEnv}`);
    return 2;
  }

  const record = storeCredential({ provider, alias, token });
  console.log(`Credential: ${record.alias}`);
  console.log(`Provider: ${record.provider}`);
  console.log(`Token hash: ${record.tokenHash.slice(0, 12)}...`);
  return 0;
}

function authListCommand(): number {
  const credentials = listCredentials();
  if (credentials.length === 0) {
    console.log("No credentials stored.");
    return 0;
  }
  for (const credential of credentials) {
    console.log(`${credential.alias} ${credential.provider} ${credential.tokenHash.slice(0, 12)}...`);
  }
  return 0;
}

function authRemoveCommand(args: string[]): number {
  const alias = readOption(args, "--alias");
  if (alias === undefined) {
    console.error("atlas auth remove requires --alias");
    return 2;
  }
  const removed = removeCredential({ alias });
  console.log(removed ? `Removed credential: ${alias}` : `Credential not found: ${alias}`);
  return removed ? 0 : 1;
}

function adaptersHealthCommand(): number {
  const config = readAtlasConfig();
  const figmaToken = tokenForConfiguredAlias(config.adapters?.figma?.tokenAlias, "figma");
  const githubToken = tokenForConfiguredAlias(config.adapters?.github?.tokenAlias, "github");
  const linearToken = tokenForConfiguredAlias(config.adapters?.linear?.tokenAlias, "linear");
  const health = [
    getFigmaAdapterHealth({ apiKey: figmaToken }),
    getGitHubAdapterHealth({ token: githubToken }),
    getLinearAdapterHealth({ apiKey: linearToken }),
    getCodexAdapterHealth({ command: config.adapters?.codex?.command }),
    getClaudeCodeAdapterHealth({ command: config.adapters?.claudeCode?.command })
  ];
  for (const adapter of health) {
    const configured = adapter.configured ? "configured" : "not-configured";
    const mode = "mode" in adapter ? ` ${adapter.mode}` : "";
    console.log(`${adapter.provider}: ${configured}${mode}`);
  }
  return health.every((adapter) => adapter.configured) ? 0 : 1;
}

async function aiCommand(args: string[]): Promise<number> {
  const [scope, action, ...rest] = args;
  if (scope === "providers" && action === "health") {
    return await aiProvidersHealthCommand();
  }
  if (scope === "models") {
    return await aiModelsCommand([action, ...rest].filter((value): value is string => value !== undefined));
  }

  console.error("atlas ai requires providers health or models");
  return 2;
}

async function aiProvidersHealthCommand(): Promise<number> {
  const providers = readConfiguredAiProviders();
  if (providers.length === 0) {
    const defaultProvider = defaultOllamaProvider();
    console.log(`${defaultProvider.alias}: not-configured ${defaultProvider.provider} add ai.providers to atlas.config.json`);
    return 1;
  }

  const health = await Promise.all(
    providers.map((provider) =>
      getAiProviderHealth(provider, { apiKey: tokenForConfiguredAlias(provider.tokenAlias, "ai") })
    )
  );
  for (const provider of health) {
    const configured = provider.configured ? "configured" : "not-configured";
    console.log(`${provider.alias}: ${configured} ${provider.provider} ${provider.model} ${provider.detail}`);
  }
  return health.every((provider) => provider.configured) ? 0 : 1;
}

async function aiModelsCommand(args: string[]): Promise<number> {
  const providers = readConfiguredAiProviders();
  const alias = readOption(args, "--provider", false) ?? readAtlasConfig().ai?.defaultProviderAlias;
  const provider = alias === undefined ? providers[0] : providers.find((candidate) => candidate.alias === alias);
  if (provider === undefined) {
    console.error(alias === undefined ? "No AI provider configured" : `AI provider not configured: ${alias}`);
    return 2;
  }

  const models = await listAiModels(provider, { apiKey: tokenForConfiguredAlias(provider.tokenAlias, "ai") });
  for (const model of models) {
    console.log(`${model.name}${model.modifiedAt === undefined ? "" : ` ${model.modifiedAt}`}`);
  }
  return 0;
}

function telemetryCommand(args: string[]): number {
  const action = args[0];
  if (action === "status") {
    const config = readAtlasConfig();
    console.log(`Telemetry: ${telemetryEnabled(config.telemetry) ? "enabled" : "disabled"}`);
    console.log("Mode: local config, content-free operational metadata only");
    return 0;
  }

  if (action === "preview") {
    console.log(JSON.stringify(createTelemetryPreview(version), null, 2));
    return 0;
  }

  if (action === "enable" || action === "disable") {
    const enabled = action === "enable";
    writeAtlasConfig({ ...readAtlasConfig(), telemetry: { enabled } });
    console.log(`Telemetry: ${enabled ? "enabled" : "disabled"}`);
    return 0;
  }

  console.error("atlas telemetry requires status, preview, enable, or disable");
  return 2;
}

function gitStatusCommand(): number {
  const facts = readGitRepositoryFacts();
  console.log(`Root: ${facts.rootPath}`);
  console.log(`Branch: ${facts.branch ?? "(detached)"}`);
  console.log(`HEAD: ${facts.headSha ?? "(unborn)"}`);
  console.log(`Dirty: ${facts.status.isDirty ? "yes" : "no"}`);
  console.log(`Changed files: ${facts.status.changedFileCount}`);
  console.log(`Staged: ${facts.status.hasStagedChanges ? "yes" : "no"}`);
  console.log(`Unstaged: ${facts.status.hasUnstagedChanges ? "yes" : "no"}`);
  console.log(`Untracked: ${facts.status.hasUntrackedFiles ? "yes" : "no"}`);
  return 0;
}

function gitPreflightCommand(args: string[]): number {
  const baseBranch = readOption(args, "--base", false) ?? readConfiguredBaseBranch();
  const targetBranch = readOption(args, "--target", false);
  const result = preflightGitBranch({
    baseBranch,
    targetBranch,
    requireClean: !args.includes("--allow-dirty")
  });

  console.log(`Repo: ${result.facts.rootPath}`);
  console.log(`Branch: ${result.facts.branch ?? "(detached)"}`);
  console.log(`HEAD: ${result.facts.headSha ?? "(unborn)"}`);
  for (const check of result.checks) {
    console.log(`${labelForCheckStatus(check.status)} ${check.summary}`);
  }
  console.log(`Result: ${result.passed ? "pass" : "fail"}`);
  return result.passed ? 0 : 1;
}

function gitDiffSafeguardsCommand(args: string[]): number {
  const result = summarizeGitDiffSafeguards({
    baseRef: readOption(args, "--base", false)
  });
  console.log(`Base: ${result.baseRef}`);
  console.log(`Files: ${result.totalFiles}`);
  console.log(`Line changes: ${result.totalLineChanges}`);
  console.log(`Binary: ${result.hasBinary ? "yes" : "no"}`);
  console.log(`Secret risk: ${result.hasSecretRisk ? "yes" : "no"}`);
  console.log(`Truncated: ${result.truncated ? "yes" : "no"}`);
  console.log(`Reviewable: ${result.reviewable ? "yes" : "no"}`);
  return result.reviewable ? 0 : 1;
}

function linearInspectCommand(args: string[]): number {
  const filePath = args[0];
  if (filePath === undefined) {
    console.error("atlas linear inspect requires a fixture path");
    return 2;
  }

  const issue = readLinearIssueFixture(filePath);
  console.log(`Issue: ${issue.issueKey}`);
  console.log(`Title: ${issue.title}`);
  console.log(`State: ${issue.state ?? "(unknown)"}`);
  console.log(`Priority: ${issue.priority ?? "(unknown)"}`);
  console.log(`Labels: ${issue.labels.join(", ") || "(none)"}`);
  console.log(`Comments: ${issue.comments.length}`);
  console.log(`Links: ${issue.links.length}`);
  return 0;
}

async function figmaInspectCommand(args: string[]): Promise<number> {
  const input = args[0];
  if (input === undefined) {
    console.error("atlas figma inspect requires a Figma URL or fixture path");
    return 2;
  }

  if (existsSync(input)) {
    const snapshot = readFigmaFixture(input);
    console.log(`File: ${snapshot.fileKey}`);
    console.log(`Name: ${snapshot.name ?? "(unknown)"}`);
    console.log(`Node: ${snapshot.nodeId ?? "(none)"}`);
    console.log(`Evidence: ${snapshot.evidence.length}`);
    return 0;
  }

  const reference = parseFigmaReference(input);
  const config = readAtlasConfig();
  const token = getCredentialToken({ alias: config.adapters?.figma?.tokenAlias ?? "figma.default", provider: "figma" });
  if (token !== undefined) {
    const snapshot = await fetchFigmaFileSnapshot({ apiKey: token, reference });
    console.log(`File: ${snapshot.fileKey}`);
    console.log(`Name: ${snapshot.name ?? "(unknown)"}`);
    console.log(`Node: ${snapshot.nodeId ?? "(none)"}`);
    console.log(`Evidence: ${snapshot.evidence.length}`);
    return 0;
  }

  console.log(`Kind: ${reference.kind}`);
  console.log(`File: ${reference.fileKey}`);
  console.log(`Node: ${reference.nodeId ?? "(none)"}`);
  console.log(`URL: ${reference.url}`);
  return 0;
}

async function githubInspectCommand(args: string[]): Promise<number> {
  const input = args[0];
  if (input === undefined) {
    console.error("atlas github inspect requires a GitHub URL or fixture path");
    return 2;
  }

  if (existsSync(input)) {
    const snapshot = readGitHubFixture(input);
    console.log(`Repository: ${snapshot.owner}/${snapshot.repo}`);
    console.log(`Default branch: ${snapshot.defaultBranch ?? "(unknown)"}`);
    console.log(`Pull requests: ${snapshot.pullRequests.length}`);
    return 0;
  }

  const reference = parseGitHubReference(input);
  const config = readAtlasConfig();
  const token = getCredentialToken({ alias: config.adapters?.github?.tokenAlias ?? "github.default", provider: "github" });
  if (token !== undefined) {
    const snapshot = await fetchGitHubRepositorySnapshot({ token, reference });
    console.log(`Repository: ${snapshot.owner}/${snapshot.repo}`);
    console.log(`Default branch: ${snapshot.defaultBranch ?? "(unknown)"}`);
    console.log(`Pull requests: ${snapshot.pullRequests.length}`);
    return 0;
  }

  console.log(`Kind: ${reference.kind}`);
  console.log(`Repository: ${reference.owner}/${reference.repo}`);
  console.log(`Number: ${reference.number ?? "(none)"}`);
  console.log(`URL: ${reference.url}`);
  return 0;
}

async function decisionsRecordCommand(args: string[]): Promise<number> {
  if (!args.includes("--yes")) {
    console.error("atlas decisions record requires --yes");
    return 2;
  }
  const kind = readOption(args, "--kind");
  const title = readOption(args, "--title");
  const rationale = readOption(args, "--rationale");
  const category = readOption(args, "--category");
  if (
    (kind !== "decision" && kind !== "deviation") ||
    title === undefined ||
    rationale === undefined ||
    !isMaterialCategory(category)
  ) {
    console.error("atlas decisions record requires --kind, --title, --rationale, and valid --category");
    return 2;
  }

  const result = await recordDecision({ kind, title, rationale, category });
  console.log(`Decision: ${result.decisionId}`);
  console.log(`Artifact: ${result.artifactId}`);
  console.log(`Kind: ${result.kind}`);
  console.log(`Session: ${result.sessionId}`);
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

async function contextBuildCommand(args: string[]): Promise<number> {
  const maxFiles = readNumberOption(args, "--max-files");
  const maxBytes = readNumberOption(args, "--max-bytes");
  const useAi = args.includes("--ai");
  const aiProviderAlias = readOption(args, "--ai-provider", false);
  const status = await getStatus();
  if (status.session !== undefined && status.session.primaryState !== "intake_ready") {
    console.error(`atlas context build requires state intake_ready; current state is ${status.session.primaryState}`);
    console.log(`Next: ${status.nextCommands[0] ?? "no next command"}`);
    return 2;
  }

  let aiRecommendationArtifactId: string | undefined;
  if (useAi) {
    const providers = readConfiguredAiProviders();
    const alias = aiProviderAlias ?? readAtlasConfig().ai?.defaultProviderAlias;
    const provider = alias === undefined ? providers[0] : providers.find((candidate) => candidate.alias === alias);
    if (provider === undefined) {
      console.error(alias === undefined ? "No AI provider configured" : `AI provider not configured: ${alias}`);
      return 2;
    }
    try {
      console.log(`AI scout: ${provider.alias} ${provider.model}`);
      const scout = await runAiContextScout({
        provider,
        apiKey: tokenForConfiguredAlias(provider.tokenAlias, "ai"),
        ...(maxFiles === undefined ? {} : { maxFiles }),
        ...(maxBytes === undefined ? {} : { maxBytes })
      });
      aiRecommendationArtifactId = scout.recommendationArtifactId;
      console.log(`AI recommendation: ${scout.recommendationArtifactId}`);
      console.log(`AI recommendations: ${scout.recommendationCount}`);
    } catch (error) {
      console.error(`AI scout unavailable; falling back to deterministic context: ${errorMessage(error)}`);
    }
  }
  const result = await buildContextManifest({
    ...(maxFiles === undefined ? {} : { maxFiles }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(aiRecommendationArtifactId === undefined ? {} : { aiRecommendationArtifactId })
  });
  console.log(`Built context ${result.contextArtifactId}`);
  console.log(`Context quality: ${result.contextReadiness}`);
  console.log(`Context quality report: ${result.contextQualityReportArtifactId}`);
  console.log(`Session: ${result.sessionId}`);
  console.log(`Sources: ${result.includedSourceCount}/${result.sourceCount}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function planCommand(args: string[]): Promise<number> {
  const useAi = args.includes("--ai");
  const aiProviderAlias = readOption(args, "--ai-provider", false);
  const provider = useAi ? readConfiguredAiProvider(aiProviderAlias) : undefined;
  if (useAi && provider === undefined) {
    console.error(aiProviderAlias === undefined ? "No AI provider configured" : `AI provider not configured: ${aiProviderAlias}`);
    return 2;
  }
  const result = await exportPlanningPackage({
    ...(provider === undefined
      ? {}
      : {
          ai: {
            provider,
            apiKey: tokenForConfiguredAlias(provider.tokenAlias, "ai")
          }
        })
  });
  console.log(`Planning package: ${result.planningArtifactId}`);
  if (result.aiPlanningDraftArtifactId !== undefined) {
    console.log(`AI planning draft: ${result.aiPlanningDraftArtifactId}`);
  }
  console.log(`Session: ${result.sessionId}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function orchestrateRunCommand(args: string[]): Promise<number> {
  const until = readOrchestrateUntil(readOption(args, "--until"));
  if (until === undefined) {
    console.error("atlas orchestrate run requires --until <context-ready|planning-ready|checks-completed|completion-ready>");
    return 2;
  }

  const config = readAtlasConfig();
  const agentProvider =
    config.adapters?.codex?.command !== undefined
      ? "codex"
      : config.adapters?.claudeCode?.command !== undefined
        ? "claude"
        : undefined;
  const agentCommand =
    agentProvider === "codex"
      ? config.adapters?.codex?.command
      : agentProvider === "claude"
        ? config.adapters?.claudeCode?.command
        : undefined;
  const result = await orchestrateRun({ until, agentProvider, agentCommand });
  console.log(`Orchestration: ${result.orchestrationRunArtifactId}`);
  console.log(`Status: ${result.status}`);
  console.log(`State: ${result.state}`);
  console.log(`Steps: ${result.steps.length}`);
  if (result.blockedReason !== undefined) {
    console.log(`Blocked: ${result.blockedReason}`);
  }
  return result.status === "succeeded" ? 0 : 1;
}

async function writebacksRunCommand(args: string[]): Promise<number> {
  const provider = readWritebackProvider(readOption(args, "--provider"));
  const target = readOption(args, "--target");
  const summary = readOption(args, "--summary");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  if (provider === undefined || target === undefined || summary === undefined || (!dryRun && !yes)) {
    console.error("atlas writebacks run requires --provider, --target, --summary, and --dry-run or --yes");
    return 2;
  }

  if (dryRun) {
    const result = await recordAdapterWriteback({
      provider,
      mode: "dry-run",
      status: "prepared",
      target,
      summary,
      evidence: provider === "figma" ? [target] : []
    });
    console.log(`Writeback: ${result.writebackArtifactId}`);
    console.log(`Provider: ${result.provider}`);
    console.log("Status: prepared");
    return 0;
  }

  const config = readAtlasConfig();
  if (config.writebacks?.enabled !== true) {
    console.error("Real adapter writebacks require writebacks.enabled: true in atlas.config.json");
    return 2;
  }
  if (provider === "linear") {
    const tokenAlias = config.adapters?.linear?.tokenAlias ?? "linear.default";
    const token = getCredentialToken({ alias: tokenAlias, provider: "linear" });
    if (token === undefined) {
      console.error(`Linear credential alias is missing: ${tokenAlias}`);
      return 2;
    }
    const written = await commentLinearIssue({ apiKey: token, issueId: target, body: summary });
    const result = await recordAdapterWriteback({
      provider,
      mode: "write",
      status: "written",
      target,
      summary,
      remoteId: written.remoteId
    });
    console.log(`Writeback: ${result.writebackArtifactId}`);
    console.log("Status: written");
    return 0;
  }

  if (provider === "github") {
    const tokenAlias = config.adapters?.github?.tokenAlias ?? "github.default";
    const token = getCredentialToken({ alias: tokenAlias, provider: "github" });
    if (token === undefined) {
      console.error(`GitHub credential alias is missing: ${tokenAlias}`);
      return 2;
    }
    const written = await commentGitHubPullRequest({ token, reference: parseGitHubReference(target), body: summary });
    const result = await recordAdapterWriteback({
      provider,
      mode: "write",
      status: "written",
      target,
      summary,
      remoteUrl: written.remoteUrl
    });
    console.log(`Writeback: ${result.writebackArtifactId}`);
    console.log("Status: written");
    return 0;
  }

  const result = await recordAdapterWriteback({
    provider,
    mode: "dry-run",
    status: "prepared",
    target,
    summary,
    evidence: [target]
  });
  console.log(`Writeback: ${result.writebackArtifactId}`);
  console.log("Status: prepared");
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

async function implementAgentCommand(args: string[]): Promise<number> {
  const provider = args[0];
  if (provider !== "codex" && provider !== "claude") {
    console.error("atlas implement --agent requires codex or claude");
    return 2;
  }

  const config = readAtlasConfig();
  const command = provider === "claude" ? config.adapters?.claudeCode?.command : config.adapters?.codex?.command;
  const result = await invokeImplementationAgent({ provider, command });
  console.log(`Agent: ${result.provider}`);
  console.log(`Package: ${result.packageArtifactId}`);
  console.log(`Agent run log: ${result.agentRunLogArtifactId}`);
  console.log(`Execution report: ${result.executionReportArtifactId}`);
  console.log(`Process: ${result.processStatus}`);
  console.log(`Agent claims complete: ${result.agentClaimsComplete ? "yes" : "no"}`);
  console.log(`Changed files: ${result.changedFiles.length}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return result.processStatus === "succeeded" ? 0 : 1;
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
  console.log(`Checks: ${result.checkCount}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

function checksDesignScanCommand(args: string[]): number {
  const rootDir = readOption(args, "--root", false) ?? process.cwd();
  const result = scanDesignPolicies({ rootDir });
  console.log(`Design scan: ${result.status}`);
  console.log(`Files: ${result.scannedFiles}`);
  console.log(`Violations: ${result.violations.length}`);
  for (const violation of result.violations.slice(0, 20)) {
    console.log(`${violation.filePath}:${violation.line}:${violation.column} ${violation.ruleId} ${violation.description}`);
  }
  return result.status === "passed" ? 0 : 1;
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

async function fixPrepareCommand(): Promise<number> {
  const result = await prepareFixBatch();
  console.log(`Fix batch: ${result.fixBatchArtifactId}`);
  console.log(`Findings: ${result.findingIds.join(", ")}`);
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

function readNumberOption(args: string[], name: string): number | undefined {
  const value = readOption(args, name, false);
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && Number.isInteger(number) && number > 0 ? number : undefined;
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => value !== undefined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readConfiguredBaseBranch(): string | undefined {
  const configPath = join(process.cwd(), "atlas.config.json");
  if (!existsSync(configPath)) return undefined;

  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      project?: { baseBranch?: unknown };
    };
    return typeof config.project?.baseBranch === "string" && config.project.baseBranch.length > 0
      ? config.project.baseBranch
      : undefined;
  } catch {
    return undefined;
  }
}

interface AtlasCliConfig {
  readonly schemaVersion?: number | undefined;
  readonly project?: { readonly name?: string | undefined; readonly baseBranch?: string | undefined } | undefined;
  readonly telemetry?: { readonly enabled?: boolean | undefined } | undefined;
  readonly writebacks?: { readonly enabled?: boolean | undefined } | undefined;
  readonly ai?: {
    readonly defaultProviderAlias?: string | undefined;
    readonly providers?: readonly Partial<AiProviderConfig>[] | undefined;
  } | undefined;
  readonly adapters?: {
    readonly figma?: { readonly tokenAlias?: string | undefined } | undefined;
    readonly github?: { readonly tokenAlias?: string | undefined } | undefined;
    readonly linear?: { readonly tokenAlias?: string | undefined } | undefined;
    readonly codex?: { readonly command?: string | undefined } | undefined;
    readonly claudeCode?: { readonly command?: string | undefined } | undefined;
  } | undefined;
}

function readAtlasConfig(): AtlasCliConfig {
  const configPath = join(process.cwd(), "atlas.config.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as AtlasCliConfig;
  } catch {
    return {};
  }
}

function writeAtlasConfig(config: AtlasCliConfig): void {
  const next: AtlasCliConfig = {
    ...config,
    schemaVersion: config.schemaVersion ?? 1,
    project: config.project ?? { name: "atlas-project", baseBranch: "main" }
  };
  writeFileSync(join(process.cwd(), "atlas.config.json"), `${JSON.stringify(next, null, 2)}\n`);
}

function readConfiguredAiProviders(): AiProviderConfig[] {
  return (readAtlasConfig().ai?.providers ?? []).flatMap((provider) => {
    if (
      typeof provider.alias !== "string" ||
      (provider.provider !== "ollama" && provider.provider !== "openai-compatible") ||
      typeof provider.baseUrl !== "string" ||
      typeof provider.model !== "string"
    ) {
      return [];
    }

    const config: AiProviderConfig = {
      alias: provider.alias,
      provider: provider.provider,
      baseUrl: provider.baseUrl,
      model: provider.model,
      ...(typeof provider.tokenAlias === "string" ? { tokenAlias: provider.tokenAlias } : {}),
      ...(typeof provider.timeoutMs === "number" ? { timeoutMs: provider.timeoutMs } : {}),
      ...(typeof provider.maxInputTokens === "number" ? { maxInputTokens: provider.maxInputTokens } : {})
    };
    return [config];
  });
}

function readConfiguredAiProvider(alias: string | undefined): AiProviderConfig | undefined {
  const providers = readConfiguredAiProviders();
  const resolvedAlias = alias ?? readAtlasConfig().ai?.defaultProviderAlias;
  return resolvedAlias === undefined ? providers[0] : providers.find((provider) => provider.alias === resolvedAlias);
}

function readOrchestrateUntil(value: string | undefined): "context-ready" | "planning-ready" | "checks-completed" | "completion-ready" | undefined {
  return value === "context-ready" || value === "planning-ready" || value === "checks-completed" || value === "completion-ready"
    ? value
    : undefined;
}

function readWritebackProvider(value: string | undefined): "linear" | "github" | "figma" | undefined {
  return value === "linear" || value === "github" || value === "figma" ? value : undefined;
}

function tokenForConfiguredAlias(alias: string | undefined, provider: CredentialProvider): string | undefined {
  return alias === undefined ? undefined : getCredentialToken({ alias, provider });
}

function readCredentialProvider(value: string | undefined): CredentialProvider | undefined {
  return value === "figma" || value === "github" || value === "linear" || value === "ai" ? value : undefined;
}

function labelForCheckStatus(status: "pass" | "fail" | "skip"): string {
  switch (status) {
    case "pass":
      return "PASS";
    case "fail":
      return "FAIL";
    case "skip":
      return "SKIP";
  }
}

function isMaterialCategory(
  value: string | undefined
): value is "scope" | "architecture" | "data_security" | "design_constraints" | "acceptance" | "tests" | "prohibitions" {
  return (
    value === "scope" ||
    value === "architecture" ||
    value === "data_security" ||
    value === "design_constraints" ||
    value === "acceptance" ||
    value === "tests" ||
    value === "prohibitions"
  );
}

function isEntrypoint(): boolean {
  if (process.argv[1] === undefined) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  process.exitCode = await main();
}
