# Changelog

## Unreleased

### Added
- Knowledge network (KB-001…KB-004, optional, default `off`): five checksum-manifested CSV registries feed a validated ingestion into a derived SQLite/FTS5 index with named graph edges, `UNIQUE(content_hash)` deduplication, `absent_since` instead of deletion, and a mandatory evidence item per entity. Arabic search returns evidence packs (`uri`, `licence`, `trust`, score breakdown) with `limit`/`maxChars` budgets and an explicit no-match reason instead of invented references.
- Read-only agent tools `kb.search`, `kb.tool_profile`, `kb.project_context` are registered only when `CELIA_KB=sqlite`; the deterministic planner searches first and cites the actual evidence it used. Owner-only `/api/kb` (status/search/entities/stale/export) never writes, and remote import is gated behind `CELIA_KB_ALLOW_REMOTE_IMPORT`.
- `npm run kb -- status|verify|import|search|entity|entities|stale|export|restore`, an Arabic RTL `/kb` page, and a CI step that verifies, imports, searches, exports and reports staleness on a clean runner.
- Offline Google connection preflight (GOOG-002): `npm run google:doctor` and owner-only `GET /api/google/preflight` report the ten environment conditions behind `503 google_not_configured`, `redirect_uri_mismatch`, a silently disabled owner-identity check and a `localhost`-only consent link, with a concrete fix per failure and exit code 1 on any blocker.
- Preflight output is sanitized by contract and covered by tests: no client secret, API token or encryption key is ever printed or returned.

### Limits
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
