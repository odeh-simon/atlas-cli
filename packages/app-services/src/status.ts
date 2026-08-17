import {
  closeAtlasRuntime,
  openAtlasRuntime,
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
} from "@atlas/persistence";
import { allowedCommands } from "@atlas/workflow-engine";

export interface SessionStatus {
  readonly session: SessionRecord | undefined;
  readonly artifactCount: number;
  readonly eventCount: number;
  readonly nextCommands: readonly string[];
}

export async function getStatus(options: RuntimeOptions = {}): Promise<SessionStatus> {
  const runtime = await openAtlasRuntime(options);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      return {
        session: undefined,
        artifactCount: 0,
        eventCount: 0,
        nextCommands: ["atlas start --manual --title <title> --objective <objective>"]
      };
    }

    return {
      session,
      artifactCount: listArtifactsForSession(runtime.db, session.sessionId).length,
      eventCount: listEvents(runtime.db, session.sessionId).length,
      nextCommands: nextCommandsForSession(session, listFindingsForSession(runtime.db, session.sessionId))
    };
  } finally {
    closeAtlasRuntime(runtime, false);
  }
}

export const resumeSession = getStatus;

function nextCommandsForSession(session: SessionRecord, findings: readonly FindingRecord[]): readonly string[] {
  if (session.disposition !== "active") {
    return [];
  }

  if (session.archived) {
    return ["atlas unarchive"];
  }

  if (session.paused) {
    return ["atlas resume"];
  }

  const hasOpenFindings = findings.some((finding) => finding.status === "open" || finding.status === "reopened");
  return [...allowedCommands(session.primaryState)]
    .sort(
      (left, right) =>
        commandPriority(session.primaryState, left, hasOpenFindings) -
        commandPriority(session.primaryState, right, hasOpenFindings)
    )
    .map(commandToCli);
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
      return "atlas context import <file>";
    case "export_plan":
      return "atlas plan";
    case "import_contract":
      return "atlas contract import <file>";
    case "approve_contract":
      return "atlas approve contract";
    case "export_agent_package":
      return "atlas implement export --manual";
    case "import_execution_result":
      return "atlas execution import <file>";
    case "run_basic_check":
      return "atlas checks run";
    case "prepare_review":
      return "atlas review prepare";
    case "import_review":
      return "atlas review import <file>";
    case "dispose_findings":
      return "atlas findings disposition <id>";
    case "prepare_fix_batch":
      return "atlas fix prepare";
    case "evaluate_completion":
      return "atlas complete --check";
    case "approve_completion":
      return "atlas approve completion";
    default:
      return `atlas ${command}`;
  }
}
