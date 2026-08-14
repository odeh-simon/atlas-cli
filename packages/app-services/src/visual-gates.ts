import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { fetchFigmaNodeImage, parseFigmaReference } from "@atlas/adapters-figma";
import { type CheckExecutionResult } from "@atlas/checks";
import { type AiCompletionResponse, type AiProviderConfig } from "@atlas/llm";
import { getCredentialToken, redactSecretText } from "@atlas/security";
import { type VisualCaptureAdapter, type VisualBrowserChannel, type VisualViewport } from "@atlas/visual-qa";

import { captureVisualPage, compareVisualEvidence, importFigmaVisualEvidence } from "./visual-qa.js";
import { runAiVisualReview } from "./visual-review.js";
import { type RuntimeOptions } from "./runtime.js";

export interface VisualAiReviewPolicy {
  readonly providerAlias?: string | undefined;
  readonly required: boolean;
  readonly failOn: readonly ("blocking" | "important" | "suggestion")[];
}

export interface VisualCheckDefinition {
  readonly name: string;
  readonly required: boolean;
  readonly url: string;
  readonly referencePath?: string | undefined;
  readonly figmaUrl?: string | undefined;
  readonly figmaScale: number;
  readonly viewport: VisualViewport;
  readonly fullPage: boolean;
  readonly browserChannel: VisualBrowserChannel;
  readonly timeoutMs: number;
  readonly pixelThreshold: number;
  readonly allowedDiffRatio: number;
  readonly maxPixels: number;
  readonly maxReferenceBytes: number;
  readonly dependsOn: readonly string[];
  readonly affected: readonly string[];
  readonly aiReview?: VisualAiReviewPolicy | undefined;
}

export interface VisualGateRuntimeOptions extends RuntimeOptions {
  readonly captureAdapter?: VisualCaptureAdapter | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly completionImpl?:
    | ((input: {
        readonly prompt: string;
        readonly images: readonly { readonly label: "reference" | "actual" | "diff"; readonly dataUrl: string }[];
      }) => Promise<AiCompletionResponse>)
    | undefined;
}

interface AtlasVisualConfig {
  readonly checks: readonly VisualCheckDefinition[];
  readonly providers: readonly AiProviderConfig[];
  readonly defaultProviderAlias?: string | undefined;
  readonly allowCloudImages?: boolean | undefined;
  readonly maxImageBytes?: number | undefined;
  readonly figmaTokenAlias: string;
}

export function readVisualCheckDefinitions(cwd: string): readonly VisualCheckDefinition[] {
  return readVisualConfig(cwd).checks;
}

export function visualCheckConfigFingerprint(cwd: string): string | undefined {
  const checks = readVisualCheckDefinitions(cwd);
  if (checks.length === 0) return undefined;
  const normalized = checks.map((check) => ({
    ...check,
    referenceSha256:
      check.referencePath === undefined ? undefined : hashLocalReference(cwd, check.referencePath)
  }));
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

export async function runConfiguredVisualCheck(
  definition: VisualCheckDefinition,
  options: VisualGateRuntimeOptions
): Promise<CheckExecutionResult> {
  const evidenceArtifactIds: string[] = [];
  try {
    const config = readVisualConfig(options.cwd ?? process.cwd());
    const referenceArtifactId = await resolveReference(definition, config, options, evidenceArtifactIds);
    const captured = await captureVisualPage({
      ...options,
      url: definition.url,
      viewport: definition.viewport,
      fullPage: definition.fullPage,
      browserChannel: definition.browserChannel,
      timeoutMs: definition.timeoutMs,
      captureAdapter: options.captureAdapter
    });
    evidenceArtifactIds.push(captured.captureArtifactId, captured.snapshotArtifactId);
    const compared = await compareVisualEvidence({
      ...options,
      ...(referenceArtifactId === undefined
        ? { referencePath: resolveReferencePath(options.cwd ?? process.cwd(), definition.referencePath ?? "") }
        : { referenceArtifactId }),
      actualArtifactId: captured.snapshotArtifactId,
      pixelThreshold: definition.pixelThreshold,
      allowedDiffRatio: definition.allowedDiffRatio,
      maxPixels: definition.maxPixels
    });
    evidenceArtifactIds.push(
      compared.referenceArtifactId,
      compared.actualArtifactId,
      compared.comparisonArtifactId,
      ...(compared.diffArtifactId === undefined ? [] : [compared.diffArtifactId])
    );

    const deterministicFailure = compared.status === "passed" ? undefined : `pixel comparison ${compared.status}`;
    const ai = await runOptionalAiReview(definition, config, options, compared.comparisonArtifactId);
    if (ai.reviewArtifactId !== undefined) evidenceArtifactIds.push(ai.reviewArtifactId);
    const failures = [deterministicFailure, ai.failure].filter((value): value is string => value !== undefined);
    const status = failures.length === 0 ? "passed" : "failed";
    const summary = [
      `${status === "passed" ? "Visual check passed" : "Visual check failed"}: ${compared.mismatchedPixels}/${compared.totalPixels} changed pixels (${compared.diffRatio.toFixed(6)})`,
      ...(failures.length === 0 ? [] : [`Failures: ${failures.join("; ")}`]),
      ...(ai.note === undefined ? [] : [ai.note])
    ].join(". ");
    return { status, summary, evidenceArtifactIds: unique(evidenceArtifactIds) };
  } catch (error) {
    return {
      status: "failed",
      summary: `Visual check could not run: ${redactSecretText(error instanceof Error ? error.message : String(error))}`,
      evidenceArtifactIds: unique(evidenceArtifactIds)
    };
  }
}

async function resolveReference(
  definition: VisualCheckDefinition,
  config: AtlasVisualConfig,
  options: VisualGateRuntimeOptions,
  evidenceArtifactIds: string[]
): Promise<string | undefined> {
  if (definition.figmaUrl === undefined) return undefined;
  const token = getCredentialToken({
    alias: config.figmaTokenAlias,
    provider: "figma",
    env: options.env
  });
  if (token === undefined) throw new Error(`Figma credential missing: ${config.figmaTokenAlias}`);
  const reference = parseFigmaReference(definition.figmaUrl);
  const image = await fetchFigmaNodeImage({
    apiKey: token,
    reference,
    scale: definition.figmaScale,
    maxBytes: definition.maxReferenceBytes,
    fetchImpl: options.fetchImpl
  });
  const imported = await importFigmaVisualEvidence({
    ...options,
    bytes: image.bytes,
    figmaUrl: reference.url,
    fileKey: reference.fileKey,
    nodeId: image.nodeId,
    scale: image.scale,
    source: "api",
    maxBytes: definition.maxReferenceBytes
  });
  evidenceArtifactIds.push(imported.evidenceArtifactId, imported.referenceArtifactId);
  return imported.referenceArtifactId;
}

async function runOptionalAiReview(
  definition: VisualCheckDefinition,
  config: AtlasVisualConfig,
  options: VisualGateRuntimeOptions,
  comparisonArtifactId: string
): Promise<{ readonly reviewArtifactId?: string; readonly failure?: string; readonly note?: string }> {
  const policy = definition.aiReview;
  if (policy === undefined) return {};
  try {
    const alias = policy.providerAlias ?? config.defaultProviderAlias;
    const provider = alias === undefined ? config.providers[0] : config.providers.find((candidate) => candidate.alias === alias);
    if (provider === undefined) throw new Error(alias === undefined ? "No AI provider configured" : `AI provider not configured: ${alias}`);
    const apiKey =
      provider.tokenAlias === undefined
        ? undefined
        : getCredentialToken({ alias: provider.tokenAlias, provider: "ai", env: options.env });
    if (provider.tokenAlias !== undefined && apiKey === undefined) throw new Error(`AI credential missing: ${provider.tokenAlias}`);
    const review = await runAiVisualReview({
      ...options,
      comparisonArtifactId,
      provider,
      apiKey,
      cloudImageConsent: config.allowCloudImages,
      maxImageBytes: config.maxImageBytes,
      completionImpl: options.completionImpl,
      fetchImpl: options.fetchImpl
    });
    const gatedFindings = policy.failOn.flatMap((severity) => {
      const count = review.severityCounts[severity];
      return count === 0 ? [] : [`${count} ${severity}`];
    });
    if (gatedFindings.length > 0) {
      return {
        reviewArtifactId: review.reviewArtifactId,
        failure: `AI visual findings met gate policy: ${gatedFindings.join(", ")}`
      };
    }
    if (review.status === "inconclusive" && policy.required) {
      return { reviewArtifactId: review.reviewArtifactId, failure: "AI visual review was inconclusive" };
    }
    return {
      reviewArtifactId: review.reviewArtifactId,
      note: `AI review ${review.status} with ${review.findingCount} finding(s)`
    };
  } catch (error) {
    const detail = redactSecretText(error instanceof Error ? error.message : String(error));
    return policy.required ? { failure: `required AI visual review failed: ${detail}` } : { note: `optional AI review unavailable: ${detail}` };
  }
}

function readVisualConfig(cwd: string): AtlasVisualConfig {
  const path = join(cwd, "atlas.config.json");
  if (!existsSync(path)) return { checks: [], providers: [], figmaTokenAlias: "figma.default" };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const visualQa = asOptionalRecord(raw.visualQa);
  const viewports = asOptionalRecord(visualQa?.viewports);
  const checks = Array.isArray(raw.checks)
    ? raw.checks.flatMap((value) => {
        const record = asOptionalRecord(value);
        return record?.kind === "visual" ? [parseVisualCheck(record, visualQa, viewports)] : [];
      })
    : [];
  const ai = asOptionalRecord(raw.ai);
  const providers = Array.isArray(ai?.providers) ? ai.providers.flatMap(parseProvider) : [];
  const adapters = asOptionalRecord(raw.adapters);
  const figma = asOptionalRecord(adapters?.figma);
  return {
    checks,
    providers,
    defaultProviderAlias: stringValue(ai?.defaultProviderAlias),
    allowCloudImages: typeof ai?.allowCloudImages === "boolean" ? ai.allowCloudImages : undefined,
    maxImageBytes: positiveInteger(ai?.maxImageBytes),
    figmaTokenAlias: stringValue(figma?.tokenAlias) ?? "figma.default"
  };
}

function parseVisualCheck(
  record: Record<string, unknown>,
  defaults: Record<string, unknown> | undefined,
  configuredViewports: Record<string, unknown> | undefined
): VisualCheckDefinition {
  const name = stringValue(record.name);
  const url = stringValue(record.url);
  const referencePath = stringValue(record.referencePath);
  const figmaUrl = stringValue(record.figmaUrl);
  if (name === undefined) throw new TypeError("Visual check requires name");
  if (url === undefined) throw new TypeError(`Visual check requires url: ${name}`);
  if ((referencePath === undefined) === (figmaUrl === undefined)) {
    throw new TypeError(`Visual check requires exactly one referencePath or figmaUrl: ${name}`);
  }
  const viewport = parseViewport(record.viewport, configuredViewports);
  const aiReviewRecord = asOptionalRecord(record.aiReview);
  return {
    name,
    required: record.required !== false,
    url,
    referencePath,
    figmaUrl,
    figmaScale: configuredBoundedNumber(record.figmaScale, 1, 0.01, 4, `${name}.figmaScale`),
    viewport,
    fullPage: record.fullPage === true,
    browserChannel: browserChannel(record.browserChannel ?? defaults?.browserChannel, name),
    timeoutMs: configuredPositiveInteger(record.timeoutMs ?? defaults?.timeoutMs, 30_000, `${name}.timeoutMs`),
    pixelThreshold: configuredBoundedNumber(
      record.pixelThreshold ?? defaults?.pixelThreshold,
      0.1,
      0,
      1,
      `${name}.pixelThreshold`
    ),
    allowedDiffRatio: configuredBoundedNumber(
      record.allowedDiffRatio ?? defaults?.allowedDiffRatio,
      0.01,
      0,
      1,
      `${name}.allowedDiffRatio`
    ),
    maxPixels: configuredPositiveInteger(record.maxPixels ?? defaults?.maxPixels, 20_000_000, `${name}.maxPixels`),
    maxReferenceBytes: configuredPositiveInteger(
      record.maxReferenceBytes ?? defaults?.maxReferenceBytes,
      10_000_000,
      `${name}.maxReferenceBytes`
    ),
    dependsOn: stringArray(record.dependsOn),
    affected: stringArray(record.affected),
    ...(aiReviewRecord === undefined
      ? {}
      : {
          aiReview: {
            providerAlias: stringValue(aiReviewRecord.providerAlias),
            required: aiReviewRecord.required === true,
            failOn: severityArray(aiReviewRecord.failOn)
          }
        })
  };
}

function parseViewport(value: unknown, configured: Record<string, unknown> | undefined): VisualViewport {
  if (value === "mobile") return viewportObject(configured?.mobile) ?? { width: 390, height: 844 };
  if (value === undefined || value === "desktop") return viewportObject(configured?.desktop) ?? { width: 1440, height: 900 };
  const parsed = viewportObject(value);
  if (parsed === undefined) throw new TypeError("Visual check viewport must be desktop, mobile, or a width/height object");
  return parsed;
}

function viewportObject(value: unknown): VisualViewport | undefined {
  const record = asOptionalRecord(value);
  const width = positiveInteger(record?.width);
  const height = positiveInteger(record?.height);
  return width === undefined || height === undefined || width < 240 || width > 7680 || height < 240 || height > 7680
    ? undefined
    : { width, height };
}

function parseProvider(value: unknown): AiProviderConfig[] {
  const record = asOptionalRecord(value);
  const alias = stringValue(record?.alias);
  const provider = record?.provider;
  const baseUrl = stringValue(record?.baseUrl);
  const model = stringValue(record?.model);
  if (alias === undefined || (provider !== "ollama" && provider !== "openai-compatible") || baseUrl === undefined || model === undefined) {
    return [];
  }
  return [{
    alias,
    provider,
    baseUrl,
    model,
    tokenAlias: stringValue(record?.tokenAlias),
    timeoutMs: positiveInteger(record?.timeoutMs),
    maxInputTokens: positiveInteger(record?.maxInputTokens),
    ...(record?.preset === "hetzner-inference" ? { preset: record.preset } : {}),
    capabilities: Array.isArray(record?.capabilities)
      ? record.capabilities.filter((item): item is "text" | "vision" => item === "text" || item === "vision")
      : undefined
  }];
}

function resolveReferencePath(cwd: string, path: string): string {
  const resolvedCwd = realpathSync(resolve(cwd));
  const candidatePath = resolve(resolvedCwd, path);
  const resolvedPath = existsSync(candidatePath) ? realpathSync(candidatePath) : candidatePath;
  const relation = relative(resolvedCwd, resolvedPath);
  if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new TypeError("Visual referencePath must stay within the repository root");
  }
  return resolvedPath;
}

function hashLocalReference(cwd: string, path: string): string {
  try {
    return createHash("sha256").update(readFileSync(resolveReferencePath(cwd, path))).digest("hex");
  } catch {
    return "missing";
  }
}

function browserChannel(value: unknown, checkName: string): VisualBrowserChannel {
  if (value === undefined) return "auto";
  if (value === "msedge" || value === "chrome" || value === "chromium" || value === "auto") return value;
  throw new TypeError(`${checkName}.browserChannel must be auto, msedge, chrome, or chromium`);
}

function severityArray(value: unknown): readonly ("blocking" | "important" | "suggestion")[] {
  if (value === undefined) return ["blocking"];
  if (!Array.isArray(value) || value.some((item) => item !== "blocking" && item !== "important" && item !== "suggestion")) {
    throw new TypeError("Visual aiReview.failOn accepts blocking, important, or suggestion");
  }
  return unique(value as Array<"blocking" | "important" | "suggestion">);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

function configuredPositiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = positiveInteger(value);
  if (parsed === undefined) throw new TypeError(`${label} must be a positive integer`);
  return parsed;
}

function configuredBoundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (value === undefined) return fallback;
  const parsed = boundedNumber(value, minimum, maximum);
  if (parsed === undefined) throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  return parsed;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
