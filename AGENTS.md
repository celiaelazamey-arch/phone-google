# Repository working agreement — Celia

These instructions preserve project context between coding sessions. They do not replace the hosting environment's instructions or grant production access.

## Start every session

1. Run `pwd`, `git branch --show-current`, `git status --short`, and `git log -5 --oneline`. Preserve uncommitted user work. Use the branch assigned by the environment; never infer a branch from an old report. In a branch-pinned environment, do not create, switch, rename, or push another branch.
2. Read `docs/continuity/NOW.md` (generated read-only summary) and `docs/continuity/STATE.md` (active focus; earlier history is preserved verbatim in `docs/continuity/STATE-ARCHIVE-2026-10.md`), then `BACKLOG.md`, `DECISIONS.md`, and `README.md` in that directory. Read the current plan (`docs/agent-2026-execution-plan.md`) and `docs/compatibility-contract.md` before implementation. `CLAUDE.md` is a thin pointer to this file (`DEC-052`), and `.agents/skills/` holds the 4 repository workflow skills.
3. Resolve stale claims against actual files, Git, and live GitHub results. Historical Arabic reports and prior chat/Google Docs are snapshots, not current deployment evidence.
4. Select a backlog task and its acceptance criteria. Unknown production settings are blockers, not permission to guess. A plan or documentation request is not authorization to deploy or migrate production.

## System invariants

- Keep existing Express/ESM/MySQL architecture, routes, MCP tools, owner authentication, OAuth protections, consent rules, HMAC/dedup, and local/static demo boundaries unless a reviewed task explicitly changes their contract.
- Durable MySQL must never silently fall back to an empty memory store. Pages and `render.demo.yaml` are demonstrations. `render.yaml` now requires external durable MySQL; a blueprint or provider-assigned URL alone is not evidence of publication or restored backups.
- Never replay external mutations after a timeout or session restart. `outcomeUnknown` requires reconciliation or human review, not blind retry.
- Preserve old clients during protocol upgrades. MCP 2026 changes more than a version string; do not advertise conformance before transport/schema/behavior tests pass.
- The deployment CLI manages one MCP container; opt-in 0.2.1 integrations can share it. Rollback to 0.2.0 loses that new combined REST surface and has no support for the new CA variable; CI legacy SQL reads do not establish Aiven/TLS rollback compatibility; do not promise full-system rollback from a legacy MCP image. Code rollback is not database restore. Do not weaken schema gates to make a migration pass.
- Do not delete/reinitialize user databases, remove volumes, rewrite Git history, publish releases, merge PRs, change sharing/security settings, or incur infrastructure/provider costs as a side effect of planning.
- Never commit `.env`, credentials, database dumps, customer conversations, browser traces containing private data, or raw SDK error content. Record secret names and provisioning steps only.
- For proposals, label future behavior clearly. Do not add suggested flags to `.env.example` or change release metadata until their implementation exists.
- **Comprehension Gate — Explain to Understand (`قاعدة الفهم القابل للشرح`):**
  - Before executing any compound task, CeliaOS must be able to explain what it wants to achieve, why it chose its plan, and how it will know it succeeded, in plain language understandable by a beginner or child without altering the task's meaning.
  - After execution, CeliaOS must explain what actually happened, what is backed by recorded evidence (`verified_facts` + `source_ref`/`evidence_ref`), what remains unverified (`unknowns`), and any material assumptions or risks (`assumptions`, `risks_and_side_effects`).
  - If the system cannot explain the task or detects a contradiction between its explanation and deterministic validation or recorded evidence, it must gather missing information, revise the plan, or halt the path under existing policies. Clarity or persuasiveness of an explanation is never sufficient proof of correctness and must never bypass deterministic validation, tool permissions, owner approvals (`WAITING_FOR_APPROVAL`), or security boundaries.

## Verify and hand off

Use relevant checks; distinguish current execution from historical results and skipped/live-provider tests. Baseline commands:

```sh
npm ci
npm run check
npm run release:check
npm run now:check
npm run check:continuity
npm test
CELIA_MCP_DISABLE_MYSQL=true CELIA_DISABLE_OLLAMA=true npm run celia:mcp:verify
npm run build:pages
npm audit --omit=dev --audit-level=moderate
# Browser/runtime changes also require Chromium setup and npm run test:browser.
```

Before ending or changing task: update STATE, the affected backlog rows, decisions when changed, and a dated session record using SESSION_TEMPLATE, then regenerate `docs/continuity/NOW.md` (`npm run now`). Record changed files, tests actually run, blockers, unsafe operations not performed, and the exact next task. Commit/save and, when authorized, push only the environment-assigned branch. If remote persistence fails, say so explicitly; do not claim a local commit is pushed.

Keep one authority per fact: STATE for current focus; BACKLOG for task status; DECISIONS for rationale; the development plan for scope; runbooks for implemented commands; GitHub for current PR/CI/deployment status. Do not erase historical records to resolve contradictions.
