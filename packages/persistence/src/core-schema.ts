import type { Migration } from "./migrations.js";

export const coreMigrations: readonly Migration[] = [
  {
    version: 1,
    name: "core_sessions_events_locks",
    sql: `
CREATE TABLE repositories (
  repo_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  remote_url_hash TEXT,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_repositories_root_path ON repositories(root_path);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(repo_id),
  task_key TEXT,
  task_source TEXT NOT NULL CHECK (task_source IN ('linear', 'manual')),
  primary_state TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  disposition TEXT NOT NULL DEFAULT 'active' CHECK (disposition IN ('active', 'cancelled', 'completed')),
  current_contract_artifact_id TEXT,
  current_context_artifact_id TEXT,
  current_git_head TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX idx_sessions_repo_id ON sessions(repo_id);
CREATE INDEX idx_sessions_state ON sessions(primary_state);
CREATE UNIQUE INDEX idx_sessions_active_task
  ON sessions(repo_id, task_source, task_key)
  WHERE task_key IS NOT NULL AND disposition != 'cancelled';

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id),
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'atlas', 'adapter', 'agent')),
  actor_id TEXT,
  command_id TEXT,
  occurred_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_events_session_time ON events(session_id, occurred_at);
CREATE INDEX idx_events_type ON events(event_type);

CREATE TABLE locks (
  lock_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('session', 'project', 'global')),
  scope_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_hostname TEXT NOT NULL,
  owner_command_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT
);

CREATE UNIQUE INDEX idx_locks_active_scope
  ON locks(scope, scope_id)
  WHERE released_at IS NULL;

CREATE INDEX idx_locks_expiry ON locks(expires_at);
`
  },
  {
    version: 2,
    name: "artifact_records",
    sql: `
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  content_version INTEGER NOT NULL CHECK (content_version > 0),
  storage_uri TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  media_type TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential', 'secret-redacted')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'valid', 'rejected', 'approved', 'superseded', 'stale')),
  producer_type TEXT NOT NULL CHECK (producer_type IN ('atlas', 'user', 'adapter', 'agent', 'import')),
  producer_id TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE UNIQUE INDEX idx_artifacts_session_type_version
  ON artifacts(session_id, type, content_version);

CREATE INDEX idx_artifacts_session_type_status
  ON artifacts(session_id, type, status);

CREATE INDEX idx_artifacts_sha256_type
  ON artifacts(sha256, type);

CREATE TABLE artifact_dependencies (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  depends_on_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  dependency_kind TEXT NOT NULL CHECK (dependency_kind IN ('input', 'parent', 'replaces', 'evidence')),
  PRIMARY KEY (artifact_id, depends_on_artifact_id, dependency_kind)
);
`
  },
  {
    version: 3,
    name: "approvals",
    sql: `
CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  approval_type TEXT NOT NULL CHECK (approval_type IN ('contract', 'completion', 'override_disposition')),
  artifact_sha256 TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  rationale TEXT,
  created_at TEXT NOT NULL,
  revoked_by_id TEXT
);

CREATE INDEX idx_approvals_session_type ON approvals(session_id, approval_type);
CREATE INDEX idx_approvals_artifact ON approvals(artifact_id);
`
  },
  {
    version: 4,
    name: "findings",
    sql: `
CREATE TABLE findings (
  finding_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  review_report_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  review_iteration INTEGER NOT NULL CHECK (review_iteration > 0),
  severity TEXT NOT NULL CHECK (severity IN ('blocking', 'important', 'suggestion', 'question', 'accepted_deviation')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  affected_files_json TEXT NOT NULL DEFAULT '[]',
  requirement_ids_json TEXT NOT NULL DEFAULT '[]',
  proposed_action TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'accepted_deviation', 'rejected', 'deferred', 'duplicate', 'cannot_reproduce', 'reopened')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_findings_session_status ON findings(session_id, status);
CREATE INDEX idx_findings_review_report ON findings(review_report_artifact_id);
`
  },
  {
    version: 5,
    name: "finding_dispositions",
    sql: `
CREATE TABLE finding_dispositions (
  disposition_id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES findings(finding_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  disposition TEXT NOT NULL CHECK (disposition IN ('resolve', 'accept_deviation', 'reject', 'defer', 'duplicate', 'cannot_reproduce', 'reopen')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  resolution_evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_finding_dispositions_finding ON finding_dispositions(finding_id);
`
  },
  {
    version: 6,
    name: "decision_records",
    sql: `
CREATE TABLE decision_records (
  decision_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'deviation')),
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('scope', 'architecture', 'data_security', 'design_constraints', 'acceptance', 'tests', 'prohibitions')),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  supersedes_decision_id TEXT
);

CREATE INDEX idx_decision_records_session_kind ON decision_records(session_id, kind);
`
  },
  {
    version: 7,
    name: "evidence_index_core",
    sql: `
CREATE TABLE IF NOT EXISTS evidence_repositories (
  repository_id TEXT PRIMARY KEY,
  root_path_hash TEXT NOT NULL UNIQUE,
  remote_url_hash TEXT,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_git_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  fingerprint TEXT NOT NULL,
  base_fingerprint TEXT NOT NULL,
  branch TEXT,
  head_sha TEXT,
  dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_git_snapshots_repo ON evidence_git_snapshots(repository_id, created_at);

CREATE TABLE IF NOT EXISTS evidence_files (
  file_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  uri TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  last_seen_snapshot_id TEXT NOT NULL,
  deleted_at_snapshot_id TEXT,
  UNIQUE (repository_id, uri)
);

CREATE INDEX IF NOT EXISTS idx_evidence_files_repo_uri ON evidence_files(repository_id, uri);
CREATE INDEX IF NOT EXISTS idx_evidence_files_content ON evidence_files(content_sha256);

CREATE TABLE IF NOT EXISTS evidence_contents (
  content_sha256 TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  media_type TEXT NOT NULL,
  binary INTEGER NOT NULL CHECK (binary IN (0, 1)),
  redacted INTEGER NOT NULL CHECK (redacted IN (0, 1)),
  sensitivity TEXT NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public', 'internal', 'confidential', 'secret-redacted')),
  storage_uri TEXT
);

CREATE TABLE IF NOT EXISTS evidence_classifications (
  classification_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  file_id TEXT REFERENCES evidence_files(file_id),
  uri TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('source', 'test', 'architecture', 'contract', 'schema', 'migration', 'operation', 'config', 'instruction')),
  sensitivity TEXT NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public', 'internal', 'confidential', 'secret-redacted')),
  is_secret INTEGER NOT NULL CHECK (is_secret IN (0, 1)),
  binary_check INTEGER NOT NULL CHECK (binary_check IN (0, 1)),
  excluded INTEGER NOT NULL CHECK (excluded IN (0, 1)),
  excluded_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_evidence_classifications_repo_uri ON evidence_classifications(repository_id, uri);
CREATE INDEX IF NOT EXISTS idx_evidence_classifications_category ON evidence_classifications(repository_id, category);

CREATE TABLE IF NOT EXISTS evidence_symbols (
  symbol_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  file_id TEXT NOT NULL REFERENCES evidence_files(file_id),
  uri TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
  line_start INTEGER NOT NULL CHECK (line_start > 0),
  line_end INTEGER NOT NULL CHECK (line_end > 0 AND line_end >= line_start)
);

CREATE INDEX IF NOT EXISTS idx_evidence_symbols_repo_file ON evidence_symbols(repository_id, file_id);
CREATE INDEX IF NOT EXISTS idx_evidence_symbols_repo_name ON evidence_symbols(repository_id, name);

CREATE TABLE IF NOT EXISTS evidence_edges (
  edge_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  kind TEXT NOT NULL CHECK (kind IN ('import', 're-export', 'test-association', 'caller', 'callee')),
  from_file_id TEXT NOT NULL REFERENCES evidence_files(file_id),
  to_file_id TEXT NOT NULL REFERENCES evidence_files(file_id),
  from_uri TEXT NOT NULL,
  to_uri TEXT NOT NULL,
  rule TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'heuristic' CHECK (resolution IN ('static', 'heuristic'))
);

CREATE INDEX IF NOT EXISTS idx_evidence_edges_repo_from ON evidence_edges(repository_id, from_file_id);
CREATE INDEX IF NOT EXISTS idx_evidence_edges_repo_to ON evidence_edges(repository_id, to_file_id);

CREATE TABLE IF NOT EXISTS evidence_test_associations (
  association_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  test_file_id TEXT NOT NULL REFERENCES evidence_files(file_id),
  source_file_id TEXT NOT NULL REFERENCES evidence_files(file_id),
  test_uri TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  rule TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_test_assoc_repo_source ON evidence_test_associations(repository_id, source_file_id);
CREATE INDEX IF NOT EXISTS idx_evidence_test_assoc_repo_test ON evidence_test_associations(repository_id, test_file_id);

CREATE TABLE IF NOT EXISTS evidence_config_evidence (
  config_evidence_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  uri TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  format TEXT NOT NULL,
  secret_redacted INTEGER NOT NULL CHECK (secret_redacted IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_evidence_config_repo_uri ON evidence_config_evidence(repository_id, uri);

CREATE TABLE IF NOT EXISTS evidence_api_evidence (
  api_evidence_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  file_id TEXT NOT NULL REFERENCES evidence_files(file_id),
  uri TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('cli-command', 'exported-function', 'http-endpoint')),
  line_start INTEGER NOT NULL CHECK (line_start > 0),
  line_end INTEGER NOT NULL CHECK (line_end > 0 AND line_end >= line_start)
);

CREATE INDEX IF NOT EXISTS idx_evidence_api_repo_file ON evidence_api_evidence(repository_id, file_id);

CREATE TABLE IF NOT EXISTS evidence_analyzer_capabilities (
  capability_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  analyzer_name TEXT NOT NULL,
  analyzer_version TEXT NOT NULL,
  capability_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_capabilities_identity
  ON evidence_analyzer_capabilities(repository_id, analyzer_name, analyzer_version);

CREATE TABLE IF NOT EXISTS evidence_index_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  git_snapshot_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('building', 'current', 'superseded', 'invalid')),
  supersedes_snapshot_id TEXT,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  relevant_inputs_sha256 TEXT NOT NULL,
  entry_counts_json TEXT NOT NULL,
  analyzer_capabilities_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_snapshots_current
  ON evidence_index_snapshots(repository_id) WHERE status = 'current';

CREATE INDEX IF NOT EXISTS idx_evidence_snapshots_repo_created ON evidence_index_snapshots(repository_id, created_at);

CREATE TABLE IF NOT EXISTS evidence_invalidation (
  invalidation_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('file', 'content', 'classification', 'symbol', 'edge', 'test_association', 'config_evidence', 'api_evidence')),
  entity_id TEXT NOT NULL,
  valid_from_snapshot_id TEXT NOT NULL,
  invalidated_in_snapshot_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('file-changed', 'file-deleted', 'git-reset', 'config-changed', 'manual-rebuild')),
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_invalidation_entity ON evidence_invalidation(repository_id, entity_type, entity_id);
`
  },
  {
    version: 8,
    name: "evidence_index_build_state",
    sql: `
CREATE TABLE IF NOT EXISTS evidence_index_builds (
  build_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'abandoned')),
  pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  finished_at TEXT,
  metrics_json TEXT,
  error_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_evidence_builds_repo_state ON evidence_index_builds(repository_id, state);

CREATE TABLE IF NOT EXISTS evidence_scan_cache (
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  uri TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  mtime_ms REAL NOT NULL,
  content_sha256 TEXT NOT NULL,
  scanned_snapshot_id TEXT NOT NULL,
  PRIMARY KEY (repository_id, uri)
);
`
  },
  {
    version: 9,
    name: "evidence_index_analyzer_v2",
    sql: `
CREATE TABLE IF NOT EXISTS evidence_analyzer_gaps (
  gap_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES evidence_repositories(repository_id),
  snapshot_id TEXT,
  analyzer_name TEXT NOT NULL,
  analyzer_version TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocking', 'warning', 'info')),
  scope_uri TEXT,
  message TEXT NOT NULL,
  blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  capability TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_gaps_repo ON evidence_analyzer_gaps(repository_id, snapshot_id);

-- Extend symbols with proof and span columns (additive, ignore if exists)
ALTER TABLE evidence_symbols ADD COLUMN col_start INTEGER;
ALTER TABLE evidence_symbols ADD COLUMN col_end INTEGER;
ALTER TABLE evidence_symbols ADD COLUMN proof TEXT DEFAULT 'exact' CHECK (proof IN ('exact', 'bounded', 'partial', 'unsupported'));
ALTER TABLE evidence_symbols ADD COLUMN analyzer_name TEXT;
ALTER TABLE evidence_symbols ADD COLUMN analyzer_version TEXT;

-- Extend edges
ALTER TABLE evidence_edges ADD COLUMN proof TEXT DEFAULT 'exact' CHECK (proof IN ('exact', 'bounded', 'partial', 'unsupported'));
ALTER TABLE evidence_edges ADD COLUMN analyzer_name TEXT;
ALTER TABLE evidence_edges ADD COLUMN analyzer_version TEXT;
ALTER TABLE evidence_edges ADD COLUMN from_source_sha256 TEXT;
ALTER TABLE evidence_edges ADD COLUMN to_source_sha256 TEXT;
ALTER TABLE evidence_edges ADD COLUMN from_line_start INTEGER;
ALTER TABLE evidence_edges ADD COLUMN from_line_end INTEGER;
ALTER TABLE evidence_edges ADD COLUMN from_col_start INTEGER;
ALTER TABLE evidence_edges ADD COLUMN from_col_end INTEGER;
ALTER TABLE evidence_edges ADD COLUMN to_line_start INTEGER;
ALTER TABLE evidence_edges ADD COLUMN to_line_end INTEGER;
ALTER TABLE evidence_edges ADD COLUMN to_col_start INTEGER;
ALTER TABLE evidence_edges ADD COLUMN to_col_end INTEGER;

-- Extend test associations
ALTER TABLE evidence_test_associations ADD COLUMN proof TEXT DEFAULT 'exact' CHECK (proof IN ('exact', 'bounded', 'partial', 'unsupported'));
ALTER TABLE evidence_test_associations ADD COLUMN analyzer_name TEXT;
ALTER TABLE evidence_test_associations ADD COLUMN analyzer_version TEXT;
ALTER TABLE evidence_test_associations ADD COLUMN source_sha256 TEXT;
ALTER TABLE evidence_test_associations ADD COLUMN test_sha256 TEXT;
ALTER TABLE evidence_test_associations ADD COLUMN line_start INTEGER;
ALTER TABLE evidence_test_associations ADD COLUMN line_end INTEGER;
ALTER TABLE evidence_test_associations ADD COLUMN col_start INTEGER;
ALTER TABLE evidence_test_associations ADD COLUMN col_end INTEGER;

-- Extend api evidence
ALTER TABLE evidence_api_evidence ADD COLUMN col_start INTEGER;
ALTER TABLE evidence_api_evidence ADD COLUMN col_end INTEGER;
ALTER TABLE evidence_api_evidence ADD COLUMN proof TEXT DEFAULT 'exact' CHECK (proof IN ('exact', 'bounded', 'partial', 'unsupported'));
ALTER TABLE evidence_api_evidence ADD COLUMN analyzer_name TEXT;
ALTER TABLE evidence_api_evidence ADD COLUMN analyzer_version TEXT;

-- Extend config evidence
ALTER TABLE evidence_config_evidence ADD COLUMN analyzer_name TEXT;
ALTER TABLE evidence_config_evidence ADD COLUMN analyzer_version TEXT;
ALTER TABLE evidence_config_evidence ADD COLUMN proof TEXT DEFAULT 'exact' CHECK (proof IN ('exact', 'bounded', 'partial', 'unsupported'));
`
  }
] as const;
