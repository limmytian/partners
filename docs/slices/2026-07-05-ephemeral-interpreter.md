# Slice Handoff: Ephemeral Interpreter Jobs

Requirement: Support ephemeral interpreter agent jobs

Date: 2026-07-05

## Completed

- Designed snapshot profiles for one-shot Python/Node/Git interpreter jobs.
- Defined timeout/resource/artifact/network defaults.
- Added a configurable cost estimator.
- Implemented a one-shot lifecycle helper over `AgentExecutionProvider`.
- Added tests proving input upload, execution, event streaming, artifact copy-out, and cost estimation through the local provider.

## Decisions

1. One-shot jobs are always `ephemeral_interpreter` requests at the provider boundary.
2. The provider must export artifacts before deleting ephemeral state.
3. Snapshot aliases are stable product names; actual image versions should roll behind aliases after validation.
4. Billing rates are runtime configuration, not source constants.
5. Workspace paths in artifact policies use the `workspace:/workspace/...` form.

## Files

- `docs/ephemeral-interpreter-jobs.md`
- `src/jobs/one-shot-interpreter.js`
- `test/one-shot-interpreter.test.js`
