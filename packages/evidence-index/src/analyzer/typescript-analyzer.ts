import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

import { CancellationError, PersistenceError, deriveId, stableHash } from "@atlas/domain";
import {
  TYPESCRIPT_ANALYZER_NAME,
  TYPESCRIPT_ANALYZER_VERSION,
  type AnalyzerGap,
  type EvidenceApiEvidence,
  type EvidenceEdge,
  type EvidenceSymbol,
  type EvidenceTestAssociation,
  type EvidenceConfigEvidence
} from "@atlas/schemas";

export const TYPESCRIPT_ANALYZER_FINGERPRINT = fingerprintForAnalyzer();

function redactSecretText(value: string): string {
  return value.replace(/(sk-[a-zA-Z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|token\s*[:=]\s*\S+)/gi, "[REDACTED]");
}

import type { AnalyzerInput, AnalyzerOutput, EvidenceAnalyzer } from "./contract.js";

const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;
const SUPPORTED_LANGUAGES = ["typescript", "javascript"] as const;

function fingerprintForAnalyzer(): string {
  return stableHash({ name: TYPESCRIPT_ANALYZER_NAME, version: TYPESCRIPT_ANALYZER_VERSION, impl: "ts-compiler-api" });
}

export function createTypeScriptAnalyzer(): EvidenceAnalyzer {
  return {
    identity: {
      name: TYPESCRIPT_ANALYZER_NAME,
      version: TYPESCRIPT_ANALYZER_VERSION,
      fingerprint: fingerprintForAnalyzer(),
      languages: [...SUPPORTED_LANGUAGES],
      extensions: [...SUPPORTED_EXTENSIONS],
      capabilities: ["symbols", "imports", "re-exports", "test-associations", "package-boundaries", "api-evidence", "caller-callee-static"],
      unsupported: ["framework-runtime-graph", "polymorphic-calls", "reflective-calls", "whole-program-dataflow"]
    },
    analyze(input: AnalyzerInput): AnalyzerOutput {
      const started = Date.now();
      // Truthful provenance: implementation version is authoritative.
      // A caller-supplied version must exactly match, otherwise fail closed.
      const requested = input.analyzerVersions.find((v) => v.name === TYPESCRIPT_ANALYZER_NAME)?.version;
      if (requested !== undefined && requested !== TYPESCRIPT_ANALYZER_VERSION) {
        throw new PersistenceError(
          `Analyzer version mismatch: requested ${TYPESCRIPT_ANALYZER_NAME}@${requested} but implementation is ${TYPESCRIPT_ANALYZER_VERSION}`
        );
      }
      const implVersion = TYPESCRIPT_ANALYZER_VERSION;
      const gaps: AnalyzerGap[] = [];
      const diagnostics: { code: string; severity: "blocking" | "warning" | "info"; message: string; uri?: string; blocking: boolean }[] = [];
      const symbols: EvidenceSymbol[] = [];
      const edges: EvidenceEdge[] = [];
      const testAssociations: EvidenceTestAssociation[] = [];
      const apiEvidence: EvidenceApiEvidence[] = [];
      const configEvidence: EvidenceConfigEvidence[] = [];

      if (input.signal?.aborted) throw new CancellationError("Analyzer cancelled");

      const root = resolve(input.rootPath);
      const limits = input.limits ?? {};
      const maxNodes = limits.maxGraphNodes ?? 500;
      const maxEdges = limits.maxGraphEdges ?? 1500;
      const maxDiagnostics = limits.maxDiagnostics ?? 100;
      const wallClockMs = limits.wallClockMs ?? 30_000;

      const fileByUri = new Map(input.files.map((f) => [f.uri, f]));
      const uriByFileId = new Map(input.files.map((f) => [f.fileId, f.uri]));
      const shaByUri = new Map(input.files.map((f) => [f.uri, f.contentSha256]));

      // Discover tsconfigs and package boundaries
      const packageBoundaries = discoverPackageBoundaries(root, input.files.map((f) => f.uri));
      const compiler = compilerConfiguration(root, gaps);

      // Build candidate map with content
      const candidates: Candidate[] = [];
      for (const file of input.files) {
        if (Date.now() - started > wallClockMs) {
          gaps.push(makeGap(input.repositoryId, "graph-resource-limit", "warning", `Analyzer wall-clock exceeded ${wallClockMs}ms`, undefined, false, "wall-clock"));
          break;
        }
        if (input.signal?.aborted) throw new CancellationError("Analyzer cancelled");
        const ext = extname(file.uri).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.includes(ext as typeof SUPPORTED_EXTENSIONS[number])) {
          gaps.push(makeGap(input.repositoryId, "unsupported-language", "info", `Unsupported extension ${ext} for ${file.uri}`, file.uri, false, "language"));
          continue;
        }
        // Security: already filtered before – but double-check secret/binary not included
        // (evidence-index engine filters before calling analyzer; we trust input.files are safe)
        try {
          const absolute = join(root, ...file.uri.split("/"));
          const content = readFileSync(absolute, "utf8");
          const lines = content.split(/\r?\n/);
          const kind = scriptKind(file.uri);
          const source = ts.createSourceFile(absolute, content, ts.ScriptTarget.Latest, true, kind);
          candidates.push({ file, absolute, content, lines, source, sha: file.contentSha256 });
        } catch (error) {
          gaps.push(makeGap(input.repositoryId, "unsupported-syntax", "warning", `Failed to parse ${file.uri}: ${error instanceof Error ? error.message : String(error)}`, file.uri, false, "parse"));
          if (gaps.length >= maxDiagnostics) break;
        }
      }

      const byUri = new Map(candidates.map((c) => [c.file.uri, c]));
      const compilerOptionsCache = new Map<string, { options: ts.CompilerOptions; issue?: string }>();
      // Surface malformed local tsconfigs even when a file has no imports.
      for (const cand of candidates) {
        compilerOptionsForFile(cand.absolute, root, compiler.options, compilerOptionsCache, gaps, input.repositoryId);
      }

      // Symbols + imports/re-exports
      const importEdges: { from: Candidate; toUri: string; specifier: string; kind: "import" | "re-export"; line: number; col: number; endLine: number; endCol: number }[] = [];
      for (const cand of candidates) {
        if (symbols.length >= maxNodes) {
          gaps.push(makeGap(input.repositoryId, "graph-resource-limit", "warning", `Symbol limit ${maxNodes} exceeded`, cand.file.uri, false, "symbols"));
          break;
        }
        const syms = symbolsForSource(cand, input.repositoryId, packageBoundaries);
        for (const s of syms) {
          if (symbols.length >= maxNodes) break;
          symbols.push(s);
          // API evidence for exported functions
          if (s.exported && (s.kind === "function" || s.kind === "variable" || s.kind === "class")) {
            apiEvidence.push({
              api_evidence_id: deriveId("evapi", [input.repositoryId, s.symbol_id]),
              file_id: cand.file.fileId,
              uri: cand.file.uri,
              source_sha256: cand.sha,
              name: s.name,
              surface: "exported-function",
              line_start: s.line_start,
              line_end: s.line_end,
              col_start: s.col_start,
              col_end: s.col_end,
              proof: "exact",
              analyzer_name: TYPESCRIPT_ANALYZER_NAME,
              analyzer_version: implVersion
            } as EvidenceApiEvidence);
          }
        }

        // Imports / re-exports
        for (const stmt of cand.source.statements) {
          if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
            const spec = stmt.moduleSpecifier.text;
            const resolved = resolveLocalModule(cand.absolute, spec, compiler.options, root, compilerOptionsCache, gaps, input.repositoryId);
            if (resolved.uri && byUri.has(resolved.uri)) {
              const { line, col, endLine, endCol } = spanForNode(cand.source, stmt);
              importEdges.push({ from: cand, toUri: resolved.uri, specifier: spec, kind: "import", line, col, endLine, endCol });
            } else if (isRepositorySpecifier(spec, resolved.options)) {
              gaps.push(makeGap(input.repositoryId, "unresolved-module", "warning", `Unresolved local import '${spec}' in ${cand.file.uri}`, cand.file.uri, false, "module-resolution"));
            } else if (isDynamicSpecifier(spec)) {
              gaps.push(makeGap(input.repositoryId, "dynamic-import", "info", `Dynamic import specifier in ${cand.file.uri}: '${spec}'`, cand.file.uri, false, "dynamic"));
            }
            if (isDynamicSpecifier(spec)) {
              gaps.push(makeGap(input.repositoryId, "dynamic-import", "info", `Dynamic specifier not statically resolvable: ${spec}`, cand.file.uri, false, "dynamic"));
            }
          } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
            const spec = stmt.moduleSpecifier.text;
            const resolved = resolveLocalModule(cand.absolute, spec, compiler.options, root, compilerOptionsCache, gaps, input.repositoryId);
            if (resolved.uri && byUri.has(resolved.uri)) {
              const { line, col, endLine, endCol } = spanForNode(cand.source, stmt);
              importEdges.push({ from: cand, toUri: resolved.uri, specifier: spec, kind: "re-export", line, col, endLine, endCol });
            } else if (isRepositorySpecifier(spec, resolved.options)) {
              gaps.push(makeGap(input.repositoryId, "unresolved-module", "warning", `Unresolved re-export '${spec}' in ${cand.file.uri}`, cand.file.uri, false, "module-resolution"));
            }
          } else if (ts.isImportEqualsDeclaration(stmt)) {
            gaps.push(makeGap(input.repositoryId, "unsupported-syntax", "info", `Unsupported import equals in ${cand.file.uri}`, cand.file.uri, false, "import-equals"));
          }
        }

        // Detect dynamic imports `import(spec)` where spec is not string literal
        for (const node of findNodes(cand.source, ts.SyntaxKind.CallExpression)) {
          const call = node as ts.CallExpression;
          if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
            gaps.push(makeGap(input.repositoryId, "dynamic-import", "info", `Dynamic import() not statically resolvable in ${cand.file.uri}`, cand.file.uri, false, "dynamic"));
          }
        }

        // Config evidence for package.json/tsconfig etc. (handled separately below)
      }

      // Build import/re-export edges with deterministic IDs
      for (const e of importEdges) {
        if (edges.length >= maxEdges) {
          gaps.push(makeGap(input.repositoryId, "graph-resource-limit", "warning", `Edge limit ${maxEdges} exceeded`, e.from.file.uri, false, "edges"));
          break;
        }
        const toFile = byUri.get(e.toUri);
        if (!toFile) continue;
        const fromSha = shaByUri.get(e.from.file.uri)!;
        const toSha = shaByUri.get(e.toUri)!;
        edges.push({
          edge_id: deriveId("evedge", [input.repositoryId, e.kind, e.from.file.uri, e.toUri, e.specifier]),
          kind: e.kind,
          from_file_id: e.from.file.fileId,
          to_file_id: toFile.file.fileId,
          from_uri: e.from.file.uri,
          to_uri: e.toUri,
          rule: e.kind === "import" ? "typescript-module-resolution" : "typescript-re-export-resolution",
          resolution: "static",
          proof: "exact",
          analyzer_name: TYPESCRIPT_ANALYZER_NAME,
          analyzer_version: implVersion,
          from_source_sha256: fromSha,
          to_source_sha256: toSha,
          from_line_start: e.line,
          from_line_end: e.endLine,
          from_col_start: e.col,
          from_col_end: e.endCol
        } as EvidenceEdge);
      }

      // Reverse dependents are implicit via edges; no extra storage needed.

      // Package boundaries as gaps/info? Already discovered.

      // Test associations: deterministic via import + co-located name
      const testCandidates = candidates.filter((c) => isTestUri(c.file.uri));
      const sourceCandidates = candidates.filter((c) => !isTestUri(c.file.uri));
      const byTestUri = new Set(testCandidates.map((c) => c.file.uri));
      // via imports: test -> source
      for (const test of testCandidates) {
        for (const edge of importEdges.filter((e) => e.from.file.uri === test.file.uri)) {
          const src = byUri.get(edge.toUri);
          if (src && !isTestUri(src.file.uri)) {
            const rule = "test-imports-production";
            testAssociations.push({
              association_id: deriveId("evtassoc", [input.repositoryId, edge.toUri, test.file.uri, rule]),
              test_file_id: test.file.fileId,
              source_file_id: src.file.fileId,
              test_uri: test.file.uri,
              source_uri: src.file.uri,
              rule,
              proof: "exact",
              analyzer_name: TYPESCRIPT_ANALYZER_NAME,
              analyzer_version: implVersion,
              source_sha256: shaByUri.get(src.file.uri),
              test_sha256: shaByUri.get(test.file.uri)
            } as EvidenceTestAssociation);
          }
        }
        // co-located nearest: stem match
        const stem = testStem(test.file.uri);
        const matches = sourceCandidates.filter((s) => testStem(s.file.uri) === stem).sort((a,b)=>a.file.uri.localeCompare(b.file.uri));
        if (matches.length > 0) {
          const src = matches[0]!;
          if (!testAssociations.some((a) => a.source_uri === src.file.uri && a.test_uri === test.file.uri)) {
            testAssociations.push({
              association_id: deriveId("evtassoc", [input.repositoryId, src.file.uri, test.file.uri, "co-located-test-name"]),
              test_file_id: test.file.fileId,
              source_file_id: src.file.fileId,
              test_uri: test.file.uri,
              source_uri: src.file.uri,
              rule: "co-located-test-name",
              proof: "exact",
              analyzer_name: TYPESCRIPT_ANALYZER_NAME,
              analyzer_version: implVersion,
              source_sha256: shaByUri.get(src.file.uri),
              test_sha256: shaByUri.get(test.file.uri)
            } as EvidenceTestAssociation);
          }
        } else {
          // ambiguous or missing
          if (testCandidates.length > 0 && sourceCandidates.length > 0) {
            // Not a gap if no stem match – just no association
          }
        }
      }

      // Ambiguous test associations: if multiple sources share stem
      for (const test of testCandidates) {
        const stem = testStem(test.file.uri);
        const multi = sourceCandidates.filter((s) => testStem(s.file.uri) === stem);
        if (multi.length > 1) {
          gaps.push(makeGap(input.repositoryId, "ambiguous-test-association", "info", `Ambiguous test association for ${test.file.uri}: ${multi.length} candidates`, test.file.uri, false, "test-association"));
        }
      }

      // Caller/callee: only provable static calls
      for (const cand of candidates) {
        if (input.signal?.aborted) throw new CancellationError("Analyzer cancelled");
        const calls = findNodes(cand.source, ts.SyntaxKind.CallExpression) as ts.CallExpression[];
        for (const call of calls) {
          // Dynamic cases -> gaps
          if (!ts.isIdentifier(call.expression) && !ts.isPropertyAccessExpression(call.expression)) {
            gaps.push(makeGap(input.repositoryId, "dynamic-call", "info", `Dynamic callee not provable in ${cand.file.uri}`, cand.file.uri, false, "caller-callee"));
            continue;
          }
          let calleeName: string;
          if (ts.isIdentifier(call.expression)) calleeName = call.expression.text;
          else calleeName = (call.expression as ts.PropertyAccessExpression).name.text;

          // Check if calleeName is import or local symbol
          const isLocal = symbols.some((s) => s.uri === cand.file.uri && s.name === calleeName);
          const isImported = importEdges.some((e) => e.from.file.uri === cand.file.uri && symbols.some((s) => s.uri === e.toUri && s.name === calleeName));
          const isPolymorphic = /^[A-Z]/.test(calleeName) && call.expression.kind === ts.SyntaxKind.PropertyAccessExpression; // heuristic for polymorphic
          if (isPolymorphic) {
            gaps.push(makeGap(input.repositoryId, "polymorphic-call", "info", `Polymorphic call not statically provable: ${calleeName} in ${cand.file.uri}`, cand.file.uri, false, "caller-callee"));
            continue;
          }
          // Reflective
          if (calleeName === "eval" || calleeName === "Function") {
            gaps.push(makeGap(input.repositoryId, "reflective-call", "info", `Reflective call not provable: ${calleeName} in ${cand.file.uri}`, cand.file.uri, false, "caller-callee"));
            continue;
          }
          if (call.arguments.some((arg) => arg.kind === ts.SyntaxKind.SpreadElement || ts.isFunctionExpression(arg) || ts.isArrowFunction(arg))) {
            // Not necessarily gap, but mark partial
          }

          if (!isLocal && !isImported) {
            // unresolved -> gap, not edge
            gaps.push(makeGap(input.repositoryId, "unresolved-callee", "info", `Unresolved callee ${calleeName} in ${cand.file.uri}`, cand.file.uri, false, "caller-callee"));
            continue;
          }

          // Find target file/symbol
          let targetUri: string | undefined;
          let targetFileId: string | undefined;
          if (isLocal) {
            targetUri = cand.file.uri;
            targetFileId = cand.file.fileId;
          } else {
            const edge = importEdges.find((e) => e.from.file.uri === cand.file.uri && symbols.some((s) => s.uri === e.toUri && s.name === calleeName));
            if (edge) {
              targetUri = edge.toUri;
              targetFileId = byUri.get(edge.toUri)?.file.fileId;
            }
          }
          if (!targetUri || !targetFileId) continue;
          if (edges.length >= maxEdges) break;
          const { line, col, endLine, endCol } = spanForNode(cand.source, call);
          const targetSha = shaByUri.get(targetUri)!;
          const fromSha = shaByUri.get(cand.file.uri)!;
          // Only emit caller edge, callee is mirror but we emit one kind per call; spec says caller/callee edges require static
          edges.push({
            edge_id: deriveId("evedge", [input.repositoryId, "caller", cand.file.uri, targetUri, calleeName, String(line)]),
            kind: "caller",
            from_file_id: cand.file.fileId,
            to_file_id: targetFileId,
            from_uri: cand.file.uri,
            to_uri: targetUri,
            rule: "static-call-resolution",
            resolution: "static",
            proof: "exact",
            analyzer_name: TYPESCRIPT_ANALYZER_NAME,
            analyzer_version: implVersion,
            from_source_sha256: fromSha,
            to_source_sha256: targetSha,
            from_line_start: line,
            from_line_end: endLine,
            from_col_start: col,
            from_col_end: endCol
          } as EvidenceEdge);
        }
      }

      // Config evidence
      for (const cand of candidates) {
        if (cand.file.uri.endsWith("package.json") || cand.file.uri.endsWith("tsconfig.json") || cand.file.uri === "atlas.config.json") {
          configEvidence.push({
            config_evidence_id: deriveId("evcfg", [input.repositoryId, cand.file.uri, cand.sha]),
            uri: cand.file.uri,
            source_sha256: cand.sha,
            byte_length: cand.file.byteLength,
            format: cand.file.uri.endsWith(".json") ? "json" : "text",
            secret_redacted: false,
            analyzer_name: TYPESCRIPT_ANALYZER_NAME,
            analyzer_version: implVersion,
            proof: "exact"
          } as EvidenceConfigEvidence);
        }
      }

      // Unsupported language/framework already handled via gaps
      // Check for malformed tsconfig already added to gaps via compilerConfiguration

      // Sort deterministically (dedupe gaps by stable ID first).
      const seenGapIds = new Set<string>();
      const dedupedGaps = gaps.filter((gap) => {
        if (seenGapIds.has(gap.gap_id)) return false;
        seenGapIds.add(gap.gap_id);
        return true;
      });
      gaps.length = 0;
      gaps.push(...dedupedGaps);
      symbols.sort((a,b)=>a.uri.localeCompare(b.uri) || a.name.localeCompare(b.name) || a.line_start - b.line_start || a.symbol_id.localeCompare(b.symbol_id));
      edges.sort((a,b)=>a.from_uri.localeCompare(b.from_uri) || a.to_uri.localeCompare(b.to_uri) || a.kind.localeCompare(b.kind) || a.edge_id.localeCompare(b.edge_id));
      testAssociations.sort((a,b)=>a.source_uri.localeCompare(b.source_uri) || a.test_uri.localeCompare(b.test_uri) || a.association_id.localeCompare(b.association_id));
      gaps.sort((a,b)=>a.code.localeCompare(b.code) || (a.scope_uri ?? "").localeCompare(b.scope_uri ?? "") || a.gap_id.localeCompare(b.gap_id));

      const durationMs = Date.now() - started;
      const truncated = symbols.length >= maxNodes || edges.length >= maxEdges || gaps.length >= maxDiagnostics;

      // Determine status
      let status: typeof gaps[0]["severity"] extends string ? string : never = "completed";
      let analyzerStatus: import("@atlas/schemas").AnalyzerStatus = "completed";
      if (input.signal?.aborted) analyzerStatus = "cancelled";
      else if (gaps.some((g) => g.severity === "blocking" && g.blocking)) analyzerStatus = "failed";
      else if (truncated || gaps.some((g) => g.severity === "warning")) analyzerStatus = "partial";

      return {
        symbols,
        edges,
        testAssociations,
        apiEvidence,
        configEvidence,
        gaps,
        diagnostics: gaps.map((g) => ({ code: g.code, severity: g.severity, message: g.message, uri: g.scope_uri, blocking: g.blocking })),
        status: analyzerStatus,
        metrics: {
          filesAnalyzed: candidates.length,
          symbolsEmitted: symbols.length,
          edgesEmitted: edges.length,
          gapsEmitted: gaps.length,
          durationMs,
          truncated
        }
      };
    }
  };
}

interface Candidate {
  readonly file: { uri: string; fileId: string; byteLength: number };
  readonly absolute: string;
  readonly content: string;
  readonly lines: readonly string[];
  readonly source: ts.SourceFile;
  readonly sha: string;
}

function symbolsForSource(cand: Candidate, repositoryId: string, _packageBoundaries: readonly string[]): EvidenceSymbol[] {
  const out: EvidenceSymbol[] = [];
  const source = cand.source;
  const uri = cand.file.uri;
  const sha = cand.sha;

  for (const stmt of source.statements) {
    const decls: Array<{ name: string; kind: string; node: ts.Node; exported: boolean; alias?: string | undefined }> = [];

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      decls.push({ name: stmt.name.text, kind: "function", node: stmt.name, exported: hasExportModifier(stmt) || isExportedViaExportDeclaration(source, stmt.name.text) });
      // overloads: if multiple function declarations with same name preceding, we still emit one per decl – caller will dedupe via ID containing line
      if (stmt.body === undefined) {
        // overload signature – still symbol but partial proof
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      decls.push({ name: stmt.name.text, kind: "class", node: stmt.name, exported: hasExportModifier(stmt) });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      decls.push({ name: stmt.name.text, kind: "interface", node: stmt.name, exported: hasExportModifier(stmt) });
      // declaration merging: multiple interfaces same name will produce multiple symbols with different spans
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      decls.push({ name: stmt.name.text, kind: "type", node: stmt.name, exported: hasExportModifier(stmt) });
    } else if (ts.isEnumDeclaration(stmt)) {
      decls.push({ name: stmt.name.text, kind: "enum", node: stmt.name, exported: hasExportModifier(stmt) });
    } else if (ts.isVariableStatement(stmt)) {
      const exp = hasExportModifier(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          decls.push({ name: decl.name.text, kind: "variable", node: decl.name, exported: exp });
        } else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
          // destructuring – skip or emit each binding
          for (const elem of (decl.name as ts.BindingPattern).elements) {
            if (ts.isBindingElement(elem) && ts.isIdentifier(elem.name)) {
              decls.push({ name: elem.name.text, kind: "variable", node: elem.name, exported: exp });
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(stmt)) {
      // re-export: `export { foo as bar } from "./x"` – handled as edge, not symbol here, but alias symbol in current file if re-exporting with alias?
      // For `export { foo } from "./x"`, no local symbol, just edge.
      // For `export * from "./x"`, no local symbol.
      continue;
    } else if (ts.isExportAssignment(stmt)) {
      // `export default expr` – treat as symbol `default`
      const name = "default";
      decls.push({ name, kind: "variable", node: stmt, exported: true });
    }

    // Also handle `export { foo, bar }` without from
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier === undefined && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const elem of stmt.exportClause.elements) {
        const name = elem.propertyName ? elem.propertyName.text : elem.name.text;
        const alias = elem.name.text !== name ? elem.name.text : undefined;
        // symbol is alias if present, otherwise name
        // Find original declaration for kind?
        decls.push({ name: alias ?? name, kind: "variable", node: elem.name, exported: true, alias });
      }
    }

    // Handle `export default function/class` etc. already via hasExportModifier, but need default alias
    // For `export default function foo() {}` – name is foo, exported true

    for (const d of decls) {
      const { line, col, endLine, endCol } = spanForNode(source, d.node);
      const symId = deriveId("evsym", [repositoryId, uri, d.name, d.kind, String(line), String(col), sha]);
      out.push({
        symbol_id: symId,
        file_id: cand.file.fileId,
        uri,
        source_sha256: sha,
        name: d.name,
        kind: d.kind,
        exported: d.exported,
        line_start: line,
        line_end: endLine,
        col_start: col,
        col_end: endCol,
        proof: "exact",
        analyzer_name: TYPESCRIPT_ANALYZER_NAME,
        analyzer_version: TYPESCRIPT_ANALYZER_VERSION
      } as EvidenceSymbol);
    }
  }

  // Also handle `export const foo = 1` already via VariableStatement with export modifier, but need to capture aliases via export declarations above
  return out;
}

function spanForNode(source: ts.SourceFile, node: ts.Node): { line: number; col: number; endLine: number; endCol: number } {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return { line: start.line + 1, col: start.character + 1, endLine: end.line + 1, endCol: end.character + 1 };
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword);
}

function isExportedViaExportDeclaration(source: ts.SourceFile, name: string): boolean {
  for (const stmt of source.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const e of stmt.exportClause.elements) {
        const exported = e.name.text;
        const local = e.propertyName?.text ?? exported;
        if (local === name) return true;
      }
    }
  }
  return false;
}

function scriptKind(path: string): ts.ScriptKind {
  const ext = extname(path).toLowerCase();
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function compilerConfiguration(root: string, gaps: AnalyzerGap[]): { options: ts.CompilerOptions } {
  const path = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (!path) return { options: { allowJs: true, moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext, baseUrl: root } };
  const raw = ts.readConfigFile(path.replaceAll("\\", "/"), ts.sys.readFile);
  if (raw.error) {
    gaps.push(makeGap("unknown", "tsconfig-malformed", "blocking", `Unable to parse tsconfig.json: ${diagnosticText(raw.error)}`, undefined, true, "tsconfig"));
    return { options: { allowJs: true, moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext } };
  }
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(path).replaceAll("\\", "/"));
  if (parsed.errors.length > 0) {
    gaps.push(makeGap("unknown", "tsconfig-malformed", "warning", `tsconfig.json has invalid compiler configuration: ${diagnosticText(parsed.errors[0]!)}`, undefined, false, "tsconfig"));
  }
  if (parsed.projectReferences && parsed.projectReferences.length > 0) {
    gaps.push(makeGap("unknown", "unsupported-project-reference", "info", `tsconfig project references indexed through resolvable paths`, undefined, false, "project-reference"));
  }
  return { options: parsed.options };
}

function resolveLocalModule(containingFile: string, specifier: string, rootOptions: ts.CompilerOptions, root: string, cache: Map<string, { options: ts.CompilerOptions; issue?: string }>, gaps: AnalyzerGap[], repositoryId: string): { uri?: string; options: ts.CompilerOptions } {
  const local = compilerOptionsForFile(containingFile, root, rootOptions, cache, gaps, repositoryId);
  const options = local.options;
  if (!isRepositorySpecifier(specifier, options)) return { options };
  const resolved = ts.resolveModuleName(specifier, containingFile, options, ts.sys).resolvedModule?.resolvedFileName;
  if (!resolved || resolved.includes("/node_modules/") || resolved.includes("\\node_modules\\")) return { options };
  try {
    const real = realpathSync(resolved);
    assertContained(root, real);
    return { uri: relative(root, real).replaceAll("\\", "/"), options };
  } catch {
    return { options };
  }
}

function compilerOptionsForFile(containingFile: string, root: string, fallback: ts.CompilerOptions, cache: Map<string, { options: ts.CompilerOptions; issue?: string }>, gaps: AnalyzerGap[], repositoryId: string): { options: ts.CompilerOptions; issue?: string } {
  let dir = dirname(containingFile);
  while (true) {
    const cached = cache.get(dir);
    if (cached) return cached;
    const p = join(dir, "tsconfig.json");
    if (existsSync(p)) {
      const raw = ts.readConfigFile(p.replaceAll("\\", "/"), ts.sys.readFile);
      if (raw.error) {
        const v = { options: fallback, issue: `Unable to parse ${relative(root, p).replaceAll("\\", "/")}: ${diagnosticText(raw.error)}` };
        gaps.push(makeGap(repositoryId, "tsconfig-malformed", "warning", v.issue, relative(root, p).replaceAll("\\", "/"), false, "tsconfig"));
        cache.set(dir, v);
        return v;
      }
      const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dir.replaceAll("\\", "/"));
      if (parsed.errors.length > 0) {
        const issue = `Package-local tsconfig ${relative(root, p).replaceAll("\\", "/")}: ${diagnosticText(parsed.errors[0]!)}`;
        gaps.push(makeGap(repositoryId, "tsconfig-malformed", "warning", issue, relative(root, p).replaceAll("\\", "/"), false, "tsconfig"));
      }
      if (parsed.projectReferences && parsed.projectReferences.length > 0) {
        gaps.push(makeGap(repositoryId, "unsupported-project-reference", "info", `Project references in ${relative(root, p).replaceAll("\\", "/")}`, relative(root, p).replaceAll("\\", "/"), false, "project-reference"));
      }
      const v = { options: parsed.options };
      cache.set(dir, v);
      return v;
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir || relative(root, parent).startsWith("..")) break;
    dir = parent;
  }
  return { options: fallback };
}

function isRepositorySpecifier(specifier: string, options: ts.CompilerOptions): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return true;
  if (specifier.includes("/") || specifier.startsWith("@")) {
    // Path alias or scoped package – check if it could be resolved via baseUrl/paths
    if (options.baseUrl || options.paths) return true;
    // Even without explicit baseUrl, treat @/ as potential alias
    if (specifier.startsWith("@/")) return true;
  }
  // Check explicit paths patterns
  if (options.paths) {
    for (const pattern of Object.keys(options.paths)) {
      if (pattern === specifier) return true;
      const prefix = pattern.replace("*", "");
      if (prefix && specifier.startsWith(prefix)) return true;
    }
  }
  return false;
}

function isDynamicSpecifier(spec: string): boolean {
  return spec.includes("*") || spec.includes("${") || spec.trim() === "";
}

function diagnosticText(d: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(d.messageText, " ").replaceAll(/\s+/g, " ").trim().slice(0, 500);
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error(`Path escapes root: ${path}`);
}

function isTestUri(uri: string): boolean {
  const lower = uri.toLowerCase();
  return /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/.test(lower);
}

function testStem(uri: string): string {
  return uri.replaceAll("\\", "/").replace(/\.(test|spec)(?=\.)/i, "").replace(/\/__tests__\//, "/");
}

function discoverPackageBoundaries(root: string, uris: readonly string[]): readonly string[] {
  const boundaries = new Set<string>();
  for (const uri of uris) {
    let dir = dirname(uri);
    while (dir !== "." && dir !== "") {
      const pkgPath = join(root, ...dir.split("/"), "package.json");
      if (existsSync(pkgPath)) boundaries.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (existsSync(join(root, "package.json"))) boundaries.add(".");
  }
  return [...boundaries].sort();
}

function findNodes(source: ts.SourceFile, kind: ts.SyntaxKind): readonly ts.Node[] {
  const out: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (node.kind === kind) out.push(node);
    ts.forEachChild(node, visit);
  }
  source.forEachChild(visit);
  return out;
}

function makeGap(repositoryId: string, code: string, severity: "blocking" | "warning" | "info", message: string, scopeUri: string | undefined, blocking: boolean, capability?: string): AnalyzerGap {
  const safeScope = scopeUri !== undefined && scopeUri.includes("\\") ? undefined : scopeUri;
  const gap = {
    gap_id: deriveId("evgap", [repositoryId, code, safeScope ?? "", message.slice(0, 50)]),
    analyzer_name: TYPESCRIPT_ANALYZER_NAME,
    analyzer_version: TYPESCRIPT_ANALYZER_VERSION,
    code,
    severity,
    ...(safeScope === undefined ? {} : { scope_uri: safeScope }),
    message: redactSecretText(message).slice(0, 500),
    blocking,
    ...(capability === undefined ? {} : { capability })
  };
  return gap as AnalyzerGap;
}
