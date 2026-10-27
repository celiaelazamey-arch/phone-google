# Changelog

## Unreleased

### Added
- Agent governance layer (DEC-014, additive migration `0003_agent-governance.sql`, eight `agent_*` tables; core schema 1 unchanged): an inspectable **goal contract** per run (`agent_goal_contracts`: objective, success criteria, constraints, stop conditions, deadline, budget), a durable **approval gate** (`agent_approvals` + owner-only `GET/POST /api/agent/runs/:id/approvals(s)`) with idempotent `approved`/`rejected` decisions and controlled resume, an append-only **evidence ledger** (`agent_evidence`) linked by SHA-256 `prev_hash` chains with tamper/gap detection, and an **independent verifier** (`src/agent/verifier.js`) returning only `PASS`/`BLOCK`/`UNKNOWN`; no `deliver` step is written without a preceding `verify` step.
- External-effects outbox (DEC-015, additive migration `0004_agent-outbox.sql`, nine `agent_*` tables; core schema 1 unchanged): every external effect is one durable intent in `agent_outbox` with a unique `idempotency_key`, recorded **before** the owner is asked to decide, so the approval shows the exact payload. Rejection settles the intent `cancelled` and nothing is sent. Dispatch requires a conditional claim from `pending`; a `dispatching` row is never re-claimed — an expired lease settles `unknown` for reconciliation instead of re-sending. Definitive provider rejections (validation/auth, 4xx except 408/429) settle `failed`; every ambiguous outcome (timeout, reset, 5xx) settles `unknown` and is never retried automatically.
- Google Calendar connector (`src/agent/connectors.js`) rides the owner's existing Google grant with no new scope or secret, and derives a deterministic `iCalUID` from the outbox key so a provider-side duplicate is reported as reconciliation, not a second event. Connectors are opt-in: `CELIA_AGENT_CONNECTORS=none` (default) keeps `external_connector_unavailable`, and `calendar` requires configured Google OAuth rather than degrading silently.
- Approved intents are dispatched by the runtime **before** the planner is asked again, so an approval can never strand an external effect when a planner does not repeat its call; `GET /api/agent/runs/:id/outbox` and the `/agent` outbox panel expose intents, attempts, external references and safe error codes.
- The independent verifier gains four outbox checks: `outbox_approval` (no dispatched effect without a recorded approved decision), `outbox_outcome` (an unsettled intent yields `UNKNOWN`, never a claimed delivery), `outbox_evidence` (every intent is referenced by the ledger) and `outbox_tool_run_parity` (a `sent` intent matches a successful tool run).
- Approval safety rules: resuming a run while any tool call is `unknown`/`started` is refused with `409 reconciliation_required` (reconciliation before replay), rejection cancels the run without any external trace, and an approval without the still-unbuilt AGENT-002 outbox connector ends with an explicit `external_connector_unavailable` instead of a fake success. Interrupted tool runs missing ledger coverage are reconstructed honestly as `tool_call_reconciled` entries.
- The `/agent` page renders the goal contract, an approval decision panel (approve/reject + note), the transactional outbox, the hash-chained evidence ledger and the verifier verdict/chain badges; SSE snapshots and events carry the new fields.
- Knowledge network (KB-001…KB-004, optional, default `off`): five checksum-manifested CSV registries feed a validated ingestion into a derived SQLite/FTS5 index with named graph edges, `UNIQUE(content_hash)` deduplication, `absent_since` instead of deletion, and a mandatory evidence item per entity. Arabic search returns evidence packs (`uri`, `licence`, `trust`, score breakdown) with `limit`/`maxChars` budgets and an explicit no-match reason instead of invented references.
- Read-only agent tools `kb.search`, `kb.tool_profile`, `kb.project_context` are registered only when `CELIA_KB=sqlite`; the deterministic planner searches first and cites the actual evidence it used. Owner-only `/api/kb` (status/search/entities/stale/export) never writes, and remote import is gated behind `CELIA_KB_ALLOW_REMOTE_IMPORT`.
- `npm run kb -- status|verify|import|search|entity|entities|stale|export|restore`, an Arabic RTL `/kb` page, and a CI step that verifies, imports, searches, exports and reports staleness on a clean runner.
- Offline Google connection preflight (GOOG-002): `npm run google:doctor` and owner-only `GET /api/google/preflight` report the ten environment conditions behind `503 google_not_configured`, `redirect_uri_mismatch`, a silently disabled owner-identity check and a `localhost`-only consent link, with a concrete fix per failure and exit code 1 on any blocker.
- Preflight output is sanitized by contract and covered by tests: no client secret, API token or encryption key is ever printed or returned.

- Human reconciliation (DEC-016, no new migration, core schema 1 unchanged): the one exit from `needs_reconciliation`. Owner-only `POST /api/agent/runs/:id/reconcile` records `applied` / `not_applied` for an uncertain tool run or outbox intent, appends a hash-chained `reconciliation` evidence entry, and resumes the run **only** when nothing uncertain remains. The route never calls a connector and never re-sends.
- Reconciliation is deliberately narrow: only `unknown`/`started` rows (or `dispatching` with an expired lease) are eligible — a settled `sent`/`failed`/`succeeded` row is a fact and answers `409 target_not_reconcilable`; a foreign target answers `400 target_not_in_run` without disclosing existence; another owner gets `404` on every surface. One decision settles a paired tool run and intent together, so a `sent` intent can never sit beside an `unknown` call.
- Manual retry of a `failed` intent (AGENT-002 remainder): a proven no-op intent accepts `not_applied` + explicit `resume`, is reused under the same row and key, and sends once more only after a recorded decision. Approval keys are now bound to the payload hash (`approval:<run>:<tool>:<hash12>`), so a changed payload can never ride on an earlier approval.
- The independent verifier gains `reconciliation_evidence` (a row declared settled without a ledger entry blocks the verdict) and `reconciliation_reference` (a confirmed effect naming neither a reference nor an owner note stays `UNKNOWN`); an adjudicated `not_applied` failure no longer permanently blocks a later successful retry.
- `/agent` gains a reconciliation panel (explicit "effect exists" / "never arrived" / "retry" actions with note and reference fields) and the `reconciliation.recorded` / `run.reconciled` stream events.

### Limits
- External effects only leave through the outbox, and only when a connector is explicitly enabled: the default configuration still refuses every external effect with `external_connector_unavailable`. WhatsApp and Drive connectors remain unbuilt (AGENT-002 remainder), an `unknown` outcome is never retried automatically (reconciliation is a recorded owner decision, exposed in `/agent`, and never a retry loop), sandbox execution stays refused (AGENT-003), and the planner remains deterministic. The verifier only judges readable durable facts; a provider-side effect that left no readable trace stays `UNKNOWN` by design.
- The knowledge index is derived and local: it is not a durable store on a disk-less host (`status.durability.persistent=false`), contains no semantic/embedding search, does not sync Google Drive, and its planner is deterministic. Remote encrypted backup is not implemented.
- The preflight is offline: it cannot prove the OAuth client exists in Google Cloud, that the owner email is listed under Test users, or that the public domain is live. Live connection still requires an owner OAuth client and public HTTPS (HOST-003).

## 0.2.1 — Free Launch Runtime — 2026-10-27

### Added
- Opt-in single-port MCP/UI + existing owner-authenticated Google/WhatsApp REST/OAuth/webhook routers; raw-body HMAC ordering preserved.
- Shared strict MySQL TLS/CA configuration and explicit, locked initialization of an entirely empty dedicated schema only. Existing compatible tables are not modified; schema 1 unchanged.
- Arabic `/deploy` centre and sanitized read-only `/api/deployment`, with real blockers, stale evidence exports and honest static/browser mode.
- Free single-service Render Blueprint with dashboard-only MySQL inputs and generated keys; previous demonstration preserved as `render.demo.yaml`.
- Isolated real MySQL 8.4 CI acceptance for concurrent deduplication, transactions, restart persistence, previous 0.2.0 MCP/schema compatibility and actual synthetic dump/restore.
- Structural continuity checker and PR handoff gate; hosting runbook and redacted deployment inventory.

### Compatibility and operational limits
- Existing MCP-only mode remains the default; hosting PORT takes precedence only when full integration mode is explicitly enabled. No dependency or SQL table changes.
- Production cannot disable TLS certificate verification. Empty-only installation is not a migration or automatic repair.
- Rollback to 0.2.0 preserves its MCP/schema contract, not the new combined REST surface. No invented previous healthy image.
- Permanent provider accounts/public deployment, production backup restore and live Google/Meta acceptance are not claimed. Free plans have resource/sleep limits and may require account verification; stop if a card is requested.
- General durable studio conversation history, outbox and MCP2026 remain separate backlog work.

## 0.2.0 — Resilient Core — 2026-10-27

### Added
- Shared release identity, source history and schema compatibility contract (schema 1 unchanged).
- Per-integration circuit breakers, bounded concurrency, deadlines, cancellation and bounded diagnostics.
- Liveness/readiness, version and safe component endpoints; authenticated operator diagnostics.
- Arabic RTL system/version dashboard with responsive layout, stale-data handling and JSON export.
- Health-gated immutable-digest Docker release switching, automatic restore attempts, explicit rollback, locking, atomic state and interrupted-deploy recovery.
- Verified source/static archives, CycloneDX SBOM, checksums and manual GitHub release publishing with OIDC attestations.
- Verified, tagged-artifact Pages rollback; Node 22/24 CI, container smoke, desktop/mobile/accessibility tests and Dependabot.

### Changed
- Node 22 minimum; Node 24 LTS production containers.
- MySQL failure no longer silently falls back to an empty memory database. Explicit demo mode remains available.
- Auto AI processing falls back conservatively to local rules; explicit providers remain strict.
- Google SDK retries are disabled for these operations. Mutations are never implicitly replayed.
- Public sandbox cannot use owner AI secrets. Ollama calls are server-side, authenticated and same-origin from the browser.
- Upstream error text is not reflected to public callers; demo memory capacity and MCP batch size are bounded.
- Quality checks need no repository/cloud secrets; live external probing is opt-in.

### Operational limits
- The first managed deployment has no fabricated rollback predecessor. 0.1.0 is source-only baseline.
- Backend switch can have a brief interruption; data restore is separate. Docker engine and hosting-provider execution still require operator infrastructure.
- In-process isolation cannot contain a process/OOM/machine failure. Production distribution/failover and backup restoration remain separate work.

## 0.1.0 — Foundation — 2026-10-27

Baseline commit `9b5c0d6643f4b1ddcafb7aaa0b32e9bea756ea9f`: Arabic studio/landing, 12 MCP tools, Google OAuth, consent-aware WhatsApp, policy engine, encryption lab and static Pages preview. Predates managed readiness/rollback tooling.
