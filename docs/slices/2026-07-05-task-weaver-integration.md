# Slice Handoff: Task Weaver Server-Side Agent Integration

Date: 2026-07-05
Requirement: `486bb0c2-c317-407c-a372-7f59b102a685`

## Completed

- Defined the Task Weaver server-side Pi integration flow for web chat and scheduler jobs.
- Added a bridge helper that builds gateway job requests from Task Weaver context.
- Added a scoped service-token request envelope that uses token references and required gateway scopes.
- Added event mapping from gateway events to Task Weaver progress updates.
- Added final result patch construction for persisted human review.
- Validated the spike through `LocalSandboxProvider` with streamed logs and copied artifacts.

## Design Outcome

Task Weaver should call Partners through the gateway API, not by depending on a runtime-provider SDK or local daemon internals. The integration contract is intentionally narrow: Task Weaver supplies context, prompt, repository intent, credential grant IDs, and scoped service-token references; Partners returns streamed progress and a durable final result payload.

Successful executions should land in `in_review` by default rather than auto-completing Task Weaver tasks. This keeps code edits, artifacts, and publishing metadata visible for human review.

## Follow-Up

- Replace the mock gateway/result sink in tests with real HTTP gateway endpoints once the gateway service exists.
- Add cancellation flow coverage with `jobs:cancel` for interactive web chat.
- Add Task Weaver-side UI persistence and review affordances in the Task Weaver repo.
