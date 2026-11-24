import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFileSync } from "node:fs";

import { writeImmutableArtifactContent } from "@sigil/artifacts";
import { ValidationError } from "@sigil/domain";
import {
  assertAiDataConsent,
  createAiCompletion,
  isCloudAiProvider,
  supportsAiCapability,
  type AiCompletionResponse,
  type AiProviderConfig
} from "@sigil/llm";
import { appendEvent, createArtifactRecord, listArtifactsForSession, listSessionsForRepository } from "@sigil/persistence";
import { aiVisionResultSchema } from "@sigil/schemas";

import { closeSigilRuntime, newId, openSigilRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface RunAiVisionTestInput extends RuntimeOptions {
  readonly provider: AiProviderConfig;
  readonly imagePath: string;
  readonly prompt: string;
  readonly apiKey?: string | undefined;
  readonly cloudImageConsent?: boolean | undefined;
  readonly maxImageBytes?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly completionImpl?: ((input: { readonly prompt: string; readonly dataUrl: string }) => Promise<AiCompletionResponse>) | undefined;
}

export interface RunAiVisionTestResult {
  readonly providerAlias: string;
  readonly model: string;
  readonly analysis: string;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  readonly byteLength: number;
  readonly sha256: string;
  readonly artifactId?: string | undefined;
}

export async function runAiVisionTest(input: RunAiVisionTestInput): Promise<RunAiVisionTestResult> {
  if (!supportsAiCapability(input.provider, "vision")) {
    throw new ValidationError(`AI provider ${input.provider.alias} is not configured for vision`);
  }
  assertAiDataConsent(input.provider, "image", input.cloudImageConsent);

  const bytes = readFileSync(input.imagePath);
  const maxImageBytes = input.maxImageBytes ?? 5_000_000;
  if (bytes.length === 0) throw new ValidationError("Vision input image is empty");
  if (bytes.length > maxImageBytes) {
    throw new ValidationError(`Vision input exceeds the ${maxImageBytes} byte limit`);
  }
  const mediaType = detectImageMediaType(bytes);
  const dataUrl = `data:${mediaType};base64,${bytes.toString("base64")}`;
  const completion =
    input.completionImpl === undefined
      ? await createAiCompletion({
          provider: input.provider,
          apiKey: input.apiKey,
          fetchImpl: input.fetchImpl,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: input.prompt },
                { type: "image_url", image_url: { url: dataUrl, detail: "high" } }
              ]
            }
          ],
          temperature: 0,
          responseFormat: "text"
        })
      : await input.completionImpl({ prompt: input.prompt, dataUrl });
  const analysis = completion.content.trim();
  if (analysis.length === 0) throw new ValidationError("AI vision response was empty");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifactId = await storeVisionResult(input, { mediaType, byteLength: bytes.length, sha256, analysis });

  return {
    providerAlias: input.provider.alias,
    model: input.provider.model,
    analysis,
    mediaType,
    byteLength: bytes.length,
    sha256,
    ...(artifactId === undefined ? {} : { artifactId })
  };
}

async function storeVisionResult(
  input: RunAiVisionTestInput,
  image: {
    readonly mediaType: RunAiVisionTestResult["mediaType"];
    readonly byteLength: number;
    readonly sha256: string;
    readonly analysis: string;
  }
): Promise<string | undefined> {
  const runtime = await openSigilRuntime(input);
  try {
    const session = listSessionsForRepository(runtime.db, repoIdForPath(runtime.paths.cwd))[0];
    if (session === undefined) return undefined;
    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const artifactId = newId("art");
    const now = new Date().toISOString();
    const destination = isCloudAiProvider(input.provider) ? "cloud" : "local";
    const result = aiVisionResultSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "ai_vision_result",
      schema_version: 1,
      content_version: artifacts.filter((artifact) => artifact.type === "ai_vision_result").length + 1,
      created_at: now,
      producer: { type: "sigil" },
      sensitivity: "confidential",
      parents: [],
      content_sha256: "0".repeat(64),
      metadata: { purpose: "vision-capability-test" },
      provider_alias: input.provider.alias,
      model: input.provider.model,
      prompt: input.prompt,
      image: {
        source_name: basename(input.imagePath),
        media_type: image.mediaType,
        byte_length: image.byteLength,
        sha256: image.sha256
      },
      analysis: image.analysis,
      data_egress: { destination, consent: input.cloudImageConsent === true }
    });
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "ai_vision_result",
      contentVersion: result.content_version,
      mediaType: "application/json",
      content: `${JSON.stringify(result, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "ai_vision_result",
      schemaVersion: 1,
      contentVersion: result.content_version,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "valid",
      producerType: "sigil",
      createdAt: now
    });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "ai.vision_tested",
      actorType: "sigil",
      occurredAt: now,
      summary: "AI vision capability tested",
      metadata: { artifactId, providerAlias: input.provider.alias, destination }
    });
    return artifactId;
  } finally {
    closeSigilRuntime(runtime);
  }
}

function detectImageMediaType(bytes: Buffer): RunAiVisionTestResult["mediaType"] {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  throw new ValidationError("Vision input must be a PNG, JPEG, WebP, or GIF image");
}
