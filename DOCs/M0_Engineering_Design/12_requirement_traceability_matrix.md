# Deliverable L: Requirement Traceability Matrix

## Matrix

| Requirement | Design section | Component | Data entity | Artifact | Command | Adapter | Test category | Milestone | Acceptance evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AT-SET-001 | A/K/J | CLI | n/a | n/a | `--version`, `--help` | n/a | CLI snapshots, packaging | M1 | install/help under 1s |
| AT-SET-002 | A/B/K | Config/app | repositories | project config | `init` | Git | idempotent config tests | M1 | no overwrite fixture |
| AT-SET-003 | A/B/J | Config/security | config records | diagnostic | `doctor` | n/a | schema/security tests | M1 | invalid fields blocked |
| AT-SET-004 | A/B/K | Config | user_preferences | config explain | `config explain` | credentials | config precedence tests | M1 | value source shown |
| AT-AUTH-001 | A/B/F/I | Security/adapters | credential aliases | diagnostic | `auth add` | Credential store | redaction tests | M2 | no plaintext fixture |
| AT-AUTH-002 | A/F/J | Auth service | integration_snapshots | capability report | `doctor` | SaaS adapters | mock/real smoke | M2 | scopes/identity shown |
| AT-AUTH-003 | B/F/J | Auth service | integration_snapshots | event | `auth remove` | Credential store | credential tests | M2 | removed secret unavailable |
| AT-INT-001 | A/F/J | Intake | integration_snapshots | linear snapshot, task brief | `start ENG-1` | Linear | mock/real Linear | M2 | normalized issue fixture |
| AT-INT-002 | C/N | Intake | sessions | manual task input, task brief | `start --manual` | n/a | walking skeleton | M1 | reaches context state |
| AT-INT-003 | G | Intake/context | references | task brief | `start`, `context` | n/a | parser fixtures | M2 | canonical refs dedupe |
| AT-INT-004 | F/J | Intake | integration_snapshots | GitHub snapshot | `context refresh` | GitHub | mock GitHub | M2/P1 | remote facts labeled |
| AT-INT-005 | F/G/I | Context | integration_snapshots | Figma snapshot/evidence | `context add` | Figma | mock Figma | M2 | metadata limitations explicit |
| AT-CTX-001 | A/F/J | Git service | repositories | repo snapshot | all state-changing | Git | temp repo fixtures | M1 | mismatch blocks |
| AT-CTX-002 | G | Context | project_memory | context manifest | `context build` | FS/Git | context budget tests | M2 | traceable included sources |
| AT-CTX-003 | G/K | Context | project_memory | context source records | `context build` | FS | instruction precedence tests | M2 | scoped rules recorded |
| AT-CTX-004 | G/C | Workflow/context | artifact_dependencies | stale labels | `resume`, `plan`, `review` | Git/SaaS | freshness tests | M2 | dependent invalidation |
| AT-CTX-005 | G/J | Context | cache metadata | partial manifest | `context build` | FS/Git | large repo tests | M2 | timeout partial results |
| AT-CTX-006 | G | Context | session overrides | manifest update | `context add/exclude/pin` | FS | override tests | M3/P1 | reason persisted |
| AT-SES-001 | C/D/J | Workflow/persistence | sessions/events/locks | task brief | `start` | n/a | crash tests | M1 | no half-state |
| AT-SES-002 | C/D/J | Resume | sessions/events | status view | `status`, `resume` | Git/FS | reconciliation tests | M1 | next action shown |
| AT-SES-003 | C/D | Workflow | sessions | event | `pause`, `archive`, `cancel` | n/a | state tests | M1 | no code deletion |
| AT-ART-001 | D/E | Artifacts | artifacts/dependencies | all artifacts | generate/import cmds | FS | artifact corruption tests | M1 | approved bytes immutable |
| AT-APP-001 | C/D/E | Workflow | approvals | approval artifact | `approve` | n/a | gate tests | M1 | no impl without contract |
| AT-APP-002 | B/C/E | Workflow | contract changes | change record | `contract import` | n/a | material diff tests | M3 | renewed approval required |
| AT-PLN-001 | E/G/N | Planning | artifact deps | planning package | `plan` | Clipboard/opener | deterministic package tests | M1 | identical input equivalence |
| AT-PLN-002 | B/F | Planning | artifacts | planning package | `plan --copy/open` | Clipboard/opener | clipboard failure tests | M1 | file remains available |
| AT-CON-001 | E/C/N | Contract | artifacts | implementation contract | `contract import` | n/a | schema tests | M1 | missing P0 section blocked |
| AT-CON-002 | E/C | Workflow | decisions/overrides | decision record | `deviation record` | n/a | deviation tests | M3 | deviations listed |
| AT-AGT-001 | F/H | Implementation | execution_runs | agent package | `implement --agent` | Claude/Codex | adapter contract tests | M4 | provider-neutral package |
| AT-AGT-002 | E/H | Implementation | artifact deps | agent package | `implement --prepare` | Agent | package budget tests | M4 | contract/source versions recorded |
| AT-AGT-003 | F/H/J | Runner | execution_runs | execution report/logs | `implement` | Agent/process | process tests | M4 | no prose-only success |
| AT-EXE-001 | H/I | Process runner | command_results | command result | `checks` | Process | shell/cancel tests | M4 | args arrays recorded |
| AT-EXE-002 | E/H | Implementation | execution_runs | execution report | `implement`, `fix` | Agent/Git | report schema tests | M4 | stable JSON report |
| AT-GIT-001 | A/F/I | Git service | repositories | git snapshot | `implement` | Git | Git safety fixtures | M4 | unsafe ops absent |
| AT-GIT-002 | D/F | Git service | execution_runs | execution report | `status`, `review` | Git | divergence tests | M4 | exact base/head shown |
| AT-GIT-003 | F/I | Git service/security | n/a | review diff artifact | `review prepare` | Git | secret diff tests | M5 | every changed path accounted |
| AT-CHK-001 | H/J | Checks | check_runs/results | check results | `checks` | Process | check runner tests | M5 | required failure blocks |
| AT-CHK-002 | B/G/J | Checks/security | check_results | design scan result | `checks` | FS | scanner fixtures | M5 | known violations detected |
| AT-REV-001 | E/C | Review | review_reports | review package | `review prepare` | Git/clipboard | deterministic review tests | M5 | stale label correct |
| AT-REV-002 | E/C | Review | findings | review report/finding | `review import` | n/a | import/finding tests | M5 | malformed draft blocked |
| AT-FIX-001 | C/E/H | Fix loop | fix_batches/findings | fix batch | `fix prepare/run` | Agent | fix-loop E2E | M5 | history preserved |
| AT-CMP-001 | C/E/J | Completion | approvals/overrides | completion report | `complete` | Git/process | completion gate tests | M5 | exact evidence recorded |
| NFR-001 | A/B | All core | sessions/artifacts | all | local commands | local adapters | E2E offline | All | no cloud dependency |
| NFR-002 | A/J | CLI/status | sessions cache | status view | `--help`, `status` | n/a | perf smoke | M1 | p95 target |
| NFR-003 | A/H | Runner/context | command_results | logs | long commands | process | timeout/progress tests | M4 | progress cadence |
| NFR-004 | C/D/J | Workflow | sessions/events | recovery event | all transitions | n/a | forced termination | M1+ | classified states |
| NFR-005 | D/E | Persistence | artifacts/approvals | approved artifacts | all writes | FS | atomic write tests | M1 | durable approvals |
| NFR-006 | C/E/G | Artifact services | artifact deps | generated packages | plan/review | n/a | determinism tests | M1+ | equivalent output |
| NFR-007 | D | Diagnostics | events | audit log | all | n/a | audit tests | M1+ | actor/time/input links |
| NFR-008 | I/H | Security/runner | command_results | logs | all | process/FS | redaction/injection | M1+ | no plaintext fixtures |
| NFR-009 | I/D/A | Privacy/diagnostics/telemetry | preferences/events | diagnostic manifest, telemetry event schema | diagnostics, telemetry config | n/a | bundle preview and telemetry contract tests | M6 | content-free product telemetry with disable/preview controls |
| NFR-010 | A/F | Core/offline | sessions | local artifacts | status/plan/checks | local only | offline E2E | M1+ | remote fails fast |
| NFR-011 | C/D/J | Recovery | events/locks | recovery plan | resume | FS/Git | crash tests | M1+ | safe recovery path |
| NFR-012 | F/K | Adapter contracts | integration snapshots | provider metadata | adapter cmds | all | contract tests | M2+ | no state schema changes |
| NFR-013 | G/J | Context | cache | manifest | context | FS/Git | large repo tests | M2 | limits respected |
| NFR-014 | G/E | Context/artifacts | artifacts | packages | plan/review | n/a | budget tests | M2 | no silent overflow |
| NFR-015 | A/D | Diagnostics | events | diagnostic logs | all | n/a | log contract tests | M1 | correlation IDs |
| NFR-016 | A/J/K | Platform | n/a | n/a | all | OS adapters | OS matrix | M6 | suite passes |
| NFR-017 | D/J | Persistence | migrations | backup | upgrade | FS | migration tests | M6 | recoverable migration |
| NFR-018 | E/J | Schemas/CLI | artifacts | md/json | all | n/a | JSON snapshots | M1+ | stable schemas |
| NFR-019 | I/F | Safety | events | blocked op event | all | Git/process | unsafe op tests | M1+ | no destructive side effects |

## Ambiguities and Recommended Amendments

| Requirement area | Issue | Recommendation |
| --- | --- | --- |
| Supported Node/OS | PRD leaves versions open | Approve ADR-002 and ADR-003 defaults before M1 hardening. |
| Artifact location | PRD asks local-first but not exact path | Approve ADR-009/010 data layout before implementation. |
| Contract Markdown import | Required sections are clear but syntax is open | Approve Markdown + metadata block contract in Deliverable E. |
| Agent commits | PRD default is no, but allows future policy | Keep V1 no-agent-commit until explicit policy ADR. |
| Visual evidence | Fidelity claims are constrained but capture method open | Approve user-supplied evidence plus optional project screenshot command. |
| Telemetry | Product owner approved product telemetry and analysis for V1 | Add privacy-preserving product telemetry with strict content exclusions, disable controls, preview/export, and contract tests. |

No P0 requirement appears technically infeasible as written if the above defaults are approved. Direct GitHub PR creation, Linear writes, browser automation, and model APIs remain deferred and must not be used to satisfy V1 core acceptance.
