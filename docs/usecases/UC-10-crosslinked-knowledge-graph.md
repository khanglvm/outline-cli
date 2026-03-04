# UC-10: Cross-linked knowledge graph with backlinks/mentions

## Scenario
- use_case_id: UC-10
- name: Cross-linked knowledge graph with backlinks/mentions
- primary_goal: Build and query a reliable graph of related knowledge pages so agents can traverse context, not just retrieve isolated documents.
- typical_actors: knowledge manager, technical writer, product/engineering leads, AI automation agent.
- core_workflow:
  1. Authors link related pages and mention collaborators/pages while writing.
  2. The system captures graph edges (backlinks, outgoing links, mention-like references).
  3. Agents start from a seed page and expand neighbors to gather full context.
  4. Teams answer "what depends on this page?" and "what pages reference this topic/person?" quickly.
  5. Changes are propagated by traversing affected linked pages instead of manual hunting.

## Why this is real (source links)
- Outline Backlinks documentation describes automatic backlink surfaces when documents reference each other, which is a direct graph edge primitive.
  - source: https://docs.getoutline.com/s/guide/doc/backlinks-VP8gD0gDxM
- Outline Mentions documentation describes @mentions (people and documents) plus notifications, which is a second relationship signal for cross-linked knowledge.
  - source: https://docs.getoutline.com/s/guide/doc/mentions-uP5nPgm6N4
- Outline Search and AI answers documentation describes workspace-wide discovery and answer generation over existing docs, which is how teams navigate and exploit that graph at scale.
  - source: https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06
- Outline OpenAPI exposes `documents.list` filtering by `backlinkDocumentId` and search endpoints (`documents.search`, `documents.search_titles`), confirming API-level primitives for graph traversal and discovery.
  - source: https://github.com/outline/openapi/blob/main/spec3.yml

## Current support in outline-agent
- Backlink traversal primitive exists today:
  - `documents.list` forwards `backlinkDocumentId` to `documents.list` API calls (`src/tools.js`, `src/tool-arg-schemas.js`).
- Discovery primitives exist and are robust for graph neighborhood expansion:
  - `documents.search` (semantic/title modes), `search.expand`, `search.research`, `documents.resolve`.
- Hydration and batch reads exist for node expansion:
  - `documents.info` with `id/ids`, plus summary/ids views for token-efficient expansion.
- Fallback for unsupported endpoints exists:
  - `api.call` can target raw API methods where dedicated wrappers are missing.

## Current limits/gaps in this repo
- G1: No first-class graph/backlink wrapper.
  - Users must know to pass `backlinkDocumentId` into generic `documents.list`; there is no explicit `documents.backlinks`/graph tool.
- G2: Contract docs drift for backlink support.
  - `backlinkDocumentId` is implemented in code/schema but missing from `docs/TOOL_CONTRACTS.md` `documents.list` signature.
- G3: No dedicated mentions relationship tool.
  - There is no wrapper that returns normalized mention/link edges as machine-readable graph output.
- G4: No deterministic graph traversal/report shape.
  - Current tools return search/list payloads, not a stable edge list (`from`, `to`, `relation`, `source`) for downstream automation.
- G5: Live tests do not validate backlink/mention graph workflows end-to-end.
  - Existing tests cover search/research/list basics, but not seeded cross-link graph traversal assertions.

## Improvement proposal (specific wrappers/schema/tests/docs)
- P1: Add graph-oriented wrappers.
  - `documents.backlinks(args: { id: string; limit?: number; offset?: number; view?: 'ids'|'summary'|'full' })`
  - behavior: thin wrapper over `documents.list({ backlinkDocumentId: id, ... })` with explicit graph intent.
  - `documents.graph_neighbors(args: { id?: string; ids?: string[]; includeBacklinks?: boolean; includeSearchNeighbors?: boolean; searchQueries?: string[]; limitPerSource?: number; view?: 'ids'|'summary' })`
  - behavior: returns normalized neighbors + edge metadata for agent traversal.
  - `documents.graph_report(args: { seedIds: string[]; depth?: number; maxNodes?: number; includeBacklinks?: boolean; includeSearchNeighbors?: boolean; })`
  - behavior: bounded BFS output with stable `nodes[]` and `edges[]` schema.
- P2: Add/adjust schemas in `src/tool-arg-schemas.js`.
  - define strict required fields and `id` vs `ids` exclusivity for graph tools.
  - enforce traversal safety bounds (`depth`, `maxNodes`, `limitPerSource`) to keep outputs deterministic and token-safe.
  - keep `performAction` requirements unchanged (all proposed graph tools are read-only).
- P3: Add live integration coverage in `test/live.integration.test.js`.
  - create suite-owned docs A/B/C with explicit cross-links in markdown.
  - assert `documents.backlinks(A)` returns expected referrers.
  - assert `documents.graph_neighbors` returns normalized edge rows with stable keys.
  - assert `documents.graph_report` traversal depth bounds and deterministic node IDs.
  - cleanup all suite-created docs.
- P4: Update docs.
  - `docs/TOOL_CONTRACTS.md`: add new graph wrappers and explicitly include `backlinkDocumentId` in `documents.list` signature.
  - `README.md`: add UC-10 command sequence (seed doc -> backlinks -> graph report -> targeted hydration).

## Issue resolution matrix
| Issue | Risk if unaddressed | Proposed remediation | Verification step |
| --- | --- | --- | --- |
| G1: No first-class graph/backlink wrapper. | Backlink traversal remains hidden behind generic `documents.list`, causing inconsistent usage and slower onboarding. | Implement `documents.backlinks` as the explicit wrapper described in P1 over `documents.list({ backlinkDocumentId })`. | Add live test with suite-created linked docs asserting `documents.backlinks(seedId)` returns expected referrers. |
| G2: Contract docs drift for backlink support. | Users follow stale docs and miss `backlinkDocumentId`, creating avoidable integration errors. | Update `docs/TOOL_CONTRACTS.md` to include `backlinkDocumentId` in `documents.list` and document graph wrappers (P4). | Run `node ./bin/outline-agent.js tools contract all --result-mode inline` and confirm `documents.list` contract reflects `backlinkDocumentId`. |
| G3: No dedicated mentions relationship tool. | Mention-derived edges cannot be consumed in a normalized way for graph automation. | Extend graph wrappers so mention/link relationships are emitted as normalized edges in `documents.graph_neighbors` (P1). | Add live subtest asserting normalized mention/link edge rows with stable keys for suite-owned docs. |
| G4: No deterministic graph traversal/report shape. | Downstream automations cannot rely on stable edge/node schemas, increasing token and parsing overhead. | Add `documents.graph_neighbors` and `documents.graph_report` with stable `nodes[]` and `edges[]` outputs plus safety bounds in schemas (P1, P2). | Add live assertions for traversal depth/max node bounds and deterministic node IDs in `documents.graph_report`. |
| G5: Live tests do not validate backlink/mention graph workflows end-to-end. | Regression risk stays high because graph behavior is not validated against real workspace data. | Add live integration coverage using suite-owned A/B/C docs, cross-links, and cleanup as listed in P3. | Execute `npm test` and confirm UC-10 graph subtests pass and cleanup removes suite-created docs. |

## Process checklist
1. Validate behavior against Outline docs for backlinks/mentions/search and confirm API constraints in OpenAPI.
2. Implement graph wrappers in `src/tools.js`/`src/tools.navigation.js` using existing list/search primitives.
3. Add strict arg schemas in `src/tool-arg-schemas.js` for all new graph wrapper args.
4. Add live subtests in `test/live.integration.test.js` with suite-created linked docs only.
5. Run `npm run check`.
6. Run `npm test` (live env configured).
7. Update `docs/TOOL_CONTRACTS.md` and `README.md` to keep contracts/examples synchronized.
