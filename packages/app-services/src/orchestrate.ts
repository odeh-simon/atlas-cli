import { randomUUID } from "node:crypto";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { GateFailedError, StateTransitionError } from "@atlas/domain";
import {
  appendEvent,
  createArtifactRecord,
  listArtifactsForSession,
  listFindingsForSession,
  listSessionsForRepository
} from "@atlas/persistence";
import { orchestrationRunSchema } from "@atlas/schemas";

import { buildContextManifest } from "./context-build.js";
import { evaluateCompletion } from "./completion.js";
import { disposeFinding } from "./finding-disposition.js";
import { exportManualAgentPackage } from "./agent-package.js";
import { exportPlanningPackage } from "./planning.js";
import { importReviewReport, type ImportedReviewReportPayload } from "./review-import.js";
import { invokeImplementationAgent, type AgentInvoker, type ImplementationAgentProvider } from "./agent-invoke.js";
import { prepareFixBatch } from "./fix-batch.js";
import { prepareReviewPackage } from "./review-prepare.js";
import { runBasicCheck } from "./checks.js";
import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export type OrchestrateUntil = "context-ready" | "planning-ready" | "checks-completed" | "completion-ready";

export interface OrchestrateRunInput extends RuntimeOptions {
  readonly until: OrchestrateUntil;
  readonly agentProvider?: ImplementationAgentProvider | undefined;
  readonly agentCommand?: string | undefined;
  readonly agentInvoker?: AgentInvoker | undefined;
  readonly reviewer?: ReviewRunner | undefined;
  readonly maxIterations?: number | undefined;
}

export interface ReviewRunnerInput {
  readonly reviewPackageArtifactId: string;
  readonly iteration: number;
}

export type ReviewRunner = (input: ReviewRunnerInput) => Promise<ImportedReviewReportPayload> | ImportedReviewReportPayload;

export interface OrchestrationStep {
  readonly command: string;
  readonly state_before: string;
  readonly state_after: string;
  readonly status: "succeeded" | "blocked" | "failed";
  readonly summary: string;
  readonly artifact_ids: readonly string[];
}

export interface OrchestrateRunResult {
  readonly sessionId: string;
  readonly orchestrationRunArtifactId: string;
  readonly status: "succeeded" | "blocked" | "failed";
  readonly state: string;
  readonly steps: readonly OrchestrationStep[];
  readonly blockedReason?: string | undefined;
}

export async function orchestrateRun(input: OrchestrateRunInput): Promise<OrchestrateRunResult> {
  const runId = `run_${randomUUID()}`;
  const steps: OrchestrationStep[] = [];
  const untilState = untilToState(input.until);
  let status: "succeeded" | "blocked" | "failed" = "blocked";
  let blockedReason: string | undefined;

  const maxIterations = input.maxIterations ?? 12;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const snapshot = await readWorkflowSnapshot(input);
    if (snapshot.session === undefined) {
      throw new StateTransitionError("No active session found for orchestration");
    }
    if (stateRank(snapshot.session.primaryState) >= stateRank(untilState)) {
      status = "succeeded";
      return await finishOrchestration(input, {
        runId,
        until: untilState,
        sessionId: snapshot.session.sessionId,
        status,
        steps,
        iterations: iteration
      });
    }

    const state = snapshot.session.primaryState;
    if (state === "intake_ready") {
      const result = await buildContextManifest(input);
      steps.push(step("atlas context build", state, result.state, "succeeded", "Context built", [result.contextArtifactId]));
      continue;
    }

    if (state === "context_ready") {
      const result = await exportPlanningPackage(input);
      steps.push(step("atlas plan", state, result.state, "succeeded", "Planning package exported", [result.planningArtifactId]));
      continue;
    }

    if (state === "planning_ready" || state === "contract_draft") {
      blockedReason = "Contract import and approval are manual gates";
      steps.push(step("atlas contract import <file>", state, state, "blocked", blockedReason, []));
      break;
    }

    if (state === "contract_approved") {
      const result = await exportManualAgentPackage(input);
      steps.push(step("atlas implement export --manual", state, result.state, "succeeded", "Agent package exported", [result.packageArtifactId]));
      continue;
    }

    if (state === "implementation_ready") {
      if (input.agentProvider === undefined) {
        blockedReason = "Implementation-ready orchestration requires an agent provider";
        steps.push(step("atlas implement --agent <codex|claude>", state, state, "blocked", blockedReason, []));
        break;
      }
      const result = await invokeImplementationAgent({
        ...input,
        provider: input.agentProvider,
        command: input.agentCommand,
        agentInvoker: input.agentInvoker
      });
      steps.push(
        step("atlas implement --agent", state, result.state, "succeeded", "Implementation agent invoked", [
          result.agentRunLogArtifactId,
          result.executionReportArtifactId
        ])
      );
      continue;
    }

    if (state === "implementation_reconciled") {
      const result = await runBasicCheck(input);
      steps.push(step("atlas checks run", state, result.state, "succeeded", "Checks completed", [result.checkResultArtifactId]));
      continue;
    }

    if (state === "checks_completed") {
      if (targetBeforeReview(untilState)) {
        status = "succeeded";
        return await finishOrchestration(input, {
          runId,
          until: untilState,
          sessionId: snapshot.session.sessionId,
          status,
          steps,
          iterations: iteration
        });
      }
      const hasReviewReport = snapshot.artifacts.some((artifact) => artifact.type === "review_report" && artifact.status === "valid");
      if (hasReviewReport && openBlockingFindingIds(snapshot.findings).length === 0) {
        const result = await evaluateCompletion(input);
        steps.push(step("atlas complete --check", state, result.state, "succeeded", "Completion gates passed", []));
        continue;
      }
      const result = await prepareReviewPackage(input);
      steps.push(step("atlas review prepare", state, result.state, "succeeded", "Review package prepared", [result.reviewPackageArtifactId]));
      continue;
    }

    if (state === "review_ready") {
      if (input.reviewer === undefined) {
        blockedReason = "Review-ready orchestration requires a reviewer or manual review import";
        steps.push(step("atlas review import <file>", state, state, "blocked", blockedReason, []));
        break;
      }
      const blockersBefore = openBlockingFindingIds(snapshot.findings);
      const review = await input.reviewer({
        reviewPackageArtifactId: latestArtifactId(snapshot.artifacts, "review_package"),
        iteration: reviewIteration(snapshot.artifacts)
      });
      const result = await importReviewReport({ ...input, report: review });
      steps.push(step("atlas review import", state, result.state, "succeeded", "Review report imported", [result.reviewReportArtifactId]));
      if ((review.findings ?? []).filter((finding) => finding.severity === "blocking").length === 0) {
        for (const findingId of blockersBefore) {
          const disposition = await disposeFinding({
            ...input,
            findingId,
            disposition: "resolve",
            reason: "Reviewer reported no blocking findings after fix iteration"
          });
          steps.push(step("atlas findings disposition", result.state, disposition.state, "succeeded", `Resolved ${findingId}`, []));
        }
      }
      continue;
    }

    if (state === "review_imported" || state === "findings_dispositioned") {
      const blockingFindings = openBlockingFindingIds(snapshot.findings);
      if (blockingFindings.length === 0) {
        const result = await evaluateCompletion(input);
        steps.push(step("atlas complete --check", state, result.state, "succeeded", "Completion gates passed", []));
        continue;
      }
      const result = await prepareFixBatch(input);
      steps.push(step("atlas fix prepare", state, result.state, "succeeded", "Fix batch prepared", [result.fixBatchArtifactId]));
      continue;
    }

    if (state === "fix_ready") {
      const result = await exportManualAgentPackage(input);
      steps.push(step("atlas implement export --manual", state, result.state, "succeeded", "Fix package exported", [result.packageArtifactId]));
      continue;
    }

    blockedReason = `No orchestrator action is available from state ${state}`;
    steps.push(step("atlas orchestrate", state, state, "blocked", blockedReason, []));
    break;
  }

  const snapshot = await readWorkflowSnapshot(input);
  const session = snapshot.session;
  if (session === undefined) throw new StateTransitionError("No active session found for orchestration");
  if (blockedReason === undefined) blockedReason = `Maximum orchestration iterations reached`;
  return await finishOrchestration(input, {
    runId,
    until: untilState,
    sessionId: session.sessionId,
    status,
    steps,
    iterations: steps.length,
    blockedReason
  });
}

async function finishOrchestration(
  options: RuntimeOptions,
  input: {
    readonly runId: string;
    readonly until: ReturnType<typeof untilToState>;
    readonly sessionId: string;
    readonly status: "succeeded" | "blocked" | "failed";
    readonly steps: readonly OrchestrationStep[];
    readonly iterations: number;
    readonly blockedReason?: string | undefined;
  }
): Promise<OrchestrateRunResult> {
  const runtime = await openAtlasRuntime(options);
  try {
    const session = listSessionsForRepository(runtime.db, repoIdForPath(runtime.paths.cwd))[0];
    const now = new Date().toISOString();
    const artifactId = newId("art");
    const artifact = orchestrationRunSchema.parse({
      artifact_id: artifactId,
      session_id: input.sessionId,
      type: "orchestration_run",
      schema_version: 1,
      content_version: listArtifactsForSession(runtime.db, input.sessionId).filter((candidate) => candidate.type === "orchestration_run").length + 1,
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "internal",
      parents: input.steps.flatMap((step) => step.artifact_ids),
      content_sha256: "0".repeat(64),
      metadata: {},
      run_id: input.runId,
      until: input.until,
      status: input.status,
      iterations: input.iterations,
      steps: input.steps,
      ...(input.blockedReason === undefined ? {} : { blocked_reason: input.blockedReason })
    });
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: input.sessionId,
      artifactId,
      type: "orchestration_run",
      contentVersion: artifact.content_version,
      mediaType: "application/json",
      content: `${JSON.stringify(artifact, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: input.sessionId,
      type: "orchestration_run",
      schemaVersion: 1,
      contentVersion: artifact.content_version,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "internal",
      status: input.status === "succeeded" ? "valid" : "rejected",
      producerType: "atlas",
      createdAt: now
    });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: input.sessionId,
      eventType: "orchestration.completed",
      actorType: "atlas",
      occurredAt: now,
      summary: `Orchestration ${input.status}`,
      metadata: { orchestrationRunArtifactId: artifactId, runId: input.runId, until: input.until }
    });
    return {
      sessionId: input.sessionId,
      orchestrationRunArtifactId: artifactId,
      status: input.status,
      state: session?.primaryState ?? input.until,
      steps: input.steps,
      blockedReason: input.blockedReason
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

async function readWorkflowSnapshot(options: RuntimeOptions) {
  const runtime = await openAtlasRuntime(options);
  try {
    const session = listSessionsForRepository(runtime.db, repoIdForPath(runtime.paths.cwd))[0];
    return {
      session,
      artifacts: session === undefined ? [] : listArtifactsForSession(runtime.db, session.sessionId),
      findings: session === undefined ? [] : listFindingsForSession(runtime.db, session.sessionId)
    };
  } finally {
    closeAtlasRuntime(runtime, false);
  }
}

function step(
  command: string,
  stateBefore: string,
  stateAfter: string,
  status: "succeeded" | "blocked" | "failed",
  summary: string,
  artifactIds: readonly string[]
): OrchestrationStep {
  return {
    command,
    state_before: stateBefore,
    state_after: stateAfter,
    status,
    summary,
    artifact_ids: artifactIds
  };
}

function untilToState(until: OrchestrateUntil): "context_ready" | "planning_ready" | "checks_completed" | "completion_ready" {
  switch (until) {
    case "context-ready":
      return "context_ready";
    case "planning-ready":
      return "planning_ready";
    case "checks-completed":
      return "checks_completed";
    case "completion-ready":
      return "completion_ready";
  }
}

function stateRank(state: string): number {
  const order = [
    "draft",
    "intake_ready",
    "context_ready",
    "planning_ready",
    "contract_draft",
    "contract_approved",
    "implementation_ready",
    "implementation_reconciled",
    "checks_completed",
    "review_ready",
    "review_imported",
    "findings_dispositioned",
    "fix_ready",
    "completion_ready",
    "completed"
  ];
  const index = order.indexOf(state);
  return index === -1 ? -1 : index;
}

function targetBeforeReview(until: string): boolean {
  return stateRank(until) <= stateRank("checks_completed");
}

function openBlockingFindingIds(findings: readonly { findingId: string; severity: string; status: string }[]): string[] {
  return findings
    .filter((finding) => finding.severity === "blocking" && (finding.status === "open" || finding.status === "reopened"))
    .map((finding) => finding.findingId);
}

function latestArtifactId(artifacts: readonly { artifactId: string; type: string }[], type: string): string {
  const artifact = artifacts.filter((candidate) => candidate.type === type).at(-1);
  if (artifact === undefined) {
    throw new GateFailedError(`Missing ${type} artifact for orchestration`);
  }
  return artifact.artifactId;
}

function reviewIteration(artifacts: readonly { type: string }[]): number {
  return artifacts.filter((artifact) => artifact.type === "review_report").length + 1;
}
