import { PersistenceError } from "@sigil/domain";

import type { EvidenceAnalyzer } from "./contract.js";
import { createTypeScriptAnalyzer } from "./typescript-analyzer.js";

const registry = new Map<string, EvidenceAnalyzer>();

export function registerAnalyzer(analyzer: EvidenceAnalyzer): void {
  const key = `${analyzer.identity.name}@${analyzer.identity.version}`;
  if (registry.has(key)) {
    throw new PersistenceError(`Duplicate analyzer registration: ${key}`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(analyzer.identity.name)) {
    throw new PersistenceError(`Invalid analyzer name: ${analyzer.identity.name}`);
  }
  if (analyzer.identity.capabilities.length === 0) {
    throw new PersistenceError(`Analyzer must declare capabilities: ${key}`);
  }
  // Trusted built-ins only – reject undeclared capabilities containing path-like content
  for (const cap of analyzer.identity.capabilities) {
    if (cap.includes("/") || cap.includes("\\") || cap.includes("..")) {
      throw new PersistenceError(`Invalid capability: ${cap}`);
    }
  }
  registry.set(key, analyzer);
}

export function getAnalyzer(name: string, version: string): EvidenceAnalyzer | undefined {
  return registry.get(`${name}@${version}`);
}

export function listAnalyzers(): readonly EvidenceAnalyzer[] {
  return [...registry.values()].sort((a, b) => a.identity.name.localeCompare(b.identity.name) || a.identity.version.localeCompare(b.identity.version));
}

export function selectAnalyzersForFile(uri: string): readonly EvidenceAnalyzer[] {
  const ext = uri.split(".").pop()?.toLowerCase() ?? "";
  const selected: EvidenceAnalyzer[] = [];
  for (const analyzer of registry.values()) {
    if (analyzer.identity.extensions.includes(`.${ext}`) || analyzer.identity.extensions.includes(ext)) {
      selected.push(analyzer);
    }
  }
  return selected.sort((a, b) => a.identity.name.localeCompare(b.identity.name));
}

export function clearAnalyzerRegistry(): void {
  registry.clear();
}

export function resolveRequestedAnalyzersExact(
  requested: readonly { name: string; version: string }[]
): readonly EvidenceAnalyzer[] {
  const resolved: EvidenceAnalyzer[] = [];
  for (const ref of requested) {
    const found = registry.get(`${ref.name}@${ref.version}`);
    if (found === undefined) {
      throw new PersistenceError(
        `Unknown analyzer version: ${ref.name}@${ref.version}`
      );
    }
    resolved.push(found);
  }
  return [...resolved].sort((a, b) =>
    a.identity.name.localeCompare(b.identity.name) ||
    a.identity.version.localeCompare(b.identity.version)
  );
}

export function ensureDefaultAnalyzersRegistered(): void {
  if (registry.size > 0) return;
  registerAnalyzer(createTypeScriptAnalyzer());
}

// Validate analyzer output before persistence
export function validateAnalyzerOutput(output: unknown): void {
  if (typeof output !== "object" || output === null) throw new PersistenceError("Analyzer output must be an object");
  // Further Zod validation done by caller against evidence schemas
}
