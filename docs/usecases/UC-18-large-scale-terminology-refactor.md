# UC-18: Large-scale controlled terminology refactors across docs

## Scenario
- use_case_id: UC-18
- name: Large-scale controlled terminology refactors across docs
- primary_goal: Replace deprecated or non-approved terms across many documents while preserving reviewability, safety gates, and audit evidence.
- typical_actors: knowledge governance lead, compliance/policy owner, technical writer, platform engineer, AI automation agent.
- core_workflow:
  1. Define a controlled terminology map (legacy -> approved terms, with scope and exceptions).
  2. Discover candidate documents by query and/or collection boundaries.
  3. Generate a deterministic batch-update plan with per-document impact previews.
  4. Review and approve planned changes before execution.
  5. Apply changes with explicit action gating and revision-safe writes.
  6. Verify sampled documents and capture revision/audit evidence.

## Why this is real (source links)
- Outline has first-class terminology guidance, which implies real-world need for consistent language use across docs.
  - source: https://docs.getoutline.com/s/guide/doc/terminology-5M71wRBwAl
- Enterprise documentation governance in Outline is collection/role/group-driven, which maps directly to scoped terminology rollouts by domain (HR, legal, finance, engineering).
  - sources:
    - https://docs.getoutline.com/s/guide/doc/collections-l9o3LD22sV
    - https://docs.getoutline.com/s/guide/doc/users-groups-cwCxXP8R3V
    - https://docs.getoutline.com/s/guide/doc/groups-Jy1rROTFmN
- Outline revision history exists specifically for traceability and rollback during broad content changes.
  - source: https://docs.getoutline.com/s/guide/doc/revision-history-AiL6p22Ssq
- This repository already treats bulk plan/apply as core primitives for controlled text refactors.
  - sources:
    - [README batch planning/apply examples](../../README.md)
    - [Tool contracts: `documents.plan_batch_update` / `documents.apply_batch_plan`](../TOOL_CONTRACTS.md)
    - [Live integration test coverage for plan -> dryRun -> apply](../../test/live.integration.test.js)
- Enterprise governance use cases already documented in this repo require the same safety and audit posture this scenario needs.
  - sources:
    - [UC-02: SOP/policy wiki with safe bulk maintenance](./UC-02-team-sop-policy-wiki.md)
    - [UC-06: role-based department spaces](./UC-06-role-based-department-spaces.md)
    - [UC-13: API-driven workspace automation and audit logs](./UC-13-api-driven-workspace-automation.md)

## Current support in outline-agent
- Candidate discovery and scoping:
  - `documents.search`, `documents.resolve`, `documents.list`, `documents.info`, `collections.list`, `collections.info`, `collections.tree`.
- Controlled terminology planning/apply path already exists:
  - `documents.plan_batch_update` supports term rules (`find`, `replace`, `field`, `caseSensitive`, `wholeWord`, `all`) and returns `impacts`, diff hunks, and `planHash`.
  - `documents.apply_batch_plan` enforces `confirmHash` and supports `dryRun`, `continueOnError`, and bounded concurrency.
  - plan apply writes are revision-safe through `expectedRevision` in each plan item (executed via `documents.safe_update`).
- Alternate bulk mutation path exists:
  - `documents.batch_update` for direct multi-document changes.
- Governance/safety primitives exist:
  - explicit `performAction: true` gating on mutators.
  - `revisions.list` and `revisions.restore` for post-change validation and rollback.

## Current limits/gaps in this repo
- G1: No terminology-specific wrapper.
  - Operators must handcraft `rules[]` for every run; there is no first-class glossary/controlled-vocabulary input contract.
- G2: Scope controls are still generic.
  - `plan_batch_update` supports ids/query/collection discovery, but lacks dedicated include/exclude controls for governance-oriented refactors (for example, archived docs, known exception sets, or owner-based slices).
- G3: No structure-aware replacement guards.
  - Current rule application is regex-based over title/text and cannot explicitly exclude code fences, inline code, or link targets where term replacement may be unsafe.
- G4: Governance metadata is not modeled in plan/apply contracts.
  - There is no schema for change-ticket ID, approver, rationale, or policy version attached to a terminology refactor run.
- G5: Audit surface is incomplete for enterprise reporting.
  - `revisions.*` exists, but there is no first-class `events.list` wrapper to pull an audit feed for change evidence in the same workflow.
- G6: Live tests validate mechanics, not large-scale governance scenarios.
  - Current tests cover plan/apply correctness, but not multi-collection terminology programs with exception lists and approval metadata.

## Improvement proposal (specific wrappers/schema/tests/docs)
- Wrappers:
  - add `documents.plan_terminology_refactor(args: { glossary: Array<{ find: string; replace: string; field?: 'title'|'text'|'both'; caseSensitive?: boolean; wholeWord?: boolean; all?: boolean; }>; id?: string; ids?: string[]; query?: string; queries?: string[]; collectionId?: string; includeTitleSearch?: boolean; includeSemanticSearch?: boolean; limitPerQuery?: number; offset?: number; maxDocuments?: number; readConcurrency?: number; includeUnchanged?: boolean; hunkLimit?: number; hunkLineLimit?: number; excludeDocIds?: string[]; excludePatterns?: string[]; excludeCodeBlocks?: boolean; excludeInlineCode?: boolean; })`.
  - add `documents.apply_terminology_refactor(args: { plan: object; confirmHash: string; dryRun?: boolean; continueOnError?: boolean; concurrency?: number; view?: 'summary'|'full'; maxAttempts?: number; changeRequestId?: string; policyVersion?: string; approver?: string; performAction?: boolean; })`.
  - add `events.list` wrapper to close audit evidence gap for governance programs.
- Schema (`src/tool-arg-schemas.js`):
  - add strict schemas for both terminology wrappers and `events.list`.
  - enforce non-empty glossary arrays, unique `find` terms, and reject no-op pairs (`find === replace`).
  - enforce target requirements (at least one of `id|ids|query|queries`) and existing search toggles.
  - validate `excludePatterns` as compilable regex strings.
  - keep `performAction: true` mandatory on apply when `dryRun=false`.
- Tests (`test/live.integration.test.js`):
  - add UC-18 live subtests using suite-created docs only:
    1. create a multi-doc fixture set across at least two collections,
    2. run `plan_terminology_refactor` with glossary + exclusions,
    3. assert deterministic `planHash` and expected replacement counts,
    4. run `apply_terminology_refactor` dry-run then real apply,
    5. verify sampled docs + revision entries,
    6. assert hash mismatch and missing `performAction` failures,
    7. cleanup all suite-created docs.
- Docs:
  - update `docs/TOOL_CONTRACTS.md` with signatures/examples/best practices for new wrappers.
  - update `README.md` with a terminology-governance playbook (discover -> plan -> review -> dryRun -> apply -> audit).
  - keep this UC-18 file as the scenario anchor for controlled terminology programs.

## Issue resolution matrix
| Issue | Risk if unaddressed | Proposed remediation | Verification step |
| --- | --- | --- | --- |
| G1: No terminology-specific wrapper. | Refactor runs stay hand-built and inconsistent, increasing operator error and review friction. | Add `documents.plan_terminology_refactor` with strict `glossary` contract and plan output parity with current batch planning (`impacts`, hunks, `planHash`). | Create a glossary-based plan and confirm deterministic `planHash` plus expected replacement counts in live tests. |
| G2: Scope controls are still generic. | Out-of-scope documents can be included, causing unintended broad edits in governance rollouts. | Extend terminology planning with explicit exclusion controls (`excludeDocIds`, `excludePatterns`) and preserve collection/query scope knobs. | Run a scoped plan with exclusion lists and assert excluded docs do not appear in `impacts` or apply targets. |
| G3: No structure-aware replacement guards. | Replacements can corrupt code fences, inline code, or link targets where edits are unsafe. | Add guard args (`excludeCodeBlocks`, `excludeInlineCode`) and enforce them in terminology planning/apply behavior. | Use fixture docs containing code fences, inline code, and links; assert only safe prose segments are modified. |
| G4: Governance metadata is not modeled in plan/apply contracts. | Approval traceability is weak, making audits and policy sign-off harder to defend. | Add governance fields (`changeRequestId`, `policyVersion`, `approver`) to terminology apply schema and output envelope. | Execute apply with governance metadata and assert returned results include those fields for evidence capture. |
| G5: Audit surface is incomplete for enterprise reporting. | Teams must assemble evidence manually across tools, increasing audit risk and effort. | Add an `events.list` wrapper so audit-feed retrieval is available in the same workflow as plan/apply/revisions. | After apply, query `events.list` for the run window and verify relevant document change events are returned. |
| G6: Live tests validate mechanics, not large-scale governance scenarios. | Regressions in multi-collection, policy-driven refactors can ship without detection. | Add UC-18 live integration subtests covering glossary exclusions, dry-run and apply, failure gates, and cleanup. | Run `npm test` and confirm the UC-18 path passes including hash mismatch and missing `performAction` negative checks. |

## Process checklist
1. Confirm approved terminology map (owner, policy version, effective date, exception terms).
2. Resolve target scope (`collectionId` and/or query set) and exclude known exception documents.
3. Generate refactor plan and review `impacts`, hunks, and `planHash`.
4. Run apply dry-run with the same `confirmHash` for preflight confirmation.
5. Execute apply with explicit `performAction: true` after approval.
6. Verify random and high-risk sample docs (`documents.info`) and revision trail (`revisions.list`).
7. Capture audit evidence (plan hash, change request ID, applied counts, failed items, rollback links).
8. If needed, rollback targeted docs via `revisions.restore` and rerun with refined glossary/exclusions.
