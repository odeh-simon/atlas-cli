import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { StateTransitionError, ValidationError } from "@atlas/domain";
import {
  appendEvent,
  createArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository,
  updateSessionContractArtifact
} from "@atlas/persistence";
import { implementationContractSchema } from "@atlas/schemas";
import { diffImplementationContracts, transition } from "@atlas/workflow-engine";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface ImportContractInput extends RuntimeOptions {
  readonly filePath: string;
}

export interface ImportContractResult {
  readonly sessionId: string;
  readonly contractArtifactId: string;
  readonly state: string;
  readonly valid: boolean;
  readonly nextCommand: string;
}

export async function importContract(input: ImportContractInput): Promise<ImportContractResult> {
  const runtime = await openAtlasRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for contract import");
    }

    const now = new Date().toISOString();
    const artifactId = newId("art");
    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const rawContent = readFileSync(input.filePath, "utf8");
    const candidate = parseContract(rawContent, session.sessionId, artifactId, now);
    const parsed = implementationContractSchema.safeParse(candidate);

    if (!parsed.success) {
      const rejected = writeImmutableArtifactContent({
        rootDir: runtime.paths.artifactRoot,
        sessionId: session.sessionId,
        artifactId,
        type: "implementation_contract",
        contentVersion: nextContractVersion(runtime.db, session.sessionId),
        mediaType: "text/markdown",
        content: rawContent
      });
      createArtifactRecord(runtime.db, {
        artifactId,
        sessionId: session.sessionId,
        type: "implementation_contract",
        schemaVersion: 1,
        contentVersion: nextContractVersion(runtime.db, session.sessionId),
        storageUri: rejected.storageUri,
        sha256: rejected.sha256,
        byteLength: rejected.byteLength,
        mediaType: "text/markdown",
        sensitivity: "confidential",
        status: "rejected",
        producerType: "import",
        createdAt: now
      });
      appendEvent(runtime.db, {
        eventId: newId("evt"),
        sessionId: session.sessionId,
        eventType: "contract.import_rejected",
        actorType: "user",
        occurredAt: now,
        summary: "Contract import rejected by schema validation",
        metadata: { contractArtifactId: artifactId, issues: parsed.error.issues.map((issue) => issue.message) }
      });
      throw new ValidationError("Implementation contract failed validation", {
        issues: parsed.error.issues.map((issue) => issue.message)
      });
    }

    const next = transition({
      state: session.primaryState,
      command: "import_contract",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    const approvedContract = loadLatestApprovedContract(runtime.paths.artifactRoot, artifacts);
    const contractDiff =
      approvedContract === undefined ? undefined : diffImplementationContracts(approvedContract, parsed.data);
    const contractDiffMetadata =
      approvedContract === undefined || contractDiff === undefined
        ? {}
        : {
            previous_approved_contract_artifact_id: approvedContract.artifact_id,
            contract_diff: {
              has_changes: contractDiff.hasChanges,
              requires_reapproval: contractDiff.requiresReapproval,
              changes: contractDiff.changes.map((change) => ({
                section: change.section,
                category: change.category,
                material: change.material,
                summary: change.summary
              }))
            }
          };
    const contractWithMetadata = implementationContractSchema.parse({
      ...parsed.data,
      metadata: {
        ...parsed.data.metadata,
        ...contractDiffMetadata
      }
    });
    const contentVersion = nextContractVersion(runtime.db, session.sessionId);
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "implementation_contract",
      contentVersion,
      mediaType: "application/json",
      content: `${JSON.stringify(contractWithMetadata, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "implementation_contract",
      schemaVersion: 1,
      contentVersion,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "valid",
      producerType: "import",
      createdAt: now
    });
    updateSessionContractArtifact(runtime.db, {
      sessionId: session.sessionId,
      artifactId,
      primaryState: next,
      now
    });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "contract.imported",
      actorType: "user",
      occurredAt: now,
      summary: "Implementation contract imported",
      metadata: {
        contractArtifactId: artifactId,
        requiresReapproval: contractDiff?.requiresReapproval ?? true,
        materialChangeSections: contractDiff?.changes.filter((change) => change.material).map((change) => change.section) ?? []
      }
    });

    return {
      sessionId: session.sessionId,
      contractArtifactId: artifactId,
      state: next,
      valid: true,
      nextCommand: "atlas approve contract"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function loadLatestApprovedContract(
  artifactRoot: string,
  artifacts: ReturnType<typeof listArtifactsForSession>
): ReturnType<typeof implementationContractSchema.parse> | undefined {
  const approved = artifacts
    .filter((artifact) => artifact.type === "implementation_contract" && artifact.status === "approved")
    .at(-1);
  if (approved === undefined) return undefined;
  return implementationContractSchema.parse(JSON.parse(readFileSync(join(artifactRoot, approved.storageUri), "utf8")) as unknown);
}

function nextContractVersion(db: Parameters<typeof listArtifactsForSession>[0], sessionId: string): number {
  return listArtifactsForSession(db, sessionId).filter((artifact) => artifact.type === "implementation_contract").length + 1;
}

function parseContract(rawContent: string, sessionId: string, artifactId: string, now: string): unknown {
  try {
    const parsed = JSON.parse(rawContent) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return {
        ...parsed,
        artifact_id: artifactId,
        session_id: sessionId,
        type: "implementation_contract",
        schema_version: 1,
        content_version: 1,
        created_at: now,
        producer: { type: "user" },
        sensitivity: "confidential",
        parents: [],
        content_sha256: "0".repeat(64)
      };
    }
  } catch {
    // Markdown fallback below.
  }

  const sections = parseMarkdownSections(rawContent);
  return {
    artifact_id: artifactId,
    session_id: sessionId,
    type: "implementation_contract",
    schema_version: 1,
    content_version: 1,
    created_at: now,
    producer: { type: "user" },
    sensitivity: "confidential",
    parents: [],
    content_sha256: "0".repeat(64),
    metadata: {},
    status: "valid",
    objective: sectionText(sections, "Objective"),
    scope: {
      in_scope: sectionList(sections, "In Scope"),
      out_of_scope: sectionList(sections, "Out of Scope")
    },
    approved_decisions: sectionList(sections, "Approved Decisions").map((decision, index) => ({
      id: `decision_${index + 1}`,
      decision,
      rationale: "Imported from contract Markdown"
    })),
    technical_approach: sectionText(sections, "Technical Approach"),
    affected_subsystems: sectionList(sections, "Affected Subsystems"),
    reuse: sectionList(sections, "Reuse"),
    constraints: sectionList(sections, "Constraints"),
    data_state_permissions: sectionText(sections, "Data State Permissions"),
    required_states: sectionList(sections, "Required States"),
    accessibility_observability: sectionText(sections, "Accessibility Observability"),
    edge_cases: sectionList(sections, "Edge Cases"),
    acceptance_criteria: sectionList(sections, "Acceptance Criteria"),
    tests_and_validation: sectionList(sections, "Tests and Validation"),
    unresolved_questions: sectionList(sections, "Unresolved Questions").map((question) => ({
      question,
      blocking: /\bblocking\b/i.test(question)
    })),
    prohibitions: sectionList(sections, "Prohibitions")
  };
}

function parseMarkdownSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  let body: string[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      if (current !== undefined) sections.set(current, body.join("\n").trim());
      current = heading[1].trim();
      body = [];
    } else if (current !== undefined) {
      body.push(line);
    }
  }

  if (current !== undefined) sections.set(current, body.join("\n").trim());
  return sections;
}

function sectionText(sections: Map<string, string>, heading: string): { heading: string; body_markdown: string } {
  return { heading, body_markdown: sections.get(heading) ?? "" };
}

function sectionList(sections: Map<string, string>, heading: string): string[] {
  return (sections.get(heading) ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.]+\s*/, "").trim())
    .filter(Boolean);
}
