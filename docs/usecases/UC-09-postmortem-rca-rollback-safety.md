# UC-09: Postmortem and RCA docs with rollback safety

## Scenario
- use_case_id: UC-09
- name: Postmortem and RCA docs with rollback safety
- primary_goal: Capture incident timeline, root-cause analysis, and corrective actions in Outline with deterministic rollback and guarded mutations.
- typical_actors: incident commander, on-call engineer, service owner, engineering manager, reliability lead.
- core_workflow:
  1. Create a dedicated postmortem document and append timeline facts during incident response.
  2. Draft and refine RCA sections (trigger, contributing factors, blast radius, corrective actions) with concurrent editors.
  3. Use revision-aware mutations to avoid clobbering others’ edits while updates are ongoing.
  4. Review revision history during incident review to reconstruct what changed, by whom, and when.
  5. Restore a known-good revision if an edit or patch introduces incorrect incident facts.

## Why this is real (source links)
- Outline Revision history documents that every change is tracked and prior revisions can be restored, which is foundational for incident postmortem correction and auditability.
  - source: https://docs.getoutline.com/s/guide/doc/revision-history-AiL6p22Ssq
- Outline API docs define the automation surface needed for scripted postmortem/RCA workflows.
  - source: https://docs.getoutline.com/guide/doc/api
- Outline OpenAPI explicitly includes revision endpoints (`revisions.list`, `revisions.info`) and restore capability (`documents.restore`) used for rollback safety.
  - source: https://github.com/outline/openapi/blob/main/spec3.yml
- Google SRE guidance treats blameless postmortems and corrective follow-through as a core reliability practice, matching this workflow.
  - source: https://sre.google/workbook/postmortem-culture/
- Atlassian’s incident postmortem template reflects broad operational demand for structured RCA documents and recovery actions.
  - source: https://www.atlassian.com/incident-management/postmortem/templates

## Current support in outline-agent
- Revision-safe mutation primitives already exist:
  - `documents.safe_update` enforces optimistic concurrency via `expectedRevision` and returns deterministic `revision_conflict` on mismatch.
  - `documents.diff` previews line-level changes before write.
  - `documents.apply_patch` applies unified/replacement patches and returns parse/apply errors deterministically.
  - `documents.batch_update` supports multi-document edits with per-item success/failure envelopes.
- Rollback primitives are available:
  - `revisions.list` provides revision inventory for a document.
  - `revisions.restore` restores a document revision (via `documents.restore`) with action gating.
- Mutation safety controls are implemented across write paths:
  - explicit `performAction: true` gating for mutating tools.
  - delete safety flow: `documents.info({ armDelete: true })` issues a read receipt token, and `documents.delete` enforces token validity, document/profile binding, and stale-revision rejection.
- Live integration coverage already exercises core pieces:
  - mutation safety (`safe_update` success/conflict), diff/patch behavior, revisions list/restore, and read-token delete flow.

## Current limits/gaps in this repo
- G1: No first-class `revisions.info` wrapper.
  - OpenAPI exposes `revisions.info`, but this repo only wraps `revisions.list` and `revisions.restore`.
  - Impact: postmortem/RCA automation cannot reliably hydrate a specific revision body/metadata without generic `api.call`.
- G2: No direct revision-to-revision diff helper.
  - Users must manually stitch `api.call` + local diff logic to compare historical versions.
  - Impact: slower RCA audits and less deterministic rollback decision-making.
- G3: `documents.apply_patch` lacks an explicit `expectedRevision` guard.
  - It reads current text and then updates, but there is no caller-provided revision precondition.
  - Impact: race window remains for concurrent editors during high-pressure incident updates.
- G4: `documents.batch_update` is non-transactional and defaults to partial progress behavior.
  - Partial success is useful generally, but risky for tightly-coupled postmortem sections that must remain consistent.
- G5: Arg schema drift around structured metadata for incident docs.
  - Mutation implementations pass `dataAttributes`, but schemas for key mutation tools do not fully expose it.
  - Impact: weak contract enforcement for tagging RCA docs with structured incident metadata.
- G6: No UC-09-specific end-to-end test flow.
  - Existing live tests validate primitives, but not a full postmortem lifecycle from draft -> concurrent edits -> forensic review -> rollback decision.

## Improvement proposal (specific wrappers/schema/tests/docs)
- Wrappers:
  - add `revisions.info(args: { id: string; view?: 'summary'|'full' })`.
  - add `revisions.diff(args: { id: string; baseRevisionId: string; targetRevisionId: string; includeFullHunks?: boolean; hunkLimit?: number; hunkLineLimit?: number })` by hydrating both revisions then reusing the existing line-diff engine.
  - extend `documents.apply_patch` with optional `expectedRevision` precondition (or add `documents.apply_patch_safe`) for race-safe patching.
- Schema (`src/tool-arg-schemas.js`):
  - add schemas for `revisions.info` and `revisions.diff`.
  - add `expectedRevision` validation to patch-safe mutation path.
  - align mutation schemas with implementation for `dataAttributes` on relevant document mutation tools.
- Tests (`test/live.integration.test.js`):
  - add UC-09 flow subtest: create suite doc -> multiple edits -> `revisions.list` -> `revisions.info` -> `revisions.restore` -> assert restored content.
  - add concurrency safety subtest for patch precondition mismatch.
  - add stale delete-read-token subtest: read with `armDelete`, mutate document, then assert `documents.delete` fails with stale-token error.
  - add revision diff subtest asserting deterministic hunks/stats across two known revisions.
- Docs:
  - update `docs/TOOL_CONTRACTS.md` with new revision wrappers and patch precondition contract.
  - update `README.md` with a UC-09 command sequence for postmortem drafting, review, and rollback-safe recovery.

## Process checklist
1. Verify revision/mutation endpoint contracts against Outline docs and OpenAPI (`revisions.info`, `revisions.list`, `documents.restore`, `documents.update`).
2. Implement wrappers in `src/tools.mutation.js` and register contracts in tool metadata exports.
3. Add/update arg schemas in `src/tool-arg-schemas.js` for all new/changed arguments.
4. Add live integration subtests in `test/live.integration.test.js` using suite-created documents only.
5. Run `npm run check`.
6. Run `npm test` in live env.
7. Update `docs/TOOL_CONTRACTS.md` and `README.md` so contracts/examples stay synchronized.
