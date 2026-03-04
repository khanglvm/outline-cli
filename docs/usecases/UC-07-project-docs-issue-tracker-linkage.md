# UC-07: Project documentation tied to issue tracker references

## Scenario
- use_case_id: UC-07
- name: Project documentation tied to issue tracker references
- primary_goal: Keep project specs, rollout docs, and decision logs explicitly linked to issue tracker artifacts so execution context stays synchronized.
- typical_actors: product manager, tech lead, engineer, QA lead, program manager.
- core_workflow:
  1. Draft or update a project document in Outline.
  2. Insert Linear issue/project links in relevant sections (requirements, scope, rollout, risks).
  3. Search and resolve documents by issue key/URL to answer "what docs reference this issue?".
  4. Update linked docs as issue state evolves.
  5. Audit revisions/events for traceability during postmortems and release reviews.

## Why this is real (source links)
- Outline’s Linear integration documentation states that workflow states can be synced from Linear to Outline and that issue links in docs are rendered as previews, which directly supports doc-to-issue linkage workflows.
  - source: https://docs.getoutline.com/guide/doc/linear
- Outline’s API documentation provides the official automation surface used to operationalize these workflows from agents/CLI tooling.
  - source: https://docs.getoutline.com/guide/doc/api
- Outline OpenAPI lists endpoint primitives needed for linked-document operations, including:
  - `documents.search` / `documents.search_titles` for issue-key/URL discovery in document text.
  - `documents.list` with `backlinkDocumentId` for internal reference graph traversal.
  - `documents.create` / `documents.update` support for `dataAttributes` (structured metadata on documents).
  - `dataAttributes.*`, `comments.*`, and `events.list` for metadata taxonomy, threaded context, and audit history.
  - source: https://github.com/outline/openapi/blob/main/spec3.yml

## Current support in outline-agent
- Current wrappers already support baseline linkage workflows:
  - discovery/read: `documents.search`, `documents.resolve`, `documents.list`, `documents.info`, `collections.tree`
  - controlled edits: `documents.update`, `documents.safe_update`, `documents.diff`, `documents.apply_patch`, `documents.batch_update`, `documents.plan_batch_update`, `documents.apply_batch_plan`
  - lifecycle/recovery: `revisions.list`, `revisions.restore`, `documents.delete`, `documents.cleanup_test`
- `documents.list` implementation already forwards `backlinkDocumentId`, so internal doc backlink traversal is available.
- `documents.create` / `documents.update` plus mutation helpers already forward `dataAttributes` payloads to API calls.
- `api.call` exists as an escape hatch for non-wrapped endpoints.

## Current limits/gaps in this repo
- Missing first-class wrappers for OpenAPI surfaces directly useful to issue-link workflows:
  - `comments.list/info/create/update/delete`
  - `events.list`
  - `dataAttributes.list/info/create/update/delete`
- Arg-schema mismatch currently blocks some implemented behavior:
  - `documents.create`, `documents.update`, and `documents.safe_update` handlers accept/forward `dataAttributes`, but `src/tool-arg-schemas.js` does not currently allow `dataAttributes` for these tools.
- Contract docs drift from implementation:
  - `documents.list` supports `backlinkDocumentId` in code/schema, but this argument is not documented in `docs/TOOL_CONTRACTS.md`.
- No dedicated issue-reference helper output:
  - no deterministic wrapper that normalizes external issue links/keys into machine-friendly linkage reports.
- No live integration coverage for UC-07 linkage behavior end-to-end.

## Improvement proposal (specific wrappers/schema/tests/docs)
- Wrappers:
  - add `comments.list`, `comments.info`, `comments.create`, `comments.update`, `comments.delete` (mutations gated with `performAction: true`).
  - add `events.list` (read-only audit tool).
  - add `data_attributes.list`, `data_attributes.info`, `data_attributes.create`, `data_attributes.update`, `data_attributes.delete` (mapped to `dataAttributes.*` endpoints; mutating ops gated).
  - add issue-link focused wrappers:
    - `documents.issue_refs(args: { id?: string; ids?: string[]; issueDomains?: string[]; keyPattern?: string; view?: 'summary'|'full' })`
    - `documents.issue_ref_report(args: { query?: string; queries?: string[]; collectionId?: string; issueDomains?: string[]; keyPattern?: string; limit?: number; view?: 'ids'|'summary' })`
- Schema (`src/tool-arg-schemas.js`):
  - add `dataAttributes` to `documents.create`, `documents.update`, `documents.safe_update`, and `documents.batch_update.updates[]` shape.
  - add explicit schemas for new wrappers (required IDs, pagination bounds, enum checks, and `performAction` on mutating tools).
  - explicitly surface `documents.list.backlinkDocumentId` in contract/schema docs to match implementation.
- Tests (`test/live.integration.test.js`):
  - create suite-owned project doc(s), inject sample Linear issue URLs/keys, and verify retrieval via `documents.search`.
  - verify internal doc reference traversal via `documents.list({ backlinkDocumentId })`.
  - add guarded comment lifecycle subtests (`create -> list -> update -> delete`) on suite docs.
  - add `events.list` assertions for document-update audit records.
  - add data-attribute coverage when available on tenant plan; if unavailable (forbidden by plan), assert explicit skip behavior.
  - cleanup all suite-created artifacts.
- Docs:
  - update `docs/TOOL_CONTRACTS.md` for the new wrappers and corrected `documents.list` signature.
  - update `README.md` with a deterministic UC-07 playbook: discover issue refs -> hydrate docs -> safe patch -> verify via search/events.

## Process checklist
1. Confirm endpoint behavior against Outline Linear integration docs and Outline API/OpenAPI references.
2. Implement wrappers and tool registration in the appropriate `src/tools*.js` modules.
3. Add/update schemas in `src/tool-arg-schemas.js` for every new/changed argument.
4. Add live integration subtests in `test/live.integration.test.js` using suite-created entities only.
5. Run `npm run check`.
6. Run `npm test` in configured live environment.
7. Update `docs/TOOL_CONTRACTS.md` and `README.md` so docs match shipped contracts.
