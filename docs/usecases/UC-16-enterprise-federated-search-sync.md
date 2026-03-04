# UC-16: Enterprise federated search synchronization

## Scenario
- use_case_id: UC-16
- name: Enterprise federated search synchronization
- primary_goal: Keep external enterprise search (Glean) aligned with Outline content freshness and permissions, with deterministic checks that can run in CI/cron.
- typical_actors: enterprise search admin, platform engineer, IT/security engineer, knowledge management owner, AI automation agent.
- core_workflow:
  1. Define the Outline scope to be indexed (collections, published docs, ownership boundaries).
  2. Generate a deterministic Outline-side sync manifest (document IDs, revision/update markers, URLs, published state).
  3. Run scheduled probe checks that validate findability and freshness against expected search behavior.
  4. Run permission snapshot checks to detect ACL drift that could leak or hide content in external search.
  5. Emit machine-readable results for alerting, reconciliation, and audit trails.

## Why this is real (source links)
- Outline documents a first-class Glean search integration and explicitly positions it for enterprise search setup:
  - source: https://docs.getoutline.com/s/guide/doc/glean-gepkPM3M7K
  - source: https://docs.getoutline.com/s/guide?q=integrations
- Outline docs state practical production constraints for Glean sync: it is available on Business plans+, content sync defaults to ~6 hours, and permission sync defaults to every few minutes.
  - source: https://docs.getoutline.com/s/guide/doc/glean-gepkPM3M7K
  - source: https://docs.getoutline.com/s/guide?q=integrations
- Outline docs also state that only content a user can access should be searchable, and troubleshooting mentions published/accessibility state as prerequisites.
  - source: https://docs.getoutline.com/s/guide/doc/glean-gepkPM3M7K
  - source: https://docs.getoutline.com/s/guide?q=integrations
- Outline API docs expose the search primitives needed for sync monitoring and reconciliation:
  - API overview (RPC, auth/scopes, pagination/rate limits): https://docs.getoutline.com/s/guide/doc/api-1rEIXDfLF6
  - `documents.search_titles`: https://github.com/outline/openapi/blob/main/spec3.yml#L2047
  - `documents.search`: https://github.com/outline/openapi/blob/main/spec3.yml#L2140
  - membership endpoints for ACL snapshots:
    - `collections.memberships`: https://github.com/outline/openapi/blob/main/spec3.yml#L815
    - `collections.group_memberships`: https://github.com/outline/openapi/blob/main/spec3.yml#L970
    - `documents.memberships`: https://github.com/outline/openapi/blob/main/spec3.yml#L2826
    - `documents.group_memberships`: https://github.com/outline/openapi/blob/main/spec3.yml#L3230
- Inference from the public OpenAPI path set: documented `integrations.*` API management endpoints are not present in `spec3.yml`, so enterprise sync operations need strong Outline-side probes in this CLI.
  - source: https://github.com/outline/openapi/blob/main/spec3.yml

## Current support in outline-agent
- Strong search/retrieval wrappers already exist for Outline-native discovery:
  - `documents.search` (titles/semantic modes + batching): `src/tools.js`
  - `search.expand` and `search.research` (search + hydration workflows): `src/tools.navigation.js`
- Raw endpoint access exists through `api.call` for uncovered methods.
  - source: `src/tools.js`
- Argument validation exists for current tools, including search and raw-call guards.
  - source: `src/tool-arg-schemas.js`
- Live tests already validate search and retrieval behavior against real Outline instances.
  - source: `test/live.integration.test.js`
- Contract docs are already established and machine-readable.
  - source: `docs/TOOL_CONTRACTS.md`

## Current limits/gaps in this repo
- G1: No federated-search-specific wrappers exist.
  - There is no first-class `federated.*` or `integrations.*` tool family for sync auditing workflows.
- G2: No schema-level contracts exist for sync-audit inputs.
  - Missing typed args for freshness SLA windows, probe mode selection, ACL snapshot options, and manifest cursoring.
- G3: No dedicated tool output shape for enterprise sync operations.
  - Current tools return search/doc payloads, but not a deterministic sync report object (`status`, `driftType`, `missing`, `stale`, `aclDelta`).
- G4: No live integration coverage for federated sync workflows.
  - Existing tests cover search primitives, but not end-to-end sync manifest + probe + ACL snapshot flow.
- G5: No operator runbook in docs for Glean-aligned sync verification cadence.
  - README/TOOL_CONTRACTS do not describe six-hour content drift checks or permission drift checks aligned to Glean defaults.

## Improvement proposal (specific wrappers/schema/tests/docs)
- P1: Add read-only federated sync wrappers in `src/tools.navigation.js` and register in `src/tools.js`.
  - `federated.sync_manifest(args?: { collectionId?: string; query?: string; since?: string; limit?: number; offset?: number; includeDrafts?: boolean; includeMemberships?: boolean; view?: 'ids'|'summary'|'full'; includePolicies?: boolean; })`
  - `federated.sync_probe(args: { ids?: string[]; queries?: string[]; mode?: 'titles'|'semantic'|'both'; collectionId?: string; limit?: number; freshnessHours?: number; view?: 'summary'|'full'; })`
  - `federated.permission_snapshot(args: { ids: string[]; includeCollectionMemberships?: boolean; includeDocumentMemberships?: boolean; view?: 'summary'|'full'; })`
- P2: Wrapper behaviors should be deterministic and machine-readable.
  - `sync_manifest`: emit stable rows `{id,title,collectionId,publishedAt,updatedAt,revision,urlId}` with optional membership attachments.
  - `sync_probe`: emit per-target status `{id,foundInTitles,foundInSemantic,ageHours,freshnessBreach}` plus aggregate counts.
  - `permission_snapshot`: emit explicit ACL maps from memberships/group-memberships endpoints for downstream search ACL reconciliation.
- P3: Add arg schemas in `src/tool-arg-schemas.js`.
  - Validate ISO timestamp input for `since`.
  - Enforce at least one of `ids|queries` for probes.
  - Enforce enum bounds (`mode`, `view`) and numeric bounds (`limit`, `freshnessHours`).
  - Require non-empty `ids[]` for permission snapshots.
- P4: Add live integration tests in `test/live.integration.test.js`.
  - Create isolated test doc.
  - Assert `federated.sync_manifest` includes the test doc in published/draft-appropriate mode.
  - Assert `federated.sync_probe` can detect title/semantic discoverability for the test marker.
  - Assert `federated.permission_snapshot` returns structured membership payloads (or scoped, explicit per-item errors).
  - Ensure deterministic cleanup with existing delete-read-token flow.
- P5: Update docs.
  - `docs/TOOL_CONTRACTS.md`: add new federated tool signatures/examples and result shapes.
  - `README.md`: add an “Enterprise federated search sync” playbook (manifest -> probe -> permission snapshot -> alerting).
  - Keep this UC-16 file as the scenario anchor and implementation checklist.

## Process checklist
1. Validate the latest Glean integration assumptions against Outline docs before coding (plan tier, content sync cadence, permission sync cadence).
2. Confirm endpoint payload constraints from Outline API docs/OpenAPI for search + memberships.
3. Implement `federated.sync_manifest`, `federated.sync_probe`, and `federated.permission_snapshot` wrappers.
4. Add strict arg schemas for all new wrapper arguments.
5. Add live integration subtests using suite-created documents only; keep cleanup deterministic.
6. Run `npm run check` and `npm test`.
7. Update `README.md` and `docs/TOOL_CONTRACTS.md` to match final contracts and usage.
