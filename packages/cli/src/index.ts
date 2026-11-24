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
  inspectContextManifest,
  importContract,
  importExecutionResult,
  importReviewReport,
  orchestrateRun,
  pauseSession,
  prepareReviewPackage,
  prepareFixBatch,
  recordDecision,
  recordAdapterWriteback,
  runAiVisionTest,
  resumePausedSession,
  unarchiveSession,
  startLinearIssueTask,
  startManualTask,
  showArtifactContent,
  captureVisualPage,
  compareVisualEvidence,
  importFigmaVisualEvidence,
  runAiVisualReview
} from "@sigil/app-services";
import { getClaudeCodeAdapterHealth } from "@sigil/adapters-claude-code";
import { getCodexAdapterHealth } from "@sigil/adapters-codex";
import {
  fetchFigmaFileSnapshot,
  fetchFigmaNodeImage,
  getFigmaAdapterHealth,
  parseFigmaReference,
  readFigmaFixture
} from "@sigil/adapters-figma";
import {
  commentGitHubPullRequest,
  fetchGitHubRepositorySnapshot,
  getGitHubAdapterHealth,
  parseGitHubReference,
  readGitHubFixture
} from "@sigil/adapters-github";
import {
  commentLinearIssue,
  fetchLinearIssue,
  getLinearAdapterHealth,
  isLinearIssueKey,
  readLinearIssueFixture
} from "@sigil/adapters-linear";
import { scanDesignPolicies } from "@sigil/checks";
import { createTelemetryPreview, telemetryEnabled } from "@sigil/diagnostics";
import { SigilError } from "@sigil/domain";
import { preflightGitBranch, readGitRepositoryFacts, summarizeGitDiffSafeguards } from "@sigil/git";
import {
  assertAiDataConsent,
  defaultHetznerProvider,
  defaultOllamaProvider,
  getAiProviderHealth,
  listAiModels,
  type AiProviderConfig
} from "@sigil/llm";
import {
  getCredentialToken,
  listCredentials,
  removeCredential,
  storeCredential,
  type CredentialProvider
} from "@sigil/security";

const version = readCliVersion();

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

    if (command === "artifacts" && subcommand === "show") {
      return await artifactsShowCommand(rest);
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

    if (command === "visual" && subcommand === "capture") {
      return await visualCaptureCommand(rest);
    }

    if (command === "visual" && subcommand === "compare") {
      return await visualCompareCommand(rest);
    }

    if (command === "visual" && subcommand === "review") {
      return await visualReviewCommand(rest);
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

    if (command === "figma" && subcommand === "evidence") {
      return await figmaEvidenceCommand(rest);
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

    if (command === "context" && (subcommand === "inspect" || subcommand === "summarize")) {
      return await contextInspectCommand(rest, subcommand === "summarize");
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

function readCliVersion(): string {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

function reportCliError(error: unknown): number {
  if (error instanceof SigilError) {
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
  console.log(`Sigil ${version}

Usage:
  sigil init --yes
  sigil start --manual --title <title> --objective <objective> [--task-key <key>]
  sigil start <LINEAR-ISSUE-KEY>
  sigil context import <file>
  sigil context build [--ai] [--ai-provider <alias>] [--max-files <n>] [--max-bytes <n>]
  sigil context inspect [artifact-id] [--included|--excluded|--all|--json]
  sigil context summarize [artifact-id]
  sigil decisions record --kind <decision|deviation> --title <title> --rationale <text> --category <category> --yes
  sigil plan [--ai] [--ai-provider <alias>]
  sigil contract import <file>
  sigil approve contract --yes
  sigil implement export --manual
  sigil implement --agent <codex|claude>
  sigil execution import <file>
  sigil checks run
  sigil checks design-scan [--root <path>]
  sigil review prepare
  sigil review import <file> --actor <trusted-reviewer-id>
  sigil findings disposition <id> --resolve --reason <reason> --evidence <artifact-or-reference>
  sigil fix prepare
  sigil complete --check
  sigil approve completion --yes
  sigil pause
  sigil resume
  sigil archive
  sigil unarchive
  sigil cancel --yes --reason <reason>
  sigil git status
  sigil git preflight [--base <branch>] [--target <branch>] [--allow-dirty]
  sigil git diff-safeguards [--base <ref>]
  sigil figma inspect <figma-url|fixture.json>
  sigil figma evidence <figma-url> [--image <png>] [--scale <0.01-4>]
  sigil github inspect <github-url|fixture.json>
  sigil linear inspect <fixture.json>
  sigil status
  sigil doctor
  sigil auth add --provider <figma|github|linear|ai> --alias <alias> --value-env <ENV_VAR>
  sigil auth list
  sigil auth remove --alias <alias>
  sigil adapters health
  sigil artifacts show <artifact-id>
  sigil ai providers health
  sigil ai providers add hetzner --token-alias <alias> [--alias <alias>] [--allow-cloud-code] [--allow-cloud-images]
  sigil ai models [--provider <alias>]
  sigil ai vision test <image> [--provider <alias>] [--prompt <text>]
  sigil visual capture --url <url> [--viewport <desktop|mobile|WIDTHxHEIGHT>] [--full-page]
  sigil visual compare (--reference <png>|--reference-artifact <id>) (--actual <png>|--actual-artifact <id>)
  sigil visual review --comparison <id> [--provider <alias>]
  sigil orchestrate run --until <context-ready|planning-ready|checks-completed|completion-ready>
  sigil writebacks run --provider <linear|github|figma> --target <id|url> --summary <text> [--dry-run|--yes]
  sigil telemetry status
  sigil telemetry preview
  sigil telemetry enable
  sigil telemetry disable

Context discovery uses the strict sigil.config.json "context" section. Planning and implementation require a current semantic-complete v3 manifest; legacy or stale context is repaired with sigil context build.
`);
}

function initCommand(args: string[]): number {
  const yes = args.includes("--yes");
  if (!yes) {
    console.error("sigil init requires --yes in the walking skeleton");
    return 2;
  }

  const configPath = join(process.cwd(), "sigil.config.json");
  if (existsSync(configPath)) {
    console.log(`Project config already exists: ${configPath}`);
    return 0;
  }

  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        $schema: "./sigil.config.schema.json",
        schemaVersion: 1,
        project: {
          name: "sigil-project",
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
    console.error("sigil start --manual requires --title and --objective");
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
  const config = readSigilConfig();
  const tokenAlias = config.adapters?.linear?.tokenAlias ?? "linear.default";
  const token = getCredentialToken({ alias: tokenAlias, provider: "linear" });
  if (token === undefined) {
    console.error(`Linear credential alias is missing: ${tokenAlias}`);
    console.error(`Next: sigil auth add --provider linear --alias ${tokenAlias} --value-env LINEAR_API_KEY`);
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
    console.log("No Sigil session found for this repository.");
    console.log(`Next: ${status.nextCommands[0]}`);
    return 0;
  }

  console.log(`Session: ${status.session.sessionId}`);
  console.log(`State: ${status.session.primaryState}`);
  console.log(`Artifacts: ${status.artifactCount}`);
  console.log(`Events: ${status.eventCount}`);
  if (status.context !== undefined) {
    console.log(`Context: v${status.context.schemaVersion} ${status.context.semanticComplete && status.context.fresh ? "semantic-complete/current" : "refresh-required"}`);
    if (status.context.discoveryAlgorithm !== undefined) console.log(`Context discovery: ${status.context.discoveryAlgorithm}`);
    if (status.context.effectiveConfigSha256 !== undefined) console.log(`Context config: ${status.context.effectiveConfigSha256}`);
    console.log(`Context gaps: blocking=${status.context.blockingGapCount}, warnings=${status.context.warningGapCount}, budget-pressure=${status.context.budgetPressure ? "yes" : "no"}`);
  }
  console.log(`Next: ${status.nextCommands[0] ?? "no next command"}`);
  return 0;
}

async function doctorCommand(): Promise<number> {
  const result = await runDoctor();
  console.log(`Doctor: ${result.status}`);
  console.log(`Runtime: Node.js ${result.runtimeVersion}`);
  console.log(`Data root: ${result.dataRoot}`);
  console.log(`Session: ${result.sessionId ?? "(none)"}`);
  console.log(`Artifacts: ${result.artifactCount}`);
  console.log(`Issues: ${result.issues.length}`);
  for (const issue of result.issues) {
    console.log(`${issue.severity.toUpperCase()} ${issue.code}: ${issue.summary}`);
    console.log(`Recovery: ${issue.recovery}`);
  }
  return result.status === "passed" ? 0 : 1;
}

async function artifactsShowCommand(args: string[]): Promise<number> {
  const artifactId = args[0];
  if (artifactId === undefined) {
    console.error("sigil artifacts show requires an artifact id");
    return 2;
  }

  const artifact = await showArtifactContent({ artifactId });
  if (artifact === undefined) {
    console.error(`Artifact not found: ${artifactId}`);
    return 1;
  }

  console.log(formatArtifactForDisplay(artifact.content, artifact.type, artifact.mediaType));
  return 0;
}

function authAddCommand(args: string[]): number {
  const provider = readCredentialProvider(readOption(args, "--provider"));
  const alias = readOption(args, "--alias");
  const valueEnv = readOption(args, "--value-env");
  if (provider === undefined || alias === undefined || valueEnv === undefined) {
    console.error("sigil auth add requires --provider, --alias, and --value-env");
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
    console.error("sigil auth remove requires --alias");
    return 2;
  }
  const removed = removeCredential({ alias });
  console.log(removed ? `Removed credential: ${alias}` : `Credential not found: ${alias}`);
  return removed ? 0 : 1;
}

function adaptersHealthCommand(): number {
  const config = readSigilConfig();
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
  if (scope === "providers" && action === "add" && rest[0] === "hetzner") {
    return aiProvidersAddHetznerCommand(rest.slice(1));
  }
  if (scope === "models") {
    return await aiModelsCommand([action, ...rest].filter((value): value is string => value !== undefined));
  }
  if (scope === "vision" && action === "test") {
    return await aiVisionTestCommand(rest);
  }

  console.error("sigil ai requires providers health, providers add hetzner, or models");
  return 2;
}

function aiProvidersAddHetznerCommand(args: string[]): number {
  const tokenAlias = readOption(args, "--token-alias");
  const alias = readOption(args, "--alias", false) ?? "hetzner.default";
  if (tokenAlias === undefined) {
    console.error("sigil ai providers add hetzner requires --token-alias <alias>");
    return 2;
  }

  const config = readSigilConfig();
  const provider = defaultHetznerProvider({ alias, tokenAlias });
  const providers = (config.ai?.providers ?? []).filter((candidate) => candidate.alias !== alias);
  writeSigilConfig({
    ...config,
    ai: {
      ...config.ai,
      defaultProviderAlias: alias,
      allowCloudCodeContext: args.includes("--allow-cloud-code") || config.ai?.allowCloudCodeContext === true,
      allowCloudImages: args.includes("--allow-cloud-images") || config.ai?.allowCloudImages === true,
      providers: [...providers, provider]
    }
  });
  console.log(`AI provider: ${alias}`);
  console.log(`Preset: ${provider.preset}`);
  console.log(`Model: ${provider.model}`);
  console.log(`Cloud code context: ${args.includes("--allow-cloud-code") ? "allowed" : "blocked"}`);
  console.log(`Cloud images: ${args.includes("--allow-cloud-images") ? "allowed" : "blocked"}`);
  console.log(`Next: sigil auth add --provider ai --alias ${tokenAlias} --value-env HETZNER_INFERENCE_API_KEY`);
  return 0;
}

async function aiVisionTestCommand(args: string[]): Promise<number> {
  const imagePath = args.find((argument) => !argument.startsWith("--"));
  const providerAlias = readOption(args, "--provider", false);
  const prompt = readOption(args, "--prompt", false) ?? "Describe this interface and identify visible UI problems.";
  if (imagePath === undefined) {
    console.error("sigil ai vision test requires an image path");
    return 2;
  }
  const provider = readConfiguredAiProvider(providerAlias);
  if (provider === undefined) {
    console.error(providerAlias === undefined ? "No AI provider configured" : `AI provider not configured: ${providerAlias}`);
    return 2;
  }
  const config = readSigilConfig();
  assertAiDataConsent(provider, "image", config.ai?.allowCloudImages);
  const apiKey = tokenForConfiguredAlias(provider.tokenAlias, "ai");
  if (provider.tokenAlias !== undefined && apiKey === undefined) {
    console.error(`AI credential missing: ${provider.tokenAlias}`);
    return 2;
  }

  const result = await runAiVisionTest({
    provider,
    imagePath,
    prompt,
    apiKey,
    cloudImageConsent: config.ai?.allowCloudImages,
    maxImageBytes: config.ai?.maxImageBytes
  });
  console.log(`Provider: ${result.providerAlias}`);
  console.log(`Model: ${result.model}`);
  console.log(`Image: ${result.mediaType} ${result.byteLength} bytes ${result.sha256.slice(0, 12)}...`);
  if (result.artifactId !== undefined) console.log(`Vision result: ${result.artifactId}`);
  console.log(result.analysis);
  return 0;
}

async function visualCaptureCommand(args: string[]): Promise<number> {
  const url = readOption(args, "--url");
  if (url === undefined) {
    console.error("sigil visual capture requires --url <url>");
    return 2;
  }
  const config = readSigilConfig().visualQa;
  const viewport = readVisualViewport(readOption(args, "--viewport", false), config?.viewports);
  const browserChannel = readVisualBrowserChannel(readOption(args, "--browser", false) ?? config?.browserChannel);
  if (browserChannel === undefined) {
    console.error("sigil visual capture --browser must be auto, msedge, chrome, or chromium");
    return 2;
  }
  const timeoutMs = readNumberOption(args, "--timeout-ms") ?? config?.timeoutMs;
  const result = await captureVisualPage({
    url,
    viewport,
    browserChannel,
    fullPage: args.includes("--full-page"),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  console.log(`Visual capture: ${result.captureArtifactId}`);
  console.log(`Snapshot: ${result.snapshotArtifactId}`);
  console.log(`Path: ${result.snapshotPath}`);
  console.log(`Browser: ${result.browserChannel}`);
  console.log(`SHA-256: ${result.snapshotSha256}`);
  return 0;
}

async function visualCompareCommand(args: string[]): Promise<number> {
  const referencePath = readOption(args, "--reference", false);
  const referenceArtifactId = readOption(args, "--reference-artifact", false);
  const actualPath = readOption(args, "--actual", false);
  const actualArtifactId = readOption(args, "--actual-artifact", false);
  if (
    (referencePath === undefined) === (referenceArtifactId === undefined) ||
    (actualPath === undefined) === (actualArtifactId === undefined)
  ) {
    console.error(
      "sigil visual compare requires exactly one reference (--reference or --reference-artifact) and one actual (--actual or --actual-artifact)"
    );
    return 2;
  }
  const config = readSigilConfig().visualQa;
  const pixelThreshold = readRatioOption(args, "--pixel-threshold") ?? config?.pixelThreshold;
  const allowedDiffRatio = readRatioOption(args, "--allowed-ratio") ?? config?.allowedDiffRatio;
  const maxPixels = readNumberOption(args, "--max-pixels") ?? config?.maxPixels;
  const result = await compareVisualEvidence({
    ...(referencePath === undefined ? {} : { referencePath }),
    ...(referenceArtifactId === undefined ? {} : { referenceArtifactId }),
    ...(actualPath === undefined ? {} : { actualPath }),
    ...(actualArtifactId === undefined ? {} : { actualArtifactId }),
    ...(pixelThreshold === undefined ? {} : { pixelThreshold }),
    ...(allowedDiffRatio === undefined ? {} : { allowedDiffRatio }),
    ...(maxPixels === undefined ? {} : { maxPixels })
  });
  console.log(`Visual comparison: ${result.comparisonArtifactId}`);
  console.log(`Reference: ${result.referenceArtifactId}`);
  console.log(`Actual: ${result.actualArtifactId}`);
  console.log(`Status: ${result.status}`);
  console.log(`Changed pixels: ${result.mismatchedPixels}/${result.totalPixels}`);
  console.log(`Diff ratio: ${result.diffRatio.toFixed(6)}`);
  if (result.diffArtifactId !== undefined) console.log(`Diff: ${result.diffArtifactId}`);
  if (result.diffPath !== undefined) console.log(`Diff path: ${result.diffPath}`);
  return result.status === "passed" ? 0 : 1;
}

async function visualReviewCommand(args: string[]): Promise<number> {
  const comparisonArtifactId = readOption(args, "--comparison");
  if (comparisonArtifactId === undefined) {
    console.error("sigil visual review requires --comparison <artifact-id>");
    return 2;
  }
  const providerAlias = readOption(args, "--provider", false);
  const provider = readConfiguredAiProvider(providerAlias);
  if (provider === undefined) {
    console.error(providerAlias === undefined ? "No AI provider configured" : `AI provider not configured: ${providerAlias}`);
    return 2;
  }
  const config = readSigilConfig();
  assertAiDataConsent(provider, "image", config.ai?.allowCloudImages);
  const apiKey = tokenForConfiguredAlias(provider.tokenAlias, "ai");
  if (provider.tokenAlias !== undefined && apiKey === undefined) {
    console.error(`AI credential missing: ${provider.tokenAlias}`);
    return 2;
  }
  const result = await runAiVisualReview({
    comparisonArtifactId,
    provider,
    apiKey,
    cloudImageConsent: config.ai?.allowCloudImages,
    maxImageBytes: config.ai?.maxImageBytes
  });
  console.log(`Visual review: ${result.reviewArtifactId}`);
  console.log(`Provider: ${result.providerAlias} ${result.model}`);
  console.log(`Status: ${result.status}`);
  console.log(`Findings: ${result.findingCount} (${result.blockingCount} blocking)`);
  console.log(result.summary);
  console.log(`Inspect: sigil artifacts show ${result.reviewArtifactId}`);
  return 0;
}

async function aiProvidersHealthCommand(): Promise<number> {
  const providers = readConfiguredAiProviders();
  if (providers.length === 0) {
    const defaultProvider = defaultOllamaProvider();
    console.log(`${defaultProvider.alias}: not-configured ${defaultProvider.provider} add ai.providers to sigil.config.json`);
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
  const alias = readOption(args, "--provider", false) ?? readSigilConfig().ai?.defaultProviderAlias;
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
    const config = readSigilConfig();
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
    writeSigilConfig({ ...readSigilConfig(), telemetry: { enabled } });
    console.log(`Telemetry: ${enabled ? "enabled" : "disabled"}`);
    return 0;
  }

  console.error("sigil telemetry requires status, preview, enable, or disable");
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
    console.error("sigil linear inspect requires a fixture path");
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
    console.error("sigil figma inspect requires a Figma URL or fixture path");
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
  const config = readSigilConfig();
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

async function figmaEvidenceCommand(args: string[]): Promise<number> {
  const input = args[0];
  if (input === undefined || input.startsWith("--")) {
    console.error("sigil figma evidence requires a Figma URL");
    return 2;
  }
  const reference = parseFigmaReference(input);
  if (reference.nodeId === undefined) {
    console.error("sigil figma evidence requires a Figma URL with node-id");
    return 2;
  }
  const rawScale = readOption(args, "--scale", false);
  const scale = rawScale === undefined ? 1 : Number(rawScale);
  if (!Number.isFinite(scale) || scale < 0.01 || scale > 4) {
    console.error("sigil figma evidence --scale must be between 0.01 and 4");
    return 2;
  }
  const config = readSigilConfig();
  const maxBytes = config.visualQa?.maxReferenceBytes ?? 10_000_000;
  const imagePath = readOption(args, "--image", false);
  let bytes: Uint8Array;
  let source: "api" | "file";
  if (imagePath !== undefined) {
    bytes = readFileSync(imagePath);
    source = "file";
  } else {
    const tokenAlias = config.adapters?.figma?.tokenAlias ?? "figma.default";
    const token = getCredentialToken({ alias: tokenAlias, provider: "figma" });
    if (token === undefined) {
      console.error(`Figma credential missing: ${tokenAlias}`);
      return 2;
    }
    const image = await fetchFigmaNodeImage({ apiKey: token, reference, scale, maxBytes });
    bytes = image.bytes;
    source = "api";
  }
  const result = await importFigmaVisualEvidence({
    bytes,
    figmaUrl: reference.url,
    fileKey: reference.fileKey,
    nodeId: reference.nodeId,
    scale,
    source,
    maxBytes
  });
  console.log(`Figma evidence: ${result.evidenceArtifactId}`);
  console.log(`Visual reference: ${result.referenceArtifactId}`);
  console.log(`Path: ${result.referencePath}`);
  console.log(`SHA-256: ${result.referenceSha256}`);
  console.log(`Next: sigil visual compare --reference-artifact ${result.referenceArtifactId} --actual-artifact <snapshot-id>`);
  return 0;
}

async function githubInspectCommand(args: string[]): Promise<number> {
  const input = args[0];
  if (input === undefined) {
    console.error("sigil github inspect requires a GitHub URL or fixture path");
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
  const config = readSigilConfig();
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
    console.error("sigil decisions record requires --yes");
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
    console.error("sigil decisions record requires --kind, --title, --rationale, and valid --category");
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
    console.error("sigil cancel requires --yes in the walking skeleton");
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
    console.error("sigil context import requires a file path");
    return 2;
  }

  const result = await importContextManifest({ filePath });
  console.log(`Imported context ${result.contextArtifactId}`);
  console.log(`Session: ${result.sessionId}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function contextInspectCommand(args: string[], summaryOnly: boolean): Promise<number> {
  const artifactId = args.find((argument) => !argument.startsWith("--"));
  const inspection = await inspectContextManifest({ ...(artifactId === undefined ? {} : { artifactId }) });
  if (inspection === undefined) {
    console.error(artifactId === undefined ? "No context manifest found for the active session" : `Context manifest not found: ${artifactId}`);
    return 1;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(inspection, null, 2));
    return 0;
  }

  console.log(`Context: ${inspection.artifactId}`);
  console.log(`Schema: v${inspection.schemaVersion} (${inspection.semanticComplete ? "semantic-complete" : "legacy/refresh-required"})`);
  console.log(`Discovery: ${inspection.discovery}`);
  if (inspection.discoveryAlgorithm !== undefined) {
    console.log(`Algorithm: ${inspection.discoveryAlgorithm.name} ${inspection.discoveryAlgorithm.version}`);
  }
  console.log(`Freshness: ${inspection.freshness}`);
  console.log(`Scanned files: ${inspection.scannedFileCount}`);
  console.log(`Candidates: ${inspection.candidateFileCount}`);
  console.log(`Included sources: ${inspection.includedSources.length}`);
  console.log(`Excluded candidates: ${inspection.excludedCandidates.length}`);
  console.log(`Omitted after scan: ${inspection.omittedScanCount}`);
  console.log(
    `Budget: ${inspection.budgets.used_files}/${inspection.budgets.max_files} files, ${inspection.budgets.used_bytes}/${inspection.budgets.max_bytes} bytes`
  );
  console.log(`Task terms: ${inspection.taskTerms.join(", ") || "(none)"}`);
  console.log(`Seeds: ${inspection.seeds.length}`);
  console.log(`Instruction chain: ${inspection.instructionChain.length}`);
  console.log(`Symbols: ${inspection.symbolCount}`);
  console.log(`Relations: ${Object.entries(inspection.relationCounts).map(([kind, count]) => `${kind}=${count}`).join(", ") || "(none)"}`);
  console.log(`Evidence fragments: ${inspection.evidenceFragmentCount}`);
  console.log(`Gaps: blocking=${inspection.gaps.filter((gap) => gap.severity === "blocking").length}, warnings=${inspection.gaps.filter((gap) => gap.severity === "warning").length}`);
  if (inspection.effectiveConfigSha256 !== undefined) console.log(`Context config: ${inspection.effectiveConfigSha256}`);
  if (summaryOnly) return 0;

  const showIncluded = !args.includes("--excluded") || args.includes("--included") || args.includes("--all");
  const showExcluded = args.includes("--excluded") || args.includes("--all");
  if (showIncluded) printContextSources("Included", inspection.includedSources);
  if (showExcluded) printContextSources("Excluded", inspection.excludedCandidates);
  if (inspection.instructionChain.length > 0) {
    console.log("Instructions (root to scope):");
    for (const instruction of inspection.instructionChain) {
      console.log(`${instruction.precedence} ${instruction.uri} scope=${instruction.scope_directory} applies=${instruction.applies_to.length}${instruction.truncated ? " [truncated]" : ""}`);
    }
  }
  if (inspection.gaps.length > 0) {
    console.log("Context gaps:");
    for (const gap of inspection.gaps) console.log(`${gap.severity.toUpperCase()} ${gap.id}: ${gap.description}`);
  }
  if (inspection.pinsExclusions !== undefined) {
    console.log(`Pins: ${inspection.pinsExclusions.pinned_sources.join(", ") || "(none)"}`);
    console.log(`Exclusions: ${inspection.pinsExclusions.exclusions.join(", ") || "(none)"}`);
  }
  return 0;
}

function printContextSources(
  label: string,
  sources: readonly {
    readonly uri: string;
    readonly kind: string;
    readonly reason: string;
    readonly rank?: number | undefined;
    readonly ai_confidence?: number | undefined;
    readonly exclusion_reason?: string | undefined;
  }[]
): void {
  console.log(`${label}:`);
  if (sources.length === 0) {
    console.log("(none)");
    return;
  }
  for (const source of sources) {
    const rank = source.rank === undefined ? "---" : String(source.rank).padStart(3, "0");
    const confidence = source.ai_confidence === undefined ? "" : ` ai=${source.ai_confidence.toFixed(2)}`;
    const exclusion = source.exclusion_reason === undefined ? "" : ` [${source.exclusion_reason}]`;
    console.log(`${rank} ${source.kind}${confidence} ${source.uri}${exclusion} - ${source.reason}`);
  }
}

async function contextBuildCommand(args: string[]): Promise<number> {
  const maxFiles = readNumberOption(args, "--max-files");
  const maxBytes = readNumberOption(args, "--max-bytes");
  const useAi = args.includes("--ai");
  const aiProviderAlias = readOption(args, "--ai-provider", false);
  const status = await getStatus();
  const refreshableStates = new Set(["intake_ready", "context_ready", "planning_ready", "contract_draft", "contract_approved"]);
  if (status.session !== undefined && !refreshableStates.has(status.session.primaryState)) {
    console.error(`sigil context build cannot safely refresh from state ${status.session.primaryState}`);
    console.log(`Next: ${status.nextCommands[0] ?? "no next command"}`);
    return 2;
  }

  let aiRecommendationArtifactId: string | undefined;
  if (useAi) {
    const config = readSigilConfig();
    const providers = readConfiguredAiProviders();
    const alias = aiProviderAlias ?? config.ai?.defaultProviderAlias;
    const provider = alias === undefined ? providers[0] : providers.find((candidate) => candidate.alias === alias);
    if (provider === undefined) {
      console.error(alias === undefined ? "No AI provider configured" : `AI provider not configured: ${alias}`);
      return 2;
    }
    assertAiDataConsent(provider, "code-context", config.ai?.allowCloudCodeContext);
    try {
      console.log(`AI scout: ${provider.alias} ${provider.model}`);
      const scout = await runAiContextScout({
        provider,
        apiKey: tokenForConfiguredAlias(provider.tokenAlias, "ai"),
        cloudDataConsent: config.ai?.allowCloudCodeContext,
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
  console.log(`Scanned files: ${result.scannedFileCount}`);
  console.log(`Candidates: ${result.candidateSourceCount}`);
  console.log(`Included sources: ${result.includedSourceCount}`);
  console.log(`Excluded candidates: ${result.excludedCandidateCount}`);
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
  const cloudDataConsent = readSigilConfig().ai?.allowCloudCodeContext;
  if (provider !== undefined) assertAiDataConsent(provider, "code-context", cloudDataConsent);
  const result = await exportPlanningPackage({
    ...(provider === undefined
      ? {}
      : {
          ai: {
            provider,
            apiKey: tokenForConfiguredAlias(provider.tokenAlias, "ai"),
            cloudDataConsent
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
    console.error("sigil orchestrate run requires --until <context-ready|planning-ready|checks-completed|completion-ready>");
    return 2;
  }

  const config = readSigilConfig();
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
    console.error("sigil writebacks run requires --provider, --target, --summary, and --dry-run or --yes");
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

  const config = readSigilConfig();
  if (config.writebacks?.enabled !== true) {
    console.error("Real adapter writebacks require writebacks.enabled: true in sigil.config.json");
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
    console.error("sigil contract import requires a file path");
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
    console.error("sigil approve contract requires --yes in the walking skeleton");
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
    console.error("sigil implement --agent requires codex or claude");
    return 2;
  }

  const config = readSigilConfig();
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
    console.error("sigil execution import requires a file path");
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
  console.log(`Evidence artifacts: ${result.evidenceCount}`);
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
    console.error("sigil review import requires a file path");
    return 2;
  }
  const reviewerActorId = readOption(args, "--actor");

  const result = await importReviewReport({ filePath, reviewerActorId });
  console.log(`Review report: ${result.reviewReportArtifactId}`);
  console.log(`Findings: ${result.findingIds.join(", ") || "none"}`);
  console.log(`State: ${result.state}`);
  console.log(`Next: ${result.nextCommand}`);
  return 0;
}

async function findingDispositionCommand(args: string[]): Promise<number> {
  const findingId = args[0];
  if (findingId === undefined) {
    console.error("sigil findings disposition requires a finding id");
    return 2;
  }
  const reason = readOption(args, "--reason") ?? "Accepted in walking skeleton";
  const disposition = args.includes("--resolve") ? "resolve" : "reject";
  const evidence = readOption(args, "--evidence", false);
  if (disposition === "resolve" && evidence === undefined) {
    console.error("sigil findings disposition --resolve requires --evidence <artifact-or-reference>");
    return 2;
  }
  const result = await disposeFinding({ findingId, disposition, reason, ...(evidence === undefined ? {} : { evidence: [evidence] }) });
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
    console.error("sigil approve completion requires --yes in the walking skeleton");
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

function readRatioOption(args: string[], name: string): number | undefined {
  const value = readOption(args, name, false);
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined;
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => value !== undefined);
}

function formatArtifactForDisplay(content: string, type: string, mediaType: string): string {
  if (type === "ai_planning_draft") {
    try {
      const parsed = JSON.parse(content) as { readonly draft_markdown?: unknown };
      if (typeof parsed.draft_markdown === "string") {
        return parsed.draft_markdown;
      }
    } catch {
      return content;
    }
  }

  if (mediaType === "application/json") {
    try {
      return JSON.stringify(JSON.parse(content) as unknown, null, 2);
    } catch {
      return content;
    }
  }

  return content;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readConfiguredBaseBranch(): string | undefined {
  const configPath = join(process.cwd(), "sigil.config.json");
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

interface SigilCliConfig {
  readonly schemaVersion?: number | undefined;
  readonly project?: { readonly name?: string | undefined; readonly baseBranch?: string | undefined } | undefined;
  readonly telemetry?: { readonly enabled?: boolean | undefined } | undefined;
  readonly writebacks?: { readonly enabled?: boolean | undefined } | undefined;
  readonly visualQa?: {
    readonly browserChannel?: "auto" | "msedge" | "chrome" | "chromium" | undefined;
    readonly timeoutMs?: number | undefined;
    readonly pixelThreshold?: number | undefined;
    readonly allowedDiffRatio?: number | undefined;
    readonly maxPixels?: number | undefined;
    readonly maxReferenceBytes?: number | undefined;
    readonly viewports?: {
      readonly desktop?: { readonly width: number; readonly height: number } | undefined;
      readonly mobile?: { readonly width: number; readonly height: number } | undefined;
    } | undefined;
  } | undefined;
  readonly ai?: {
    readonly defaultProviderAlias?: string | undefined;
    readonly allowCloudCodeContext?: boolean | undefined;
    readonly allowCloudImages?: boolean | undefined;
    readonly maxImageBytes?: number | undefined;
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

function readVisualViewport(
  value: string | undefined,
  configured:
    | {
        readonly desktop?: { readonly width: number; readonly height: number } | undefined;
        readonly mobile?: { readonly width: number; readonly height: number } | undefined;
      }
    | undefined
): { readonly width: number; readonly height: number } {
  const preset = value ?? "desktop";
  if (preset === "desktop") return configured?.desktop ?? { width: 1440, height: 900 };
  if (preset === "mobile") return configured?.mobile ?? { width: 390, height: 844 };
  const match = /^(\d+)x(\d+)$/i.exec(preset);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new TypeError("Visual viewport must be desktop, mobile, or WIDTHxHEIGHT");
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function readVisualBrowserChannel(
  value: string | undefined
): "auto" | "msedge" | "chrome" | "chromium" | undefined {
  return value === undefined || value === "auto" || value === "msedge" || value === "chrome" || value === "chromium"
    ? value ?? "auto"
    : undefined;
}

function readSigilConfig(): SigilCliConfig {
  const configPath = join(process.cwd(), "sigil.config.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as SigilCliConfig;
  } catch {
    return {};
  }
}

function writeSigilConfig(config: SigilCliConfig): void {
  const next: SigilCliConfig = {
    ...config,
    schemaVersion: config.schemaVersion ?? 1,
    project: config.project ?? { name: "sigil-project", baseBranch: "main" }
  };
  writeFileSync(join(process.cwd(), "sigil.config.json"), `${JSON.stringify(next, null, 2)}\n`);
}

function readConfiguredAiProviders(): AiProviderConfig[] {
  return (readSigilConfig().ai?.providers ?? []).flatMap((provider) => {
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
      ...(typeof provider.maxInputTokens === "number" ? { maxInputTokens: provider.maxInputTokens } : {}),
      ...(provider.preset === "hetzner-inference" ? { preset: provider.preset } : {}),
      ...(Array.isArray(provider.capabilities)
        ? { capabilities: provider.capabilities.filter((capability) => capability === "text" || capability === "vision") }
        : {})
    };
    return [config];
  });
}

function readConfiguredAiProvider(alias: string | undefined): AiProviderConfig | undefined {
  const providers = readConfiguredAiProviders();
  const resolvedAlias = alias ?? readSigilConfig().ai?.defaultProviderAlias;
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
