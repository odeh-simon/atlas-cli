import { createHash } from "node:crypto";
import { Dirent, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export const contextDiscoveryPackage = "@atlas/context-discovery";

export type ContextSourceKind = "file" | "instruction" | "test";

export interface ContextDiscoveryBudget {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export interface ContextDiscoveryOptions {
  readonly rootPath: string;
  readonly budget?: Partial<ContextDiscoveryBudget> | undefined;
  readonly recommendations?: readonly ContextDiscoveryRecommendation[] | undefined;
  readonly taskText?: string | undefined;
}

export interface ContextDiscoveryRecommendation {
  readonly uri: string;
  readonly reason: string;
  readonly confidence: number;
}

export interface DiscoveredContextSource {
  readonly uri: string;
  readonly kind: ContextSourceKind;
  readonly reason: string;
  readonly sha256: string;
  readonly byte_length: number;
  readonly included: boolean;
  readonly exclusion_reason?: string | undefined;
  readonly rank: number;
  readonly deterministic_score: number;
  readonly ai_confidence?: number | undefined;
}

export interface ContextDiscoveryResult {
  readonly sources: readonly DiscoveredContextSource[];
  readonly includedSources: readonly DiscoveredContextSource[];
  readonly excludedCandidates: readonly DiscoveredContextSource[];
  readonly scannedFileCount: number;
  readonly omittedScanCount: number;
  readonly budgets: {
    readonly max_files: number;
    readonly max_bytes: number;
    readonly used_files: number;
    readonly used_bytes: number;
  };
  readonly freshness: "fresh" | "partial";
}

const defaultBudget: ContextDiscoveryBudget = {
  maxFiles: 40,
  maxBytes: 200_000
};

const excludedDirectories = new Set([
  ".atlas",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules"
]);

const excludedFileNames = new Set(["pnpm-lock.yaml"]);
const includedExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

export function discoverContextSources(options: ContextDiscoveryOptions): ContextDiscoveryResult {
  const rootPath = resolve(options.rootPath);
  const budget = {
    maxFiles: options.budget?.maxFiles ?? defaultBudget.maxFiles,
    maxBytes: options.budget?.maxBytes ?? defaultBudget.maxBytes
  };
  const recommendations = new Map((options.recommendations ?? []).map((recommendation) => [recommendation.uri, recommendation]));
  const taskTerms = extractTaskTerms(options.taskText ?? "");
  const candidates = listCandidateFiles(rootPath)
    .map((absolutePath) => toSource(rootPath, absolutePath))
    .filter((source): source is DiscoveredContextSource => source !== undefined)
    .map((source) => applyRecommendation(source, recommendations.get(source.uri)))
    .sort((a, b) => compareSources(a, b, recommendations, taskTerms));
  const candidateLimit = Math.min(candidates.length, budget.maxFiles + Math.min(20, budget.maxFiles));
  const rankedCandidates = candidates.slice(0, candidateLimit).map((source, index) => ({
    ...source,
    rank: index + 1,
    deterministic_score: deterministicScore(source.uri, taskTerms),
    ...(recommendations.get(source.uri) === undefined
      ? {}
      : { ai_confidence: recommendations.get(source.uri)?.confidence })
  }));

  const sources: DiscoveredContextSource[] = [];
  let usedFiles = 0;
  let usedBytes = 0;

  for (const source of rankedCandidates) {
    if (usedFiles >= budget.maxFiles) {
      sources.push({ ...source, included: false, exclusion_reason: "file budget exceeded" });
      continue;
    }
    if (usedBytes + source.byte_length > budget.maxBytes) {
      sources.push({ ...source, included: false, exclusion_reason: "byte budget exceeded" });
      continue;
    }

    sources.push(source);
    usedFiles += 1;
    usedBytes += source.byte_length;
  }

  const includedSources = sources.filter((source) => source.included);
  const excludedCandidates = sources.filter((source) => !source.included);
  return {
    sources,
    includedSources,
    excludedCandidates,
    scannedFileCount: candidates.length,
    omittedScanCount: candidates.length - rankedCandidates.length,
    budgets: {
      max_files: budget.maxFiles,
      max_bytes: budget.maxBytes,
      used_files: usedFiles,
      used_bytes: usedBytes
    },
    freshness: excludedCandidates.length > 0 || candidates.length > rankedCandidates.length ? "partial" : "fresh"
  };
}

function listCandidateFiles(rootPath: string): string[] {
  const files: string[] = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) continue;
    const entries = safeReadDir(directory).sort(compareDirents);
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) stack.push(path);
        continue;
      }
      if (entry.isFile() && shouldConsiderFile(entry.name)) {
        files.push(path);
      }
    }
  }
  return files;
}

function toSource(rootPath: string, absolutePath: string): DiscoveredContextSource | undefined {
  const bytes = readFileSync(absolutePath);
  if (bytes.includes(0)) return undefined;

  const uri = relative(rootPath, absolutePath).replaceAll("\\", "/");
  return {
    uri,
    kind: kindForPath(uri),
    reason: reasonForPath(uri),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_length: statSync(absolutePath).size,
    included: true,
    rank: 0,
    deterministic_score: 0
  };
}

function shouldConsiderFile(name: string): boolean {
  if (excludedFileNames.has(name)) return false;
  const lower = name.toLowerCase();
  for (const extension of includedExtensions) {
    if (lower.endsWith(extension)) return true;
  }
  return false;
}

function kindForPath(path: string): ContextSourceKind {
  const lower = path.toLowerCase();
  if (lower.includes(".test.") || lower.includes(".spec.") || lower.includes("__tests__/")) return "test";
  if (lower.includes("readme") || lower.includes("docs/") || lower.includes(".github/copilot")) return "instruction";
  return "file";
}

function reasonForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower === "package.json" || lower.endsWith("/package.json")) return "Package metadata";
  if (lower.includes("readme")) return "Project documentation";
  if (lower.includes("docs/")) return "Design or product documentation";
  if (lower.includes(".test.") || lower.includes(".spec.")) return "Existing test coverage";
  if (lower.startsWith("packages/")) return "Workspace source file";
  return "Repository source file";
}

function applyRecommendation(
  source: DiscoveredContextSource,
  recommendation: ContextDiscoveryRecommendation | undefined
): DiscoveredContextSource {
  if (recommendation === undefined) return source;
  return {
    ...source,
    reason: `AI recommended: ${recommendation.reason}; deterministic: ${source.reason}`
  };
}

function compareSources(
  a: DiscoveredContextSource,
  b: DiscoveredContextSource,
  recommendations: ReadonlyMap<string, ContextDiscoveryRecommendation>,
  taskTerms: ReadonlySet<string>
): number {
  const aiPriority = recommendationPriority(b, recommendations) - recommendationPriority(a, recommendations);
  if (aiPriority !== 0) return aiPriority;
  const taskPriority = taskRelevanceForPath(b.uri, taskTerms) - taskRelevanceForPath(a.uri, taskTerms);
  if (taskPriority !== 0) return taskPriority;
  const priority = priorityForPath(a.uri) - priorityForPath(b.uri);
  return priority === 0 ? a.uri.localeCompare(b.uri) : priority;
}

function recommendationPriority(
  source: DiscoveredContextSource,
  recommendations: ReadonlyMap<string, ContextDiscoveryRecommendation>
): number {
  const recommendation = recommendations.get(source.uri);
  return recommendation === undefined ? -1 : Math.round(recommendation.confidence * 1000);
}

function priorityForPath(path: string): number {
  const lower = path.toLowerCase();
  if (lower === "package.json") return 0;
  if (lower.includes("readme")) return 1;
  if (lower.startsWith("docs/")) return 2;
  if (lower.includes(".test.") || lower.includes(".spec.")) return 3;
  if (lower.startsWith("packages/")) return 4;
  return 5;
}

function extractTaskTerms(taskText: string): ReadonlySet<string> {
  const stopWords = new Set([
    "about",
    "after",
    "also",
    "and",
    "are",
    "because",
    "been",
    "before",
    "build",
    "can",
    "create",
    "does",
    "for",
    "from",
    "has",
    "have",
    "into",
    "its",
    "new",
    "not",
    "our",
    "should",
    "that",
    "the",
    "their",
    "this",
    "use",
    "using",
    "with"
  ]);
  const normalized = taskText
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length >= 3 && !stopWords.has(term));
  const terms = new Set<string>();
  for (const term of normalized) {
    terms.add(term);
    if (term.endsWith("s") && term.length > 4) terms.add(term.slice(0, -1));
    if (term.endsWith("ies") && term.length > 5) terms.add(`${term.slice(0, -3)}y`);
  }
  return terms;
}

function taskRelevanceForPath(path: string, taskTerms: ReadonlySet<string>): number {
  if (taskTerms.size === 0) return 0;
  const lower = path.toLowerCase();
  const pathTerms = new Set(lower.split(/[^a-z0-9]+/g).filter((term) => term.length > 0));
  let score = 0;
  for (const term of taskTerms) {
    if (pathTerms.has(term)) score += 6;
    else if (lower.includes(term)) score += 2;
  }
  if (score > 0 && (lower.endsWith(".tsx") || lower.endsWith(".ts") || lower.endsWith(".jsx") || lower.endsWith(".js"))) {
    score += 2;
  }
  if (score > 0 && (lower.includes(".test.") || lower.includes(".spec.") || lower.includes("__tests__/"))) {
    score += 1;
  }
  return score;
}

function deterministicScore(path: string, taskTerms: ReadonlySet<string>): number {
  return Math.max(0, 100 - priorityForPath(path) * 10) + taskRelevanceForPath(path, taskTerms);
}

function safeReadDir(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function compareDirents(a: Dirent, b: Dirent): number {
  return a.name.localeCompare(b.name);
}
