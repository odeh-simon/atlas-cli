import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { redactSecretText } from "@atlas/security";

export type ContextSourceKind = "file" | "instruction" | "test" | "operation" | "evidence";
export type ContextCategory = "source" | "test" | "architecture" | "contract" | "schema" | "migration" | "operation" | "config" | "instruction";

export interface ContextDiscoveryBudget {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxScannedFiles: number;
  readonly maxGraphNodes: number;
  readonly maxGraphEdges: number;
  readonly maxEvidenceFragments: number;
  readonly maxExcerptBytes: number;
  readonly instructionMaxBytes: number;
  readonly graphDepth: number;
}

export interface ContextDiscoveryConfig extends ContextDiscoveryBudget {
  readonly pinnedSources: readonly string[];
  readonly exclusions: readonly string[];
  readonly requiredSourceGlobs: readonly string[];
  readonly requiredCategories: readonly ContextCategory[];
  readonly instructionFallbackFilenames: readonly string[];
  readonly requireResolvedImports: boolean;
}

export interface ContextDiscoveryRecommendation {
  readonly uri: string;
  readonly reason: string;
  readonly confidence: number;
}

export interface ContextDiscoverySnapshot {
  readonly rootPathHash?: string | undefined;
  readonly gitBaseFingerprint?: string | undefined;
  readonly gitHeadSha?: string | undefined;
  readonly taskBriefSha256?: string | undefined;
}

export interface ContextDiscoveryOptions {
  readonly rootPath: string;
  readonly budget?: Partial<ContextDiscoveryBudget> | undefined;
  readonly config?: Partial<ContextDiscoveryConfig> | undefined;
  readonly recommendations?: readonly ContextDiscoveryRecommendation[] | undefined;
  readonly taskText?: string | undefined;
  readonly snapshot?: ContextDiscoverySnapshot | undefined;
}

export interface ScoreFeature {
  readonly feature: string;
  readonly score: number;
  readonly evidence: string;
}

export interface DiscoveredContextSource {
  readonly uri: string;
  readonly kind: ContextSourceKind;
  readonly category: ContextCategory;
  readonly reason: string;
  readonly selection_reasons: readonly string[];
  readonly score_features: readonly ScoreFeature[];
  readonly relation_to_seeds: readonly string[];
  readonly sha256: string;
  readonly byte_length: number;
  readonly included: boolean;
  readonly exclusion_reason?: string | undefined;
  readonly rank: number;
  readonly deterministic_score: number;
  readonly ai_confidence?: number | undefined;
  readonly required: boolean;
  readonly pinned: boolean;
  readonly package_boundary?: string | undefined;
}

export interface SemanticSymbol {
  readonly id: string;
  readonly source_uri: string;
  readonly name: string;
  readonly kind: string;
  readonly exported: boolean;
  readonly line_start: number;
  readonly line_end: number;
}

export interface ContextRelation {
  readonly id: string;
  readonly kind: "import" | "re-export" | "test-association" | "instruction-scope";
  readonly from_uri: string;
  readonly to_uri: string;
  readonly rule: string;
  readonly evidence_fragment_id?: string | undefined;
}

export interface EvidenceFragment {
  readonly id: string;
  readonly source_uri: string;
  readonly source_sha256: string;
  readonly line_start: number;
  readonly line_end: number;
  readonly symbol_name?: string | undefined;
  readonly symbol_kind?: string | undefined;
  readonly excerpt: string;
  readonly excerpt_truncated: boolean;
  readonly reason: string;
  readonly classification: "fact" | "inference";
}

export interface InstructionEvidence {
  readonly uri: string;
  readonly sha256: string;
  readonly scope_directory: string;
  readonly precedence: number;
  readonly filename: string;
  readonly applies_to: readonly string[];
  readonly byte_length: number;
  readonly included_bytes: number;
  readonly truncated: boolean;
}

export interface DiscoveryGap {
  readonly id: string;
  readonly severity: "blocking" | "warning" | "info";
  readonly code: string;
  readonly description: string;
  readonly uri?: string | undefined;
}

export interface ContextDiscoveryResult {
  readonly algorithm: { readonly name: "atlas-semantic-context"; readonly version: "3.0.0" };
  readonly configSha256: string;
  readonly effectiveConfig: ContextDiscoveryConfig;
  readonly taskTerms: readonly string[];
  readonly seeds: readonly { readonly uri: string; readonly score: number; readonly reasons: readonly string[] }[];
  readonly sources: readonly DiscoveredContextSource[];
  readonly includedSources: readonly DiscoveredContextSource[];
  readonly excludedCandidates: readonly DiscoveredContextSource[];
  readonly symbols: readonly SemanticSymbol[];
  readonly relations: readonly ContextRelation[];
  readonly evidenceFragments: readonly EvidenceFragment[];
  readonly instructionChain: readonly InstructionEvidence[];
  readonly gaps: readonly DiscoveryGap[];
  readonly scannedFileCount: number;
  readonly omittedScanCount: number;
  readonly budgets: {
    readonly max_files: number;
    readonly max_bytes: number;
    readonly used_files: number;
    readonly used_bytes: number;
    readonly max_graph_nodes: number;
    readonly used_graph_nodes: number;
    readonly max_graph_edges: number;
    readonly used_graph_edges: number;
    readonly max_evidence_fragments: number;
    readonly used_evidence_fragments: number;
    readonly instruction_max_bytes: number;
    readonly instruction_used_bytes: number;
  };
  readonly freshness: "fresh" | "partial";
}

export class ContextConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContextConfigurationError";
  }
}

const defaults: ContextDiscoveryConfig = {
  maxFiles: 40,
  maxBytes: 200_000,
  maxScannedFiles: 2_000,
  maxGraphNodes: 500,
  maxGraphEdges: 1_500,
  maxEvidenceFragments: 200,
  maxExcerptBytes: 1_200,
  instructionMaxBytes: 64_000,
  graphDepth: 2,
  pinnedSources: [],
  exclusions: [],
  requiredSourceGlobs: [],
  requiredCategories: [],
  instructionFallbackFilenames: [],
  requireResolvedImports: false
};

const excludedDirectories = new Set([".atlas", ".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules", "out", "target"]);
const excludedFileNames = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);
const includedExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);
const semanticExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const secretPathPattern = /(^|[/\\])(\.env(?:\.|$)|\.npmrc$|\.pypirc$|id_(?:rsa|dsa|ed25519)(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$))/i;

interface CandidateFile {
  readonly uri: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly lines: readonly string[];
  readonly sha256: string;
  readonly byteLength: number;
  readonly kind: ContextSourceKind;
  readonly category: ContextCategory;
  readonly packageBoundary?: string | undefined;
  readonly symbols: readonly SemanticSymbol[];
  readonly importRecords: readonly ImportRecord[];
}

interface ImportRecord {
  readonly specifier: string;
  readonly kind: "import" | "re-export";
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly excerpt: string;
}

interface RawRelation {
  readonly kind: ContextRelation["kind"];
  readonly fromUri: string;
  readonly toUri: string;
  readonly rule: string;
  readonly importRecord?: ImportRecord | undefined;
}

export function readContextDiscoveryConfig(rootPath: string): { readonly config: ContextDiscoveryConfig; readonly sha256: string } {
  const configPath = join(rootPath, "atlas.config.json");
  if (!existsSync(configPath)) return effectiveConfig(undefined);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new ContextConfigurationError(`atlas.config.json is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ContextConfigurationError("atlas.config.json must be an object");
  }
  const context = (parsed as Record<string, unknown>).context;
  return effectiveConfig(context);
}

export function discoverContextSources(options: ContextDiscoveryOptions): ContextDiscoveryResult {
  const configured = effectiveConfig(options.config);
  const config: ContextDiscoveryConfig = {
    ...configured.config,
    ...(options.budget?.maxFiles === undefined ? {} : { maxFiles: positiveInteger(options.budget.maxFiles, "maxFiles") }),
    ...(options.budget?.maxBytes === undefined ? {} : { maxBytes: positiveInteger(options.budget.maxBytes, "maxBytes") })
  };
  const configSha256 = stableHash(config);
  const realRoot = realpathSync(resolve(options.rootPath));
  const gaps: DiscoveryGap[] = [];
  const taskTerms = [...extractTaskTerms(options.taskText ?? "")].sort();
  const taskTermSet = new Set(taskTerms);
  const listed = listCandidateFiles(realRoot, config, gaps);
  const compiler = compilerConfiguration(realRoot);
  if (compiler.issue !== undefined) gaps.push(gap("typescript-config-warning", "warning", compiler.issue));
  const candidates = listed.files.map((file) => buildCandidate(realRoot, file, compiler.options, listed.packageBoundaries, config, gaps));
  const byUri = new Map(candidates.map((candidate) => [candidate.uri, candidate]));
  const recommendationByUri = new Map<string, ContextDiscoveryRecommendation>();
  for (const recommendation of options.recommendations ?? []) {
    if (!byUri.has(normalizeUri(recommendation.uri))) {
      gaps.push(gap("unknown-ai-candidate", "warning", `AI recommendation referenced unknown repository candidate: ${recommendation.uri}`, recommendation.uri));
      continue;
    }
    recommendationByUri.set(normalizeUri(recommendation.uri), recommendation);
  }

  const evidence: EvidenceFragment[] = [];
  const rawRelations: RawRelation[] = [];
  const compilerOptionsCache = new Map<string, { readonly options: ts.CompilerOptions; readonly issue?: string }>();
  for (const candidate of candidates.filter((item) => semanticExtensions.has(extname(item.uri).toLowerCase()))) {
    for (const record of candidate.importRecords) {
      const resolution = resolveLocalModule(candidate.absolutePath, record.specifier, compiler.options, realRoot, compilerOptionsCache);
      if (resolution.issue !== undefined) {
        gaps.push(gap("typescript-config-warning", "warning", resolution.issue, candidate.uri));
      }
      const resolvedUri = resolution.uri;
      if (resolvedUri === undefined || !byUri.has(resolvedUri)) {
        if (isRepositorySpecifier(record.specifier, resolution.options)) {
          gaps.push(gap(
            "unresolved-local-import",
            config.requireResolvedImports ? "blocking" : "warning",
            `Unresolved local module '${record.specifier}' imported by ${candidate.uri}`,
            candidate.uri
          ));
        }
        continue;
      }
      rawRelations.push({ kind: record.kind, fromUri: candidate.uri, toUri: resolvedUri, rule: "typescript-module-resolution", importRecord: record });
    }
  }
  addTestAssociationRelations(candidates, rawRelations);

  const scored = candidates.map((candidate) => scoreCandidate(candidate, taskTermSet, recommendationByUri.get(candidate.uri), config));
  const seeds = scored
    .filter((item) => item.score > 0 || item.pinned || item.required)
    .sort(compareScored)
    .slice(0, Math.min(8, config.maxGraphNodes))
    .map((item) => ({ uri: item.candidate.uri, score: item.score, reasons: item.features.map((feature) => feature.evidence) }));
  const relationReasons = expandRelations(seeds.map((seed) => seed.uri), rawRelations, config.graphDepth, config.maxGraphNodes, config.maxGraphEdges);
  const requiredUris = requiredSourceUris(candidates, config, gaps);
  const preliminaryCandidateLimit = Math.min(config.maxGraphNodes, config.maxFiles + Math.min(20, config.maxFiles));
  const preliminaryScopes = [...scored]
    .map((item) => ({ ...item, relationReasons: relationReasons.get(item.candidate.uri) ?? [] }))
    .sort((a, b) => compareForSelection(a, b, requiredUris))
    .filter((item, index) => index < preliminaryCandidateLimit || requiredUris.has(item.candidate.uri))
    .map((item) => item.candidate.uri);
  const instructionDiscovery = discoverInstructions(
    realRoot,
    candidates,
    new Set([...seeds.map((seed) => seed.uri), ...relationReasons.keys(), ...requiredUris, ...preliminaryScopes]),
    config,
    gaps
  );
  for (const relation of instructionDiscovery.relations) rawRelations.push(relation);

  for (const instruction of instructionDiscovery.instructions) requiredUris.add(instruction.uri);
  const activeInstructionUris = new Set(instructionDiscovery.instructions.map((instruction) => instruction.uri));
  const ordered = scored
    .map((item) => ({ ...item, relationReasons: relationReasons.get(item.candidate.uri) ?? [] }))
    .sort((a, b) => compareForSelection(a, b, requiredUris));

  const candidateLimit = Math.min(config.maxGraphNodes, config.maxFiles + Math.min(20, config.maxFiles));
  const selectionItems = ordered.filter((item, index) => index < candidateLimit || requiredUris.has(item.candidate.uri));
  const selected: DiscoveredContextSource[] = [];
  let usedFiles = 0;
  let usedBytes = 0;
  for (const [orderedIndex, item] of selectionItems.slice(0, config.maxGraphNodes).entries()) {
    const required = requiredUris.has(item.candidate.uri);
    const inactiveInstruction = item.candidate.category === "instruction" && !activeInstructionUris.has(item.candidate.uri);
    const excluded = inactiveInstruction || matchesAny(item.candidate.uri, config.exclusions);
    const overFiles = usedFiles >= config.maxFiles;
    const overBytes = usedBytes + item.candidate.byteLength > config.maxBytes;
    const included = !excluded && !overFiles && !overBytes && (required || item.score > 0 || item.relationReasons.length > 0 || usedFiles < config.maxFiles);
    const exclusionReason = excluded
      ? inactiveInstruction ? "inactive instruction shadowed by higher-precedence file" : "explicitly excluded"
      : overFiles
        ? "file budget exceeded"
        : overBytes
          ? "byte budget exceeded"
          : included
            ? undefined
            : "not selected by task or semantic relations";
    if (required && !included) {
      gaps.push(gap("required-source-omitted", "blocking", `Required source could not be included: ${item.candidate.uri} (${exclusionReason})`, item.candidate.uri));
    }
    if (included) {
      usedFiles += 1;
      usedBytes += item.candidate.byteLength;
    }
    selected.push(toDiscoveredSource(item, included, exclusionReason, required, orderedIndex + 1, recommendationByUri.get(item.candidate.uri)));
  }
  for (const requiredUri of [...requiredUris].sort()) {
    if (!byUri.has(requiredUri)) continue;
    if (!selected.some((source) => source.uri === requiredUri)) {
      gaps.push(gap("required-source-omitted", "blocking", `Required source omitted by graph node bound: ${requiredUri}`, requiredUri));
    }
  }

  const includedSources = selected.filter((source) => source.included).sort((a, b) => a.rank - b.rank || a.uri.localeCompare(b.uri));
  const selectedUris = new Set(includedSources.map((source) => source.uri));
  const relations = finalizeRelations(rawRelations, selectedUris, byUri, evidence, config);
  const symbols = candidates
    .filter((candidate) => selectedUris.has(candidate.uri))
    .flatMap((candidate) => candidate.symbols)
    .sort((a, b) => a.source_uri.localeCompare(b.source_uri) || a.line_start - b.line_start || a.name.localeCompare(b.name))
    .slice(0, config.maxGraphNodes);
  addSourceEvidence(includedSources, byUri, symbols, taskTermSet, evidence, config);
  addMissingTestWarnings(includedSources, relations, gaps);
  const instructionChain = instructionDiscovery.instructions
    .filter((instruction) => selectedUris.has(instruction.uri))
    .map((instruction) => ({ ...instruction, applies_to: instruction.applies_to.filter((uri) => selectedUris.has(uri)) }));

  const excludedCandidates = selected.filter((source) => !source.included);
  const graphTruncated = rawRelations.length > config.maxGraphEdges || candidates.length > config.maxGraphNodes;
  if (graphTruncated) gaps.push(gap("graph-budget-pressure", "warning", "Semantic graph expansion was bounded by configured node/edge limits."));
  const omittedScanCount = listed.omittedCount + Math.max(0, candidates.length - selectionItems.length);
  const freshness = omittedScanCount > 0 || excludedCandidates.length > 0 || graphTruncated ? "partial" : "fresh";
  return {
    algorithm: { name: "atlas-semantic-context", version: "3.0.0" },
    configSha256,
    effectiveConfig: config,
    taskTerms,
    seeds,
    sources: selected,
    includedSources,
    excludedCandidates,
    symbols,
    relations,
    evidenceFragments: evidence.sort((a, b) => a.source_uri.localeCompare(b.source_uri) || a.line_start - b.line_start || a.id.localeCompare(b.id)).slice(0, config.maxEvidenceFragments),
    instructionChain,
    gaps: dedupeGaps(gaps),
    scannedFileCount: candidates.length,
    omittedScanCount,
    budgets: {
      max_files: config.maxFiles,
      max_bytes: config.maxBytes,
      used_files: usedFiles,
      used_bytes: usedBytes,
      max_graph_nodes: config.maxGraphNodes,
      used_graph_nodes: includedSources.length,
      max_graph_edges: config.maxGraphEdges,
      used_graph_edges: relations.length,
      max_evidence_fragments: config.maxEvidenceFragments,
      used_evidence_fragments: Math.min(evidence.length, config.maxEvidenceFragments),
      instruction_max_bytes: config.instructionMaxBytes,
      instruction_used_bytes: instructionChain.reduce((sum, instruction) => sum + instruction.included_bytes, 0)
    },
    freshness
  };
}

function effectiveConfig(raw: unknown): { readonly config: ContextDiscoveryConfig; readonly sha256: string } {
  if (raw === undefined) return { config: defaults, sha256: stableHash(defaults) };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ContextConfigurationError("context configuration must be an object");
  const record = raw as Record<string, unknown>;
  const allowed = new Set([
    "maxFiles", "maxBytes", "maxScannedFiles", "maxGraphNodes", "maxGraphEdges", "maxEvidenceFragments", "maxExcerptBytes",
    "instructionMaxBytes", "graphDepth", "pinnedSources", "exclusions", "requiredSourceGlobs", "requiredCategories",
    "instructionFallbackFilenames", "requireResolvedImports"
  ]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ContextConfigurationError(`Unknown context configuration fields: ${unknown.sort().join(", ")}`);
  const config: ContextDiscoveryConfig = {
    maxFiles: integerField(record, "maxFiles", defaults.maxFiles),
    maxBytes: integerField(record, "maxBytes", defaults.maxBytes),
    maxScannedFiles: integerField(record, "maxScannedFiles", defaults.maxScannedFiles),
    maxGraphNodes: integerField(record, "maxGraphNodes", defaults.maxGraphNodes),
    maxGraphEdges: integerField(record, "maxGraphEdges", defaults.maxGraphEdges),
    maxEvidenceFragments: integerField(record, "maxEvidenceFragments", defaults.maxEvidenceFragments),
    maxExcerptBytes: integerField(record, "maxExcerptBytes", defaults.maxExcerptBytes),
    instructionMaxBytes: integerField(record, "instructionMaxBytes", defaults.instructionMaxBytes),
    graphDepth: integerField(record, "graphDepth", defaults.graphDepth, 0),
    pinnedSources: stringArrayField(record, "pinnedSources"),
    exclusions: stringArrayField(record, "exclusions"),
    requiredSourceGlobs: stringArrayField(record, "requiredSourceGlobs"),
    requiredCategories: categoryArrayField(record.requiredCategories),
    instructionFallbackFilenames: stringArrayField(record, "instructionFallbackFilenames"),
    requireResolvedImports: booleanField(record, "requireResolvedImports", defaults.requireResolvedImports)
  };
  return { config, sha256: stableHash(config) };
}

function listCandidateFiles(root: string, config: ContextDiscoveryConfig, gaps: DiscoveryGap[]): {
  readonly files: readonly string[];
  readonly omittedCount: number;
  readonly packageBoundaries: readonly string[];
} {
  const files: string[] = [];
  const packages: string[] = [];
  let discoveredCount = 0;
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        gaps.push(gap("unsafe-symlink-entry", "warning", `Skipped symbolic link during discovery: ${normalizeUri(relative(root, path))}`, normalizeUri(relative(root, path))));
        continue;
      }
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) queue.push(path);
        continue;
      }
      if (!entry.isFile() || !shouldConsiderFile(entry.name, config)) continue;
      discoveredCount += 1;
      if (entry.name === "package.json") packages.push(normalizeUri(relative(root, directory)) || ".");
      if (files.length >= config.maxScannedFiles && !isInstructionFilename(entry.name, config)) continue;
      try {
        const safe = safeFile(root, path);
        if (!safe.binary && !safe.secret) files.push(safe.path);
      } catch (error) {
        gaps.push(gap("unsafe-source", "warning", error instanceof Error ? error.message : String(error), normalizeUri(relative(root, path))));
      }
    }
  }
  return { files, omittedCount: Math.max(0, discoveredCount - files.length), packageBoundaries: packages.sort() };
}

function buildCandidate(
  root: string,
  absolutePath: string,
  compilerOptions: ts.CompilerOptions,
  packageBoundaries: readonly string[],
  config: ContextDiscoveryConfig,
  gaps: DiscoveryGap[]
): CandidateFile {
  const safe = safeFile(root, absolutePath);
  const uri = normalizeUri(relative(root, safe.path));
  const content = safe.bytes.toString("utf8");
  const lines = content.split(/\r?\n/);
  const category = categoryForPath(uri, content, config);
  const kind: ContextSourceKind = category === "instruction" ? "instruction" : category === "test" ? "test" : category === "operation" ? "operation" : "file";
  const semantic = semanticExtensions.has(extname(uri).toLowerCase())
    ? parseSemanticFile(uri, safe.path, content)
    : { symbols: [] as SemanticSymbol[], imports: [] as ImportRecord[] };
  for (const record of semantic.imports) {
    if (record.lineStart < 1 || record.lineEnd > lines.length) gaps.push(gap("invalid-source-range", "blocking", `Parser returned unverifiable line range for ${uri}`, uri));
  }
  return {
    uri,
    absolutePath: safe.path,
    content,
    lines,
    sha256: safe.sha256,
    byteLength: safe.bytes.byteLength,
    kind,
    category,
    packageBoundary: nearestPackageBoundary(uri, packageBoundaries),
    symbols: semantic.symbols,
    importRecords: semantic.imports
  };
}

function parseSemanticFile(uri: string, absolutePath: string, content: string): { readonly symbols: SemanticSymbol[]; readonly imports: ImportRecord[] } {
  const kind = scriptKind(absolutePath);
  const source = ts.createSourceFile(absolutePath, content, ts.ScriptTarget.Latest, true, kind);
  const symbols: SemanticSymbol[] = [];
  const imports: ImportRecord[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(importRecord(source, statement, statement.moduleSpecifier.text, "import"));
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(importRecord(source, statement, statement.moduleSpecifier.text, "re-export"));
    }
    for (const symbol of symbolsForStatement(uri, source, statement)) symbols.push(symbol);
  }
  return {
    symbols: symbols.sort((a, b) => a.line_start - b.line_start || a.name.localeCompare(b.name)),
    imports: imports.sort((a, b) => a.lineStart - b.lineStart || a.specifier.localeCompare(b.specifier))
  };
}

function symbolsForStatement(uri: string, source: ts.SourceFile, statement: ts.Statement): SemanticSymbol[] {
  const declarations: Array<{ name: string; kind: string; node: ts.Node }> = [];
  if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) declarations.push({ name: statement.name.text, kind: "function", node: statement });
  else if (ts.isClassDeclaration(statement) && statement.name !== undefined) declarations.push({ name: statement.name.text, kind: "class", node: statement });
  else if (ts.isInterfaceDeclaration(statement)) declarations.push({ name: statement.name.text, kind: "interface", node: statement });
  else if (ts.isTypeAliasDeclaration(statement)) declarations.push({ name: statement.name.text, kind: "type", node: statement });
  else if (ts.isEnumDeclaration(statement)) declarations.push({ name: statement.name.text, kind: "enum", node: statement });
  else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declarations.push({ name: declaration.name.text, kind: "variable", node: declaration });
    }
  }
  const exported = hasExportModifier(statement);
  return declarations.map((declaration) => {
    const start = source.getLineAndCharacterOfPosition(declaration.node.getStart(source)).line + 1;
    const end = source.getLineAndCharacterOfPosition(declaration.node.getEnd()).line + 1;
    return {
      id: stableId("sym", `${uri}:${declaration.name}:${declaration.kind}:${start}:${end}`),
      source_uri: uri,
      name: declaration.name,
      kind: declaration.kind,
      exported,
      line_start: start,
      line_end: end
    };
  });
}

function importRecord(source: ts.SourceFile, node: ts.Node, specifier: string, kind: ImportRecord["kind"]): ImportRecord {
  const lineStart = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const lineEnd = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { specifier, kind, lineStart, lineEnd, excerpt: source.text.slice(node.getStart(source), node.getEnd()).trim() };
}

function compilerConfiguration(root: string): { readonly options: ts.CompilerOptions; readonly issue?: string } {
  const path = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (path === undefined) return { options: { allowJs: true, moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext } };
  const raw = ts.readConfigFile(typeScriptPath(path), ts.sys.readFile);
  const fallback = { allowJs: true, moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext };
  if (raw.error !== undefined) return { options: fallback, issue: `Unable to parse tsconfig.json: ${diagnosticText(raw.error)}` };
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, typeScriptPath(dirname(path)));
  const issue = parsed.errors.length > 0
    ? `tsconfig.json has invalid compiler configuration: ${diagnosticText(parsed.errors[0]!)}`
    : parsed.projectReferences !== undefined && parsed.projectReferences.length > 0
      ? "tsconfig.json project references are indexed through resolvable paths; unresolved referenced-package imports will be reported as gaps"
      : undefined;
  return { options: parsed.options, ...(issue === undefined ? {} : { issue }) };
}

function resolveLocalModule(
  containingFile: string,
  specifier: string,
  rootOptions: ts.CompilerOptions,
  root: string,
  cache: Map<string, { readonly options: ts.CompilerOptions; readonly issue?: string }>
): { readonly uri?: string; readonly issue?: string; readonly options: ts.CompilerOptions } {
  const local = compilerOptionsForFile(containingFile, root, rootOptions, cache);
  const options = local.options;
  if (!isRepositorySpecifier(specifier, options)) return { options, ...(local.issue === undefined ? {} : { issue: local.issue }) };
  const resolved = ts.resolveModuleName(specifier, containingFile, options, ts.sys).resolvedModule?.resolvedFileName;
  if (resolved === undefined || resolved.includes("/node_modules/") || resolved.includes("\\node_modules\\")) return { options, ...(local.issue === undefined ? {} : { issue: local.issue }) };
  try {
    const real = realpathSync(resolved);
    assertContained(root, real);
    return { uri: normalizeUri(relative(root, real)), options, ...(local.issue === undefined ? {} : { issue: local.issue }) };
  } catch {
    return { options, ...(local.issue === undefined ? {} : { issue: local.issue }) };
  }
}

function compilerOptionsForFile(
  containingFile: string,
  root: string,
  fallback: ts.CompilerOptions,
  cache: Map<string, { readonly options: ts.CompilerOptions; readonly issue?: string }>
): { readonly options: ts.CompilerOptions; readonly issue?: string } {
  let directory = dirname(containingFile);
  while (true) {
    const cached = cache.get(directory);
    if (cached !== undefined) return cached;
    const path = join(directory, "tsconfig.json");
    if (existsSync(path)) {
      const raw = ts.readConfigFile(typeScriptPath(path), ts.sys.readFile);
      let value: { readonly options: ts.CompilerOptions; readonly issue?: string };
      if (raw.error !== undefined) {
        value = { options: fallback, issue: `Unable to parse package-local tsconfig ${normalizeUri(relative(root, path))}: ${diagnosticText(raw.error)}` };
      } else {
        const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, typeScriptPath(directory));
        const issue = parsed.errors.length > 0
          ? `Package-local tsconfig has invalid compiler configuration ${normalizeUri(relative(root, path))}: ${diagnosticText(parsed.errors[0]!)}`
          : parsed.projectReferences !== undefined && parsed.projectReferences.length > 0
            ? `Package-local tsconfig project references in ${normalizeUri(relative(root, path))} are indexed through resolvable paths; unresolved referenced-package imports will be reported as gaps`
            : undefined;
        value = { options: parsed.options, ...(issue === undefined ? {} : { issue }) };
      }
      cache.set(directory, value);
      return value;
    }
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory || relative(root, parent).startsWith("..")) break;
    directory = parent;
  }
  return { options: fallback };
}

function addTestAssociationRelations(candidates: readonly CandidateFile[], relations: RawRelation[]): void {
  const byUri = new Map(candidates.map((candidate) => [candidate.uri, candidate]));
  const existing = new Set(relations.map((relation) => `${relation.fromUri}->${relation.toUri}`));
  for (const test of candidates.filter((candidate) => candidate.category === "test")) {
    for (const relation of relations.filter((item) => item.fromUri === test.uri && item.kind === "import")) {
      if (byUri.get(relation.toUri)?.category !== "test") {
        relations.push({ kind: "test-association", fromUri: relation.toUri, toUri: test.uri, rule: "test-imports-production" });
      }
    }
    const normalizedTestStem = testStem(test.uri);
    const named = candidates
      .filter((candidate) => candidate.category !== "test" && testStem(candidate.uri) === normalizedTestStem)
      .sort((a, b) => a.uri.localeCompare(b.uri))[0];
    if (named !== undefined && !existing.has(`${named.uri}->${test.uri}`)) {
      relations.push({ kind: "test-association", fromUri: named.uri, toUri: test.uri, rule: "co-located-test-name" });
    }
  }
}

function discoverInstructions(
  root: string,
  candidates: readonly CandidateFile[],
  scopeSources: ReadonlySet<string>,
  config: ContextDiscoveryConfig,
  gaps: DiscoveryGap[]
): { readonly instructions: readonly InstructionEvidence[]; readonly relations: readonly RawRelation[] } {
  const byUri = new Map(candidates.map((candidate) => [candidate.uri, candidate]));
  const byInstructionUri = new Map<string, { candidate: CandidateFile; applies: Set<string>; precedence: number }>();
  const fallbackNames = config.instructionFallbackFilenames.filter((name) => name !== "AGENTS.md" && name !== "AGENTS.override.md");
  for (const sourceUri of [...scopeSources].sort()) {
    const directories = directoriesRootToScope(dirname(sourceUri));
    for (let precedence = 0; precedence < directories.length; precedence += 1) {
      const directory = directories[precedence]!;
      const names = ["AGENTS.override.md", "AGENTS.md", ...fallbackNames];
      const instructionUri = names.map((name) => normalizeUri(join(directory === "." ? "" : directory, name))).find((uri) => byUri.has(uri));
      if (instructionUri === undefined) continue;
      const current = byInstructionUri.get(instructionUri) ?? { candidate: byUri.get(instructionUri)!, applies: new Set<string>(), precedence };
      current.applies.add(sourceUri);
      byInstructionUri.set(instructionUri, current);
    }
  }
  let remaining = config.instructionMaxBytes;
  const instructions: InstructionEvidence[] = [];
  for (const value of [...byInstructionUri.values()].sort((a, b) => a.precedence - b.precedence || a.candidate.uri.localeCompare(b.candidate.uri))) {
    const includedBytes = Math.min(remaining, value.candidate.byteLength);
    remaining -= includedBytes;
    const truncated = includedBytes < value.candidate.byteLength;
    if (truncated) gaps.push(gap("instruction-budget-exceeded", "blocking", `Instruction evidence could not fit configured budget: ${value.candidate.uri}`, value.candidate.uri));
    instructions.push({
      uri: value.candidate.uri,
      sha256: value.candidate.sha256,
      scope_directory: normalizeUri(dirname(value.candidate.uri)),
      precedence: value.precedence,
      filename: basename(value.candidate.uri),
      applies_to: [...value.applies].sort(),
      byte_length: value.candidate.byteLength,
      included_bytes: includedBytes,
      truncated
    });
  }
  const relations = instructions.flatMap((instruction) => instruction.applies_to.map((sourceUri) => ({
    kind: "instruction-scope" as const,
    fromUri: instruction.uri,
    toUri: sourceUri,
    rule: instruction.filename === "AGENTS.override.md" ? "codex-override-precedence" : instruction.filename === "AGENTS.md" ? "codex-agents-precedence" : "configured-instruction-fallback"
  })));
  return { instructions, relations };
}

function requiredSourceUris(candidates: readonly CandidateFile[], config: ContextDiscoveryConfig, gaps: DiscoveryGap[]): Set<string> {
  const required = new Set<string>();
  const byUri = new Map(candidates.map((candidate) => [candidate.uri, candidate]));
  for (const pin of config.pinnedSources.map(normalizeUri).sort()) {
    if (!byUri.has(pin)) gaps.push(gap("required-pin-missing", "blocking", `Pinned context source is absent or unsafe: ${pin}`, pin));
    else required.add(pin);
  }
  for (const pattern of config.requiredSourceGlobs) {
    const matches = candidates.filter((candidate) => globMatches(candidate.uri, pattern));
    if (matches.length === 0) gaps.push(gap("required-glob-empty", "blocking", `Required source glob matched no safe files: ${pattern}`));
    for (const match of matches) required.add(match.uri);
  }
  for (const category of config.requiredCategories) {
    const matches = candidates.filter((candidate) => candidate.category === category);
    if (matches.length === 0) gaps.push(gap("required-category-empty", "blocking", `Required evidence category is absent: ${category}`));
    for (const match of matches) required.add(match.uri);
  }
  return required;
}

function scoreCandidate(candidate: CandidateFile, terms: ReadonlySet<string>, recommendation: ContextDiscoveryRecommendation | undefined, config: ContextDiscoveryConfig) {
  const features: ScoreFeature[] = [];
  const pathTerms = new Set(candidate.uri.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const matchingPathTerms = [...terms].filter((term) => pathTerms.has(term));
  if (matchingPathTerms.length > 0) features.push({ feature: "task-path-term", score: matchingPathTerms.length * 12, evidence: `Path matches task terms: ${matchingPathTerms.join(", ")}` });
  const matchingSymbols = candidate.symbols.filter((symbol) => [...terms].some((term) => symbol.name.toLowerCase().includes(term))).map((symbol) => symbol.name);
  if (matchingSymbols.length > 0) features.push({ feature: "task-symbol-term", score: Math.min(40, matchingSymbols.length * 15), evidence: `Symbols match task terms: ${matchingSymbols.slice(0, 5).join(", ")}` });
  if (candidate.category === "architecture") features.push({ feature: "architecture-evidence", score: 4, evidence: "Architecture/ADR path or heading evidence" });
  if (candidate.category === "test" && (matchingPathTerms.length > 0 || matchingSymbols.length > 0)) features.push({ feature: "task-test-evidence", score: 8, evidence: "Task-relevant test evidence" });
  if (candidate.uri === "package.json" || candidate.uri.endsWith("/package.json")) features.push({ feature: "package-boundary", score: 6, evidence: "Package boundary metadata" });
  if (recommendation !== undefined) features.push({ feature: "ai-rerank", score: Math.round(recommendation.confidence * 10), evidence: `AI recommended real candidate: ${recommendation.reason}` });
  const pinned = config.pinnedSources.map(normalizeUri).includes(candidate.uri);
  const required = pinned || config.requiredSourceGlobs.some((pattern) => globMatches(candidate.uri, pattern)) || config.requiredCategories.includes(candidate.category);
  return { candidate, features, score: features.reduce((sum, feature) => sum + feature.score, 0), pinned, required };
}

function expandRelations(seedUris: readonly string[], relations: readonly RawRelation[], maxDepth: number, maxNodes: number, maxEdges: number): Map<string, string[]> {
  const reasons = new Map<string, string[]>();
  const visited = new Set(seedUris);
  let frontier = [...seedUris].sort();
  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && visited.size < maxNodes; depth += 1) {
    const next = new Set<string>();
    for (const relation of relations.slice(0, maxEdges)) {
      const adjacent = frontier.includes(relation.fromUri) ? relation.toUri : frontier.includes(relation.toUri) ? relation.fromUri : undefined;
      if (adjacent === undefined || visited.has(adjacent)) continue;
      const entries = reasons.get(adjacent) ?? [];
      entries.push(`${relation.kind}:${relation.rule}:depth-${depth}`);
      reasons.set(adjacent, entries.sort());
      next.add(adjacent);
      if (visited.size + next.size >= maxNodes) break;
    }
    for (const uri of next) visited.add(uri);
    frontier = [...next].sort();
  }
  return reasons;
}

function toDiscoveredSource(
  item: ReturnType<typeof scoreCandidate> & { readonly relationReasons: readonly string[] },
  included: boolean,
  exclusionReason: string | undefined,
  required: boolean,
  rank: number,
  recommendation: ContextDiscoveryRecommendation | undefined
): DiscoveredContextSource {
  const reasons = [...item.features.map((feature) => feature.evidence), ...item.relationReasons];
  if (required) reasons.unshift(item.pinned ? "Pinned by context configuration" : "Required by context configuration or instruction scope");
  return {
    uri: item.candidate.uri,
    kind: item.candidate.kind,
    category: item.candidate.category,
    reason: reasons[0] ?? reasonForCategory(item.candidate.category),
    selection_reasons: reasons.length > 0 ? reasons : [reasonForCategory(item.candidate.category)],
    score_features: item.features,
    relation_to_seeds: item.relationReasons,
    sha256: item.candidate.sha256,
    byte_length: item.candidate.byteLength,
    included,
    ...(exclusionReason === undefined ? {} : { exclusion_reason: exclusionReason }),
    rank,
    deterministic_score: item.score,
    ...(recommendation === undefined ? {} : { ai_confidence: recommendation.confidence }),
    required,
    pinned: item.pinned,
    ...(item.candidate.packageBoundary === undefined ? {} : { package_boundary: item.candidate.packageBoundary })
  };
}

function compareForSelection(a: ReturnType<typeof scoreCandidate> & { relationReasons: readonly string[] }, b: ReturnType<typeof scoreCandidate> & { relationReasons: readonly string[] }, requiredUris: ReadonlySet<string>): number {
  const required = Number(requiredUris.has(b.candidate.uri)) - Number(requiredUris.has(a.candidate.uri));
  if (required !== 0) return required;
  const related = Number(b.relationReasons.length > 0) - Number(a.relationReasons.length > 0);
  if (related !== 0) return related;
  return compareScored(a, b);
}

function compareScored(a: ReturnType<typeof scoreCandidate>, b: ReturnType<typeof scoreCandidate>): number {
  return b.score - a.score || categoryPriority(a.candidate.category) - categoryPriority(b.candidate.category) || a.candidate.uri.localeCompare(b.candidate.uri);
}

function finalizeRelations(raw: readonly RawRelation[], selected: ReadonlySet<string>, byUri: ReadonlyMap<string, CandidateFile>, evidence: EvidenceFragment[], config: ContextDiscoveryConfig): ContextRelation[] {
  const relations: ContextRelation[] = [];
  for (const relation of raw
    .filter((item) => selected.has(item.fromUri) && selected.has(item.toUri))
    .sort((a, b) => a.fromUri.localeCompare(b.fromUri) || a.toUri.localeCompare(b.toUri) || a.kind.localeCompare(b.kind))
    .slice(0, config.maxGraphEdges)) {
    let evidenceId: string | undefined;
    if (relation.importRecord !== undefined && evidence.length < config.maxEvidenceFragments) {
      const source = byUri.get(relation.fromUri)!;
      const fragment = fragmentForRange(source, relation.importRecord.lineStart, relation.importRecord.lineEnd, `${relation.kind} edge to ${relation.toUri}`, "fact", config.maxExcerptBytes);
      evidence.push(fragment);
      evidenceId = fragment.id;
    }
    relations.push({
      id: stableId("rel", `${relation.kind}:${relation.fromUri}:${relation.toUri}:${relation.rule}`),
      kind: relation.kind,
      from_uri: relation.fromUri,
      to_uri: relation.toUri,
      rule: relation.rule,
      ...(evidenceId === undefined ? {} : { evidence_fragment_id: evidenceId })
    });
  }
  return dedupeRelations(relations);
}

function addSourceEvidence(
  sources: readonly DiscoveredContextSource[],
  byUri: ReadonlyMap<string, CandidateFile>,
  symbols: readonly SemanticSymbol[],
  taskTerms: ReadonlySet<string>,
  evidence: EvidenceFragment[],
  config: ContextDiscoveryConfig
): void {
  for (const source of sources) {
    if (evidence.length >= config.maxEvidenceFragments) break;
    const candidate = byUri.get(source.uri)!;
    const symbol = symbols
      .filter((item) => item.source_uri === source.uri)
      .sort((a, b) => Number(symbolMatches(b, taskTerms)) - Number(symbolMatches(a, taskTerms)) || a.line_start - b.line_start)[0];
    const start = symbol?.line_start ?? 1;
    const end = Math.min(candidate.lines.length, symbol === undefined ? Math.min(12, candidate.lines.length) : symbol.line_end);
    const fragment = fragmentForRange(candidate, start, Math.max(start, end), source.selection_reasons.join("; "), "fact", config.maxExcerptBytes, symbol);
    if (!evidence.some((item) => item.id === fragment.id)) evidence.push(fragment);
  }
}

function fragmentForRange(candidate: CandidateFile, lineStart: number, lineEnd: number, reason: string, classification: EvidenceFragment["classification"], maxBytes: number, symbol?: SemanticSymbol): EvidenceFragment {
  if (lineStart < 1 || lineEnd < lineStart || lineEnd > candidate.lines.length) throw new Error(`Unverifiable evidence range for ${candidate.uri}:${lineStart}-${lineEnd}`);
  const exact = redactSecretText(candidate.lines.slice(lineStart - 1, lineEnd).join("\n"));
  const truncated = truncateUtf8(exact, maxBytes);
  return {
    id: stableId("frag", `${candidate.uri}:${candidate.sha256}:${lineStart}:${lineEnd}:${reason}`),
    source_uri: candidate.uri,
    source_sha256: candidate.sha256,
    line_start: lineStart,
    line_end: lineEnd,
    ...(symbol === undefined ? {} : { symbol_name: symbol.name, symbol_kind: symbol.kind }),
    excerpt: truncated.value,
    excerpt_truncated: truncated.truncated,
    reason: reason.slice(0, 1_000) || "Selected repository evidence",
    classification
  };
}

function truncateUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  let used = 0;
  let output = "";
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return { value: output, truncated: true };
}

function typeScriptPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").replaceAll(/\s+/g, " ").trim().slice(0, 500);
}

function addMissingTestWarnings(sources: readonly DiscoveredContextSource[], relations: readonly ContextRelation[], gaps: DiscoveryGap[]): void {
  for (const source of sources.filter((item) => item.category === "source" && semanticExtensions.has(extname(item.uri).toLowerCase()))) {
    if (!relations.some((relation) => relation.kind === "test-association" && relation.from_uri === source.uri)) {
      gaps.push(gap("no-associated-test", "warning", `Selected implementation source has no associated test evidence: ${source.uri}`, source.uri));
    }
  }
}

function safeFile(root: string, path: string): { readonly path: string; readonly bytes: Buffer; readonly sha256: string; readonly binary: boolean; readonly secret: boolean } {
  const lexical = resolve(path);
  assertContained(root, lexical);
  const lstat = lstatSync(lexical);
  if (lstat.isSymbolicLink()) throw new Error(`Unsafe symlink source: ${normalizeUri(relative(root, lexical))}`);
  const real = realpathSync(lexical);
  assertContained(root, real);
  if (!statSync(real).isFile()) throw new Error(`Context source is not a regular file: ${normalizeUri(relative(root, real))}`);
  const uri = normalizeUri(relative(root, real));
  const secret = secretPathPattern.test(uri);
  const bytes = readFileSync(real);
  return { path: real, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), binary: bytes.subarray(0, 8_192).includes(0), secret };
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error(`Context path escapes repository root: ${path}`);
}

function shouldConsiderFile(name: string, config: ContextDiscoveryConfig): boolean {
  if (excludedFileNames.has(name)) return false;
  if (isInstructionFilename(name, config)) return true;
  return includedExtensions.has(extname(name).toLowerCase());
}

function isInstructionFilename(name: string, config: ContextDiscoveryConfig): boolean {
  return name === "AGENTS.md" || name === "AGENTS.override.md" || config.instructionFallbackFilenames.includes(name);
}

function categoryForPath(uri: string, content: string, config: ContextDiscoveryConfig): ContextCategory {
  const lower = uri.toLowerCase();
  if (basename(uri) === "AGENTS.md" || basename(uri) === "AGENTS.override.md" || config.instructionFallbackFilenames.includes(basename(uri))) return "instruction";
  if (/(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/.test(lower)) return "test";
  if (/(^|\/)(adr|adrs|architecture|docs)(\/|$)|(^|\/)readme(?:\.|$)/.test(lower) || /^#\s+(architecture|adr|decision)/im.test(content.slice(0, 2_000))) return "architecture";
  if (/openapi|asyncapi|contract|proto|graphql|\.d\.ts$/.test(lower)) return "contract";
  if (/(^|\/)(schema|schemas)(\/|$)|schema\.[^.]+$/.test(lower)) return "schema";
  if (/(^|\/)(migration|migrations)(\/|$)/.test(lower)) return "migration";
  if (/(^|\/)(runbook|runbooks|ops|operations)(\/|$)|dockerfile|compose\.ya?ml$/.test(lower)) return "operation";
  if (/(^|\/)(package\.json|tsconfig[^/]*\.json|atlas\.config\.json|vite\.config\.|vitest\.config\.|eslint)/.test(lower)) return "config";
  return "source";
}

function reasonForCategory(category: ContextCategory): string {
  return ({ source: "Repository implementation source", test: "Existing test coverage", architecture: "Architecture or ADR evidence", contract: "API or contract evidence", schema: "Schema evidence", migration: "Migration evidence", operation: "Operational evidence", config: "Project/package configuration", instruction: "Repository instruction evidence" })[category];
}

function categoryPriority(category: ContextCategory): number {
  return ({ instruction: 0, config: 1, architecture: 2, test: 3, source: 4, contract: 5, schema: 6, migration: 7, operation: 8 })[category];
}

function nearestPackageBoundary(uri: string, boundaries: readonly string[]): string | undefined {
  return boundaries.filter((boundary) => boundary === "." || uri === boundary || uri.startsWith(`${boundary}/`)).sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

function directoriesRootToScope(path: string): string[] {
  const normalized = normalizeUri(path);
  if (normalized === "." || normalized === "") return ["."];
  const parts = normalized.split("/");
  return [".", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

function testStem(uri: string): string {
  return normalizeUri(uri).replace(/\.(test|spec)(?=\.)/i, "").replace(/\/__tests__\//, "/");
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function scriptKind(path: string): ts.ScriptKind {
  const extension = extname(path).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

function isRepositorySpecifier(specifier: string, options: ts.CompilerOptions): boolean {
  if (isLocalSpecifier(specifier)) return true;
  return Object.keys(options.paths ?? {}).some((pattern) => {
    const escaped = pattern.replace(/[\\^$+?.()|{}[\]]/g, "\\$&").replace("*", ".*");
    return new RegExp(`^${escaped}$`).test(specifier);
  });
}

function extractTaskTerms(taskText: string): ReadonlySet<string> {
  const stopWords = new Set(["about", "after", "also", "and", "are", "because", "been", "before", "build", "can", "create", "does", "for", "from", "has", "have", "into", "its", "new", "not", "our", "should", "that", "the", "their", "this", "use", "using", "with"]);
  const values = taskText.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3 && !stopWords.has(term));
  const terms = new Set<string>();
  for (const value of values) {
    terms.add(value);
    if (value.endsWith("ies") && value.length > 5) terms.add(`${value.slice(0, -3)}y`);
    else if (value.endsWith("s") && value.length > 4) terms.add(value.slice(0, -1));
  }
  return terms;
}

function symbolMatches(symbol: SemanticSymbol, terms: ReadonlySet<string>): boolean {
  const name = symbol.name.toLowerCase();
  return [...terms].some((term) => name.includes(term));
}

function globMatches(uri: string, glob: string): boolean {
  const normalized = normalizeUri(glob);
  const pattern = normalized.split("").map((character, index, all) => {
    if (character === "*" && all[index + 1] === "*") return "§";
    if (character === "*" && all[index - 1] === "*") return "";
    if (character === "*") return "[^/]*";
    if (character === "?") return "[^/]";
    if (character === "§") return ".*";
    return /[\\^$+?.()|{}\[\]]/.test(character) ? `\\${character}` : character;
  }).join("").replaceAll("§", ".*");
  return new RegExp(`^${pattern}$`).test(normalizeUri(uri));
}

function matchesAny(uri: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globMatches(uri, glob));
}

function normalizeUri(uri: string): string {
  const normalized = uri.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === "" ? "." : normalized;
}

function gap(code: string, severity: DiscoveryGap["severity"], description: string, uri?: string): DiscoveryGap {
  return { id: stableId("gap", `${code}:${uri ?? ""}:${description}`), severity, code, description, ...(uri === undefined ? {} : { uri }) };
}

function dedupeGaps(gaps: readonly DiscoveryGap[]): DiscoveryGap[] {
  return [...new Map(gaps.map((item) => [item.id, item])).values()].sort((a, b) => severityPriority(a.severity) - severityPriority(b.severity) || a.id.localeCompare(b.id));
}

function dedupeRelations(relations: readonly ContextRelation[]): ContextRelation[] {
  return [...new Map(relations.map((item) => [item.id, item])).values()];
}

function severityPriority(severity: DiscoveryGap["severity"]): number {
  return severity === "blocking" ? 0 : severity === "warning" ? 1 : 2;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortObject(value))).digest("hex");
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortObject(item)]));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new ContextConfigurationError(`${name} must be a positive integer`);
  return value;
}

function integerField(record: Record<string, unknown>, key: string, fallback: number, minimum = 1): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum) throw new ContextConfigurationError(`context.${key} must be an integer >= ${minimum}`);
  return value as number;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) throw new ContextConfigurationError(`context.${key} must be an array of non-empty strings`);
  return [...new Set(value.map((item) => (item as string).trim()))].sort();
}

function categoryArrayField(value: unknown): ContextCategory[] {
  if (value === undefined) return [];
  const allowed = new Set<ContextCategory>(["source", "test", "architecture", "contract", "schema", "migration", "operation", "config", "instruction"]);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !allowed.has(item as ContextCategory))) throw new ContextConfigurationError("context.requiredCategories contains an unsupported category");
  return [...new Set(value as ContextCategory[])].sort();
}

function booleanField(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ContextConfigurationError(`context.${key} must be boolean`);
  return value;
}
