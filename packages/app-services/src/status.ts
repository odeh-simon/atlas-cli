import {
  closeSigilRuntime,
  openSigilRuntime,
  repoIdForPath,
  type RuntimeOptions
} from "./runtime.js";
import {
  listArtifactsForSession,
  listEvents,
  listFindingsForSession,
  listSessionsForRepository,
  type FindingRecord,
  type SessionRecord
} from "@sigil/persistence";
import { allowedCommands } from "@sigil/workflow-engine";
import { contextContentPackSchema, contextManifestSchema } from "@sigil/schemas";
import { readVerifiedArtifactText } from "./evidence.js";
import { assertContextManifestFresh } from "./context-pack.js";
import { readWorkflowGitSnapshot } from "./git-safeguards.js";

export interface SessionStatus {
  readonly session: SessionRecord | undefined;
  readonly artifactCount: number;
  readonly eventCount: number;
  readonly nextCommands: readonly string[];
  readonly context?: {
    readonly schemaVersion: number;
    readonly semanticComplete: boolean;
    readonly fresh: boolean;
    readonly discoveryAlgorithm?: string | undefined;
    readonly effectiveConfigSha256?: string | undefined;
    readonly blockingGapCount: number;
    readonly warningGapCount: number;
    readonly budgetPressure: boolean;
  } | undefined;
}

export async function getStatus(options: RuntimeOptions = {}): Promise<SessionStatus> {
  const runtime = await openSigilRuntime(options);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      return {
        session: undefined,
        artifactCount: 0,
        eventCount: 0,
        nextCommands: ["sigil start --manual --title <title> --objective <objective>"]
      };
    }

    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const context = contextStatus(runtime.paths.cwd, runtime.paths.artifactRoot, session, artifacts);
    return {
      session,
      artifactCount: artifacts.length,
      eventCount: listEvents(runtime.db, session.sessionId).length,
      nextCommands: nextCommandsForSession(session, listFindingsForSession(runtime.db, session.sessionId), artifacts, context?.semanticComplete === true && context.fresh),
      ...(context === undefined ? {} : { context })
    };
  } finally {
    closeSigilRuntime(runtime, false);
  }
}

export const resumeSession = getStatus;

function nextCommandsForSession(
  session: SessionRecord,
  findings: readonly FindingRecord[],
  artifacts: readonly { readonly type: string; readonly status: string }[],
  hasSemanticContext: boolean
): readonly string[] {
  if (session.disposition !== "active") {
    return [];
  }

  if (session.archived) {
    return ["sigil unarchive"];
  }

  if (session.paused) {
    return ["sigil resume"];
  }

  if (["context_ready", "planning_ready", "contract_draft", "contract_approved"].includes(session.primaryState) && !hasSemanticContext) {
    return ["sigil context build"];
  }

  const hasOpenFindings = findings.some((finding) => finding.status === "open" || finding.status === "reopened");
  return [...allowedCommands(session.primaryState)]
    .filter((command) => session.primaryState === "intake_ready" || command !== "import_context")
    .sort(
      (left, right) =>
        commandPriority(session.primaryState, left, hasOpenFindings) -
        commandPriority(session.primaryState, right, hasOpenFindings)
    )
    .map(commandToCli);
}

function contextStatus(
  cwd: string,
  artifactRoot: string,
  session: SessionRecord,
  artifacts: readonly ReturnType<typeof listArtifactsForSession>[number][]
): SessionStatus["context"] {
  const manifestRecord = artifacts.find((artifact) => artifact.artifactId === session.currentContextArtifactId);
  if (manifestRecord === undefined || manifestRecord.type !== "context_manifest") return undefined;
  try {
    const manifest = contextManifestSchema.parse(JSON.parse(readVerifiedArtifactText(artifactRoot, manifestRecord)) as unknown);
    const packRecord = artifacts.filter((artifact) => artifact.type === "context_content_pack" && artifact.status === "valid").at(-1);
    const pack = packRecord === undefined
      ? undefined
      : contextContentPackSchema.parse(JSON.parse(readVerifiedArtifactText(artifactRoot, packRecord)) as unknown);
    const semanticComplete = manifest.schema_version >= 3 && manifest.semantic_complete === true && pack !== undefined &&
      pack.schema_version >= 3 && pack.semantic_complete === true && pack.manifest_schema_version === 3 &&
      pack.context_manifest_artifact_id === manifestRecord.artifactId && pack.context_manifest_sha256 === manifestRecord.sha256 &&
      pack.blocking_gaps.length === 0;
    let fresh = false;
    if (semanticComplete && pack !== undefined) {
      const taskBrief = artifacts.find((artifact) => artifact.artifactId === pack.task_artifact_id && artifact.type === "task_brief" && artifact.status === "valid");
      if (taskBrief !== undefined && taskBrief.sha256 === pack.task_artifact_sha256) {
        try {
          assertContextManifestFresh({ rootPath: cwd, manifest, taskBriefSha256: taskBrief.sha256, git: readWorkflowGitSnapshot(cwd) });
          fresh = true;
        } catch {
          fresh = false;
        }
      }
    }
    return {
      schemaVersion: manifest.schema_version,
      semanticComplete,
      fresh,
      ...(manifest.discovery_algorithm === undefined ? {} : { discoveryAlgorithm: `${manifest.discovery_algorithm.name} ${manifest.discovery_algorithm.version}` }),
      ...(manifest.effective_context_config_sha256 === undefined ? {} : { effectiveConfigSha256: manifest.effective_context_config_sha256 }),
      blockingGapCount: manifest.gaps.filter((gap) => gap.severity === "blocking").length,
      warningGapCount: manifest.gaps.filter((gap) => gap.severity === "warning").length,
      budgetPressure: manifest.freshness === "partial" || manifest.gaps.some((gap) => gap.id.includes("budget"))
    };
  } catch {
    return { schemaVersion: manifestRecord.schemaVersion, semanticComplete: false, fresh: false, blockingGapCount: 1, warningGapCount: 0, budgetPressure: false };
  }
}

function commandPriority(state: string, command: string, hasOpenFindings: boolean): number {
  if (state === "planning_ready") {
    if (command === "import_contract") return 0;
    if (command === "export_plan") return 1;
  }

  if (state === "review_imported") {
    if (command === "evaluate_completion") return hasOpenFindings ? 2 : 0;
    if (command === "dispose_findings") return hasOpenFindings ? 0 : 2;
    if (command === "prepare_fix_batch") return hasOpenFindings ? 1 : 3;
  }

  switch (command) {
    case "prepare_review":
    case "evaluate_completion":
    case "approve_completion":
    case "import_review":
    case "dispose_findings":
    case "prepare_fix_batch":
    case "run_basic_check":
    case "import_execution_result":
    case "export_agent_package":
    case "approve_contract":
    case "export_plan":
    case "import_context":
      return 0;
    case "import_contract":
      return 10;
    default:
      return 5;
  }
}

function commandToCli(command: string): string {
  switch (command) {
    case "import_context":
      return "sigil context import <file>";
    case "export_plan":
      return "sigil plan";
    case "import_contract":
      return "sigil contract import <file>";
    case "approve_contract":
      return "sigil approve contract";
    case "export_agent_package":
      return "sigil implement export --manual";
    case "import_execution_result":
      return "sigil execution import <file>";
    case "run_basic_check":
      return "sigil checks run";
    case "prepare_review":
      return "sigil review prepare";
    case "import_review":
      return "sigil review import <file> --actor <trusted-reviewer-id>";
    case "dispose_findings":
      return "sigil findings disposition <id>";
    case "prepare_fix_batch":
      return "sigil fix prepare";
    case "evaluate_completion":
      return "sigil complete --check";
    case "approve_completion":
      return "sigil approve completion";
    default:
      return `sigil ${command}`;
  }
}
