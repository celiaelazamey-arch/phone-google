# Changelog

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
