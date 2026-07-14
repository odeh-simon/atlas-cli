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
}

export interface DiscoveredContextSource {
  readonly uri: string;
  readonly kind: ContextSourceKind;
  readonly reason: string;
  readonly sha256: string;
  readonly byte_length: number;
  readonly included: boolean;
  readonly exclusion_reason?: string | undefined;
}

export interface ContextDiscoveryResult {
  readonly sources: readonly DiscoveredContextSource[];
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
  const candidates = listCandidateFiles(rootPath)
    .map((absolutePath) => toSource(rootPath, absolutePath))
    .filter((source): source is DiscoveredContextSource => source !== undefined)
    .sort(compareSources);

  const sources: DiscoveredContextSource[] = [];
  let usedFiles = 0;
  let usedBytes = 0;

  for (const source of candidates) {
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

  return {
    sources,
    budgets: {
      max_files: budget.maxFiles,
      max_bytes: budget.maxBytes,
      used_files: usedFiles,
      used_bytes: usedBytes
    },
    freshness: sources.some((source) => !source.included) ? "partial" : "fresh"
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
    included: true
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

function compareSources(a: DiscoveredContextSource, b: DiscoveredContextSource): number {
  const priority = priorityForPath(a.uri) - priorityForPath(b.uri);
  return priority === 0 ? a.uri.localeCompare(b.uri) : priority;
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
