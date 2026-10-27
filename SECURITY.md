# Security and operational safety

- Do not put tokens, `.env` files, database dumps, customer messages or private diagnostics in GitHub issues or commits.
- Store production credentials in the hosting secret store / an operator-owned environment file with mode `0600`. Rotate exposed credentials, even after deleting them from Git history.
- Single-owner Bearer authentication is intentional; this is not a multi-tenant identity/RBAC system.
- Public demo endpoints do not grant owner credentials, provider access, deployments, or database restoration.
- Deploy only reviewed artifacts by immutable digest. Verify release checksums AND provenance from the expected repository/workflow; checksums alone do not authenticate an artifact.
- Configure required reviewers for the `release` / `integration-probes` environments, protected branches, and protected `v*` tags in GitHub settings. Workflow files cannot enforce account-level approval settings by themselves.
- For vulnerability reports, use the repository's private GitHub security reporting channel when enabled. If unavailable, contact the repository owner privately rather than publishing exploit details or secrets.
- Review [failure isolation](docs/resilience.md) and [recovery procedures](docs/releases-and-recovery.md) before production use. A code rollback does not restore lost data.
