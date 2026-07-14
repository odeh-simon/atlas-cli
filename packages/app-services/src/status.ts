import {
  closeAtlasRuntime,
  openAtlasRuntime,
  repoIdForPath,
  type RuntimeOptions
} from "./runtime.js";
import { listArtifactsForSession, listEvents, listSessionsForRepository, type SessionRecord } from "@atlas/persistence";
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
      nextCommands: nextCommandsForSession(session)
    };
  } finally {
    closeAtlasRuntime(runtime, false);
  }
}

export const resumeSession = getStatus;

function nextCommandsForSession(session: SessionRecord): readonly string[] {
  if (session.disposition !== "active") {
    return [];
  }

  if (session.archived) {
    return ["atlas unarchive"];
  }

  if (session.paused) {
    return ["atlas resume"];
  }

  return allowedCommands(session.primaryState).map(commandToCli);
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
    case "evaluate_completion":
      return "atlas complete --check";
    case "approve_completion":
      return "atlas approve completion";
    default:
      return `atlas ${command}`;
  }
}
