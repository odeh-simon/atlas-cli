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
  }
] as const;
