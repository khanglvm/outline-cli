# UC-20: Secure lifecycle governance (safe delete, archival/restore, cleanup automation)

## Scenario
- use_case_id: UC-20
- name: Secure lifecycle governance (safe delete, archival/restore, cleanup automation)
- primary_goal: Enforce deterministic, low-risk document lifecycle controls (archive, trash, restore, cleanup) with auditable delete safeguards and revision-aware recovery.
- typical_actors: workspace admin, compliance/security lead, knowledge manager, SRE/platform engineer, AI automation agent.
- core_workflow:
  1. Identify aging/obsolete documents and move them to archive instead of hard deletion.
  2. For documents requiring removal, execute safe delete via explicit read-confirmation and action gating.
  3. Monitor deleted/archived sets and restore documents when policy, incident, or legal-hold needs change.
  4. Run bounded cleanup automation for suite-created/test artifacts with explicit safety controls.
  5. Preserve revision/audit evidence so lifecycle actions remain explainable and reversible.

## Why this is real (source links)
- Outline documents revision history as a first-class capability, which is foundational for auditable lifecycle governance and rollback.
  - source: https://docs.getoutline.com/s/guide/doc/revision-history-AiL6p22Ssq
- Outline exposes audit logs, which matches governance expectations for traceable destructive/restore actions.
  - source: https://docs.getoutline.com/s/guide/doc/audit-log-WRjWMGxPvb
- OpenAPI explicitly defines document lifecycle endpoints needed for governance automation:
  - `documents.archive`: https://github.com/outline/openapi/blob/main/spec3.yml#L2622
  - `documents.restore`: https://github.com/outline/openapi/blob/main/spec3.yml#L2668
  - `documents.delete` (trash/permanent behavior): https://github.com/outline/openapi/blob/main/spec3.yml#L2722
  - `documents.archived`: https://github.com/outline/openapi/blob/main/spec3.yml#L2984
  - `documents.deleted`: https://github.com/outline/openapi/blob/main/spec3.yml#L3029
  - `documents.empty_trash`: https://github.com/outline/openapi/blob/main/spec3.yml#L3288
- OpenAPI also defines revision lifecycle hydration/list endpoints required for recovery evidence:
  - `revisions.info`: https://github.com/outline/openapi/blob/main/spec3.yml#L4291
  - `revisions.list`: https://github.com/outline/openapi/blob/main/spec3.yml#L4328
- This repo already codifies a safe delete read-confirmation flow, showing explicit product need for guarded lifecycle mutations.
  - source: https://github.com/khanglvm/outline-cli/blob/main/README.md#7-safe-mutation-and-revision-workflows

## Current support in outline-agent
- Safe delete handshake is implemented and enforced:
  - `documents.info` can issue `deleteReadReceipt` when `armDelete=true`.
  - `documents.delete` requires `readToken`, validates token/profile/document binding, checks stale revision, then consumes token on success.
  - source: `src/tools.js`, `src/tools.mutation.js`, `src/action-gate.js`, `docs/TOOL_CONTRACTS.md`
- Revision rollback primitives exist:
  - `revisions.list` and `revisions.restore` are first-class tools and action-gated where mutating.
  - source: `src/tools.mutation.js`, `src/tool-arg-schemas.js`, `docs/TOOL_CONTRACTS.md`
- Cleanup automation exists for test artifacts:
  - `documents.cleanup_test` supports marker-scoped candidate discovery, dry-run default, bounded pagination, and action-gated delete mode.
  - source: `src/tools.platform.js`, `src/tool-arg-schemas.js`, `README.md`
- Live integration coverage includes core mutation safety and basic lifecycle checks:
  - tests cover revision-safe updates, diff/patch, revision restore, cleanup dry-run, and safe document delete.
  - source: `test/live.integration.test.js`

## Current limits/gaps in this repo
- G1: No first-class wrappers for major archive/trash lifecycle endpoints.
  - Missing dedicated tools for `documents.archive`, `documents.archived`, `documents.deleted`, and `documents.empty_trash` despite OpenAPI support.
  - Operators must use generic `api.call`, reducing discoverability and deterministic contracts.
- G2: Restore semantics are only partially modeled.
  - `revisions.restore` exists, but there is no first-class `documents.restore` wrapper for archive/trash recovery flows that are not revision-targeted.
- G3: Cleanup automation bypasses the safe delete read-token protocol.
  - `documents.cleanup_test` currently calls `documents.delete` endpoint directly per candidate instead of minting/validating read receipts.
  - Impact: cleanup path skips the same stale-revision/read-confirmation guarantees applied by `documents.delete` wrapper.
- G4: Revision lifecycle hydration is incomplete.
  - `revisions.info` is in OpenAPI but not wrapped, limiting deterministic evidence capture before/after restore decisions.
- G5: Live lifecycle tests are not end-to-end for archive/trash governance.
  - Current suite does not validate archive listing, deleted listing, restore-from-trash/archive paths, or cleanup behavior under read-token-safe mode.
- G6: Operator docs do not provide a single secure lifecycle runbook.
  - `README.md` and `docs/TOOL_CONTRACTS.md` document pieces, but not a complete archive/delete/restore/cleanup governance sequence.

## Improvement proposal (specific wrappers/schema/tests/docs)
- P1: Add lifecycle read wrappers in `src/tools.js`.
  - `documents.archived(args?: { collectionId?: string; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; view?: 'ids'|'summary'|'full'; includePolicies?: boolean })`
  - `documents.deleted(args?: { limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; view?: 'ids'|'summary'|'full'; includePolicies?: boolean })`
  - Reuse current deterministic view shaping (`ids|summary|full`) for token-efficient lifecycle inventory.
- P2: Add lifecycle mutation wrappers in `src/tools.mutation.js`.
  - `documents.archive(args: { id: string; view?: 'summary'|'full'; includePolicies?: boolean; performAction?: boolean })`
  - `documents.restore(args: { id: string; collectionId?: string; revisionId?: string; view?: 'summary'|'full'; includePolicies?: boolean; performAction?: boolean })`
  - `documents.empty_trash(args?: { performAction?: boolean })`
  - Keep all mutation wrappers explicitly action-gated with `performAction: true`.
- P3: Harden cleanup automation in `src/tools.platform.js`.
  - Add `deleteMode?: 'safe'|'direct'` and default to `safe`.
  - In `safe` mode, for each candidate: `documents.info(armDelete=true)` -> use returned token -> call existing `documents.delete` wrapper path semantics (including stale revision check).
  - Keep `dryRun=true` default and include per-item lifecycle evidence (`tokenIssued`, `revisionChecked`, `deleted`).
- P4: Add/extend arg schemas in `src/tool-arg-schemas.js`.
  - Add schemas for `documents.archived`, `documents.deleted`, `documents.archive`, `documents.restore`, `documents.empty_trash`.
  - Add enum validation for lifecycle list sort/direction/view and required fields for mutate endpoints.
  - Extend `documents.cleanup_test` schema with `deleteMode` enum and guardrails for safe defaults.
- P5: Add live integration tests in `test/live.integration.test.js` (suite-owned docs only).
  - Flow A: create doc -> `documents.archive` -> assert presence in `documents.archived` -> `documents.restore` -> verify active doc.
  - Flow B: create doc -> safe delete (`armDelete` + `documents.delete`) -> assert presence in `documents.deleted` -> `documents.restore` -> verify active doc.
  - Flow C: cleanup safety regression -> create marker docs -> run `documents.cleanup_test` dry-run and safe delete mode -> assert deletions succeeded with deterministic per-item results.
  - Flow D: `revisions.info` hydration check after obtaining revision IDs from `revisions.list`.
- P6: Update docs.
  - `docs/TOOL_CONTRACTS.md`: add lifecycle tool contracts/examples and explicit governance best practices.
  - `README.md`: add a "Secure lifecycle governance" command sequence (archive -> list archived/deleted -> safe delete -> restore -> cleanup dry-run/execute).
  - Keep this UC-20 file as the implementation anchor.

## Issue resolution matrix
| Issue | Risk if unaddressed | Proposed remediation | Verification step |
| --- | --- | --- | --- |
| G1: No first-class wrappers for major archive/trash lifecycle endpoints. | Lifecycle governance depends on generic `api.call`, reducing contract stability and increasing operator error. | Implement P1 lifecycle read wrappers for `documents.archived` and `documents.deleted`, and include `documents.archive` and `documents.empty_trash` wrappers from P2. | Add live subtests from P5 that call lifecycle wrappers directly and assert deterministic `ids|summary|full` output shapes. |
| G2: Restore semantics are only partially modeled. | Recovery from archive/trash is inconsistent because only revision-targeted restore is first-class. | Implement P2 `documents.restore` wrapper with action gating and deterministic response shaping. | Run P5 restore path tests for archived and deleted documents and verify restored documents are active. |
| G3: Cleanup automation bypasses the safe delete read-token protocol. | Cleanup deletes can bypass stale-revision/read-confirmation safeguards required by governance policy. | Implement P3 safe cleanup mode by default (`deleteMode: safe`) using `documents.info(armDelete=true)` and token-backed delete flow. | Add P5 cleanup regression tests to assert token issuance, revision check, and deletion evidence per candidate. |
| G4: Revision lifecycle hydration is incomplete. | Operators cannot reliably capture revision-level evidence before or after restore decisions. | Implement P4/P5 coverage for `revisions.info` wrapper and schema validation. | Execute P5 revision hydration subtest: list revisions, call `revisions.info`, and verify evidence fields are present. |
| G5: Live lifecycle tests are not end-to-end for archive/trash governance. | Lifecycle behavior can regress without detection across archive, deleted listing, and restore flows. | Implement P5 end-to-end live tests for archive, safe delete, deleted listing, restore, and cleanup. | Run `npm test` and verify lifecycle subtests pass using suite-created documents only. |
| G6: Operator docs do not provide a single secure lifecycle runbook. | Teams may execute lifecycle actions inconsistently and miss required safeguards. | Implement P6 documentation updates in `README.md` and `docs/TOOL_CONTRACTS.md` with a unified secure lifecycle sequence. | Review updated docs for a complete archive -> list -> safe delete -> restore -> cleanup flow and matching contracts. |

## Process checklist
1. Re-verify OpenAPI lifecycle contracts for `documents.archive/restore/delete/archived/deleted/empty_trash` and `revisions.info/list`.
2. Implement lifecycle read wrappers (`documents.archived`, `documents.deleted`) with deterministic `ids|summary|full` views.
3. Implement action-gated lifecycle mutation wrappers (`documents.archive`, `documents.restore`, `documents.empty_trash`).
4. Add `revisions.info` wrapper to complete revision evidence workflows.
5. Upgrade `documents.cleanup_test` to default safe-delete mode using read-token lifecycle checks.
6. Add/adjust arg schemas for every new lifecycle wrapper and cleanup mode.
7. Add live integration subtests for archive/delete/restore/cleanup flows using suite-created docs only.
8. Run `npm run check` and `npm test`.
9. Update `docs/TOOL_CONTRACTS.md` and `README.md` to keep tool contracts and operator workflow in sync.
