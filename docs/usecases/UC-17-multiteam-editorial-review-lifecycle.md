# UC-17: Multi-team editorial workflow with comment/review lifecycle

## Scenario
- use_case_id: UC-17
- name: Multi-team editorial workflow with comment/review lifecycle
- primary_goal: Run a deterministic editorial review loop across multiple teams (authoring, legal, product, support) using threaded comments, mentions, and revision checkpoints.
- typical_actors: content author, reviewer, approver, knowledge manager, AI automation agent.
- core_workflow:
  1. Author creates or updates a draft document and shares it with reviewer groups.
  2. Reviewers leave anchored comments and threaded replies on specific passages.
  3. Editors triage and apply requested changes, then verify revisions and unresolved discussion threads.
  4. Review leads confirm comment outcomes and close out obsolete review threads.
  5. Final approval publishes the document and records revision history for audit.

## Why this is real (source links)
- Outline has first-class documentation for collaborative writing and review primitives:
  - collaborative editing: https://docs.getoutline.com/s/guide/doc/collaborative-editing-GjkoCop1B7
  - commenting: https://docs.getoutline.com/s/guide/doc/commenting-z7eSWvI5TI
  - mentions: https://docs.getoutline.com/s/guide/doc/mentions-LuweKJRGGl
  - revision history: https://docs.getoutline.com/s/guide/doc/revision-history-AiL6p22Ssq
- Outline API documentation defines the RPC integration model used by this CLI:
  - API overview: https://docs.getoutline.com/s/guide/doc/api-1rEIXDfLF6
- OpenAPI explicitly documents comment lifecycle endpoints under `comments.*`:
  - `comments.create`: https://github.com/outline/openapi/blob/main/spec3.yml#L1165
  - `comments.info`: https://github.com/outline/openapi/blob/main/spec3.yml#L1214
  - `comments.update`: https://github.com/outline/openapi/blob/main/spec3.yml#L1258
  - `comments.delete`: https://github.com/outline/openapi/blob/main/spec3.yml#L1301
  - `comments.list`: https://github.com/outline/openapi/blob/main/spec3.yml#L1338
- OpenAPI comment schema includes thread and anchor constructs required for editorial review:
  - `parentCommentId` for replies and `anchorText` (when requested): https://github.com/outline/openapi/blob/main/spec3.yml#L5692
- Inference from the currently published OpenAPI `comments.*` path set: resolve/unresolve endpoints are not explicitly documented there, so a robust CLI workflow should shape deterministic review state from the documented methods and surface unsupported lifecycle transitions clearly.
  - source: https://github.com/outline/openapi/blob/main/spec3.yml

## Current support in outline-agent
- Document and revision workflows are already wrapped:
  - `documents.create`, `documents.update`, `documents.info`, `documents.list`, `documents.search`
  - `revisions.list`, `revisions.restore`
  - source: `src/tools.js`, `src/tools.mutation.js`, `docs/TOOL_CONTRACTS.md`
- Raw endpoint access exists through `api.call`, so operators can already invoke `comments.*` methods manually.
  - source: `src/tools.js`, `docs/TOOL_CONTRACTS.md`
- Mutating actions are safety-gated via explicit `performAction: true`, which aligns with controlled editorial actions.
  - source: `src/action-gate.js`, `src/tools.js`
- Live integration suite validates end-to-end document mutation/revision flows with isolated test documents and cleanup discipline.
  - source: `test/live.integration.test.js`

## Current limits/gaps in this repo
- G1: No first-class `comments.*` wrappers.
  - Comment lifecycle operations are only reachable via generic `api.call`.
- G2: No comment-specific arg schemas.
  - Missing validation for `documentId`, `parentCommentId`, `includeAnchorText`, and thread-oriented options.
- G3: No deterministic review-queue output model.
  - There is no normalized `threadId/documentId/lastUpdated/reviewerMentions/state` envelope for multi-team triage.
- G4: Review lifecycle state is not explicit.
  - No first-class contract for thread state transitions; lifecycle handling is ad hoc per caller.
- G5: No live comment lifecycle tests.
  - Current integration tests do not cover create/list/info/update/delete comment flows on suite-created docs.
- G6: No operator docs for editorial review loops.
  - `README.md` and `docs/TOOL_CONTRACTS.md` do not define comment/review playbooks.

## Improvement proposal (specific wrappers/schema/tests/docs)
- P1: Add read wrappers in `src/tools.navigation.js` and register via tool registry.
  - `comments.list(args?: { documentId?: string; collectionId?: string; includeAnchorText?: boolean; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; view?: 'ids'|'summary'|'full'; includePolicies?: boolean; })`
  - `comments.info(args: { id: string; includeAnchorText?: boolean; view?: 'summary'|'full'; includePolicies?: boolean; })`
  - `comments.review_queue(args: { documentIds?: string[]; collectionId?: string; includeAnchorText?: boolean; limitPerDocument?: number; includeReplies?: boolean; view?: 'summary'|'full'; })`
- P2: Add mutation wrappers in `src/tools.mutation.js`.
  - `comments.create(args: { documentId: string; text?: string; data?: object; parentCommentId?: string; view?: 'summary'|'full'; performAction?: boolean; })`
  - `comments.update(args: { id: string; data: object; view?: 'summary'|'full'; performAction?: boolean; })`
  - `comments.delete(args: { id: string; performAction?: boolean; })`
  - All mutation wrappers should keep explicit action-gate semantics (`performAction: true` required).
- P3: Add arg schemas in `src/tool-arg-schemas.js`.
  - Enforce required fields (`documentId` for create, `id` for info/update/delete, `data` for update).
  - Enforce mutual requirement for create payload (`text` or `data`).
  - Enforce enum bounds (`view`, `direction`) and numeric bounds (`limit`, `offset`, `limitPerDocument`).
  - Enforce at least one scope selector for `comments.review_queue` (`documentIds` or `collectionId`).
- P4: Add live integration tests in `test/live.integration.test.js` (isolated doc only).
  - Create dedicated test document.
  - Create top-level comment.
  - Create threaded reply (`parentCommentId`).
  - List comments by document and assert deterministic summary shape.
  - Read single comment (`comments.info`) with and without `includeAnchorText`.
  - Update comment payload and assert changed body.
  - Delete top-level comment and assert child cascade behavior per OpenAPI description.
  - Cleanup test document.
- P5: Update docs.
  - `docs/TOOL_CONTRACTS.md`: add full contracts/examples/best practices for `comments.list/info/create/update/delete/review_queue`.
  - `README.md`: add “Editorial review workflow” section (`draft -> comments -> threaded review -> revision check -> publish`).
  - Keep this UC-17 file as implementation anchor.

## Process checklist
1. Re-verify Outline docs and OpenAPI `comments.*` endpoints before implementation.
2. Implement `comments.list/info` read wrappers with deterministic `ids|summary|full` views.
3. Implement `comments.create/update/delete` mutation wrappers with action gating.
4. Implement `comments.review_queue` for multi-team triage with stable output shape.
5. Add strict arg schemas for every new wrapper argument and constraint.
6. Add live integration subtests using suite-created documents only, including threaded reply and cascade delete assertions.
7. Run `npm run check` and `npm test`.
8. Update `docs/TOOL_CONTRACTS.md` and `README.md` to match final contracts and behavior.
