# UC-04: Internal FAQ for repeated operational questions

## Scenario
- use_case_id: UC-04
- name: Internal FAQ knowledge base for repeated operational questions
- primary_goal: Deflect repeated Slack/email/ticket questions by providing one canonical, searchable answer source.
- typical_actors: ops lead, IT/helpdesk owner, policy owner, all employees.
- core_workflow:
  1. Capture recurring questions (access requests, VPN issues, expense policy, escalation paths).
  2. Maintain canonical FAQ docs in a dedicated collection.
  3. Retrieve answers quickly through semantic search and AI answers with citations.
  4. Patch stale answers safely and roll out wording fixes across many FAQ pages.
  5. Keep revision history for audit and rollback.

## Why this is real (source links)
- Outline positions itself directly as “Team knowledge base and wiki software” for internal docs and repeatable knowledge workflows.
  - source: https://www.getoutline.com/
- Outline highlights the exact pain point: colleagues repeatedly requesting the same information.
  - source: https://www.getoutline.com/
- Outline documents “Search and AI answers,” including generated answers with linked sources and Slack integration.
  - source: https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06
- Confluence knowledge-base guidance states self-service knowledge bases reduce repetitive support questions and speed up user resolution.
  - source: https://www.atlassian.com/software/confluence/resources/guides/what-is-a-knowledge-base
- Confluence also frames internal knowledge bases as a searchable source of truth for employees.
  - source: https://www.atlassian.com/software/confluence/resources/guides/what-is-a-knowledge-base

## Current support in outline-agent
- Retrieval/navigation primitives already present:
  - `documents.search` (semantic/title, multi-query), `documents.resolve`, `search.expand`, `search.research`.
  - `documents.list`, `documents.info`, `collections.list`, `collections.info`, `collections.tree`.
- FAQ content maintenance primitives already present:
  - `documents.create`, `documents.update`, `documents.safe_update`, `documents.diff`, `documents.apply_patch`.
  - `documents.plan_batch_update`, `documents.apply_batch_plan`, `documents.batch_update`.
- Governance/safety primitives already present:
  - `revisions.list`, `revisions.restore`.
  - mutation gate via `performAction: true`; safe delete read-receipt flow.
- Escape hatch for missing wrappers:
  - `api.call` can hit raw endpoints when needed.

## Current limits/gaps in this repo
- G1: No first-class wrapper for Outline AI answers endpoint.
  - Outline OpenAPI includes `documents.answerQuestion`, but this repo has no dedicated tool for it.
  - source: https://github.com/outline/openapi/blob/main/spec3.yml
- G2: No deterministic FAQ answer envelope.
  - Current search tools return retrieval evidence, but not a standardized `answer + citations + no_answer_reason` contract for agent loops.
- G3: No batched FAQ-answer wrapper.
  - Repeated operational-question sets require manual loop orchestration instead of one bounded multi-question tool.
- G4: Missing permission-debug wrappers for FAQ visibility issues.
  - No dedicated wrappers for `documents.memberships` / `collections.memberships`, which are common when users cannot see expected FAQ answers.
- G5: Live tests do not cover native AI-answer behavior.
  - `test/live.integration.test.js` validates search/research tools, but not `documents.answerQuestion` via a dedicated wrapper.

## Improvement proposal (specific wrappers/schema/tests/docs)
- P1: Add AI-answer wrappers.
  - `documents.answer`: thin wrapper over `documents.answerQuestion`.
  - `documents.answer_batch`: accepts `questions[]` with bounded concurrency and per-item deterministic results.
- P2: Add permission-debug wrappers used by FAQ operators.
  - `documents.memberships`, `collections.memberships` (read-only access diagnosis).
- P3: Add strict arg schemas in `src/tool-arg-schemas.js`.
  - `documents.answer`: require non-empty `question`; validate scope filters (`collectionId`, `documentId`, optional `shareId`), pagination bounds, and `view` enum.
  - `documents.answer_batch`: require non-empty `questions[]`, dedupe items, cap max batch size, cap concurrency.
  - memberships wrappers: required IDs + query pagination validation.
- P4: Add live integration subtests in `test/live.integration.test.js`.
  - answer happy-path: run `documents.answer` against a stable operational query and assert deterministic envelope.
  - answer no-hit path: query nonsense text and assert explicit no-answer shape (not opaque failure).
  - answer batch path: assert per-item success/failure isolation and stable item schema.
  - membership read path: validate deterministic output for access debugging wrappers.
- P5: Update docs.
  - `docs/TOOL_CONTRACTS.md`: add signatures/examples for new wrappers.
  - `README.md`: add “internal FAQ playbook” command sequence using ids/summary-first retrieval.

## Process checklist
1. Identify FAQ scope collection (`collections.list` + `collections.tree`).
2. Resolve canonical FAQ pages (`documents.resolve` / `documents.search` with `view=ids`).
3. Answer repeated questions (current: `api.call` -> `documents.answerQuestion`; proposed: `documents.answer`).
4. For low-confidence or no-answer cases, expand evidence (`search.research` + `search.expand`) and patch source docs.
5. Apply FAQ wording changes safely (`documents.plan_batch_update` -> review `planHash` -> `documents.apply_batch_plan` with `performAction=true`).
6. Validate revision trail (`revisions.list`) and rollback if needed (`revisions.restore`).
7. For visibility incidents, inspect memberships (current: `api.call`; proposed dedicated memberships wrappers).
