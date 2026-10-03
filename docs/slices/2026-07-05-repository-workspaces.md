# Slice Handoff: Repository Workspaces and Git Publishing

Date: 2026-07-05
Requirement: `d614549a-f6ca-4889-976e-82c63e71664f`

## Completed

- Defined repository workspace persistence boundaries and artifact manifest expectations.
- Defined scoped Git credential grants for clone, branch push, and pull request creation.
- Added helper modules for workspace plans, artifact manifests, credential grant validation, branch authorization, remote matching, and redaction.
- Added tests covering artifact retention, workspace path normalization, allowed branch publishing, repository mismatch denial, expiry denial, and secret redaction.

## Design Outcome

The project can continue without JuiceFS by treating provider workspaces as disposable execution state and artifact manifests as the durable retrieval contract. JuiceFS remains a production storage backend option, not a blocker for the control plane or provider adapter work.

For Git publishing, the control plane should issue a grant that names one repository, one set of operations, branch patterns, expiry, and a secret reference. The sandbox should never receive broad credentials or persist raw secret material in logs or artifacts.

## Follow-Up

- Wire these helpers into the future gateway API implementation.
- Add real secret-manager integration when a provider runtime is selected.
- Run the previously planned JuiceFS live storage smoke test before claiming production shared workspace persistence.
