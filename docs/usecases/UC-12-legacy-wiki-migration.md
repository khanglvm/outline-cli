# UC-12: Migration from legacy wiki into Outline

## Scenario
- use_case_id: UC-12
- name: Migration from legacy wiki into Outline
- primary_goal: Move legacy wiki content (especially Confluence) into Outline with predictable execution, post-import validation, and low-risk remediation.
- typical_actors: knowledge manager, IT admin, platform engineer, technical writer, team leads.
- core_workflow:
  1. Inventory legacy wiki scope (spaces, page trees, owners, cutover window).
  2. Import content into target Outline collections.
  3. Verify imported hierarchy/content completeness.
  4. Run targeted cleanup fixes (formatting/link/title cleanup) in controlled batches.
  5. Produce a migration report and sign-off checklist for workspace owners.

## Why this is real (source links)
- Outline has a dedicated Import guide, indicating migration is a first-class onboarding path and not an edge case.
  - source: https://docs.getoutline.com/s/guide/doc/import-6Y8M8z8f7B
- Outline has a dedicated Confluence import guide, which directly maps to the “legacy wiki to Outline” scenario.
  - source: https://docs.getoutline.com/s/guide/doc/confluence-WUeXf8AlHz
- Outline OpenAPI includes `documents.import` plus `fileOperations.*` endpoints, confirming API-level primitives exist for import-oriented workflows.
  - source: https://github.com/outline/openapi/blob/main/spec3.yml

## Current support in outline-agent
- Raw endpoint access exists via `api.call`, so advanced users can invoke unwrapped methods when they know exact API method names.
- Post-import discovery and verification primitives are strong:
  - `documents.list`, `documents.search`, `documents.resolve`, `collections.tree`, `documents.info`.
- Post-import remediation primitives are strong:
  - `documents.diff`, `documents.apply_patch`, `documents.batch_update`, `documents.plan_batch_update`, `documents.apply_batch_plan`, `documents.safe_update`.
- Capability probing exists (`capabilities.map`) to quickly check role/permission constraints before migration operations.

## Current limits/gaps in this repo
- G1: No first-class import wrappers.
  - There is no `documents.import` wrapper and no `fileOperations.list/info/delete` wrappers in tool registry/contracts.
- G2: JSON-only transport blocks file import workflows.
  - `OutlineClient` always sends `application/json`, but OpenAPI defines `documents.import` as `multipart/form-data` with required `file` payload.
  - Result: this CLI cannot currently execute documented file-import flows directly.
- G3: Confluence migration flow is undocumented in this repo.
  - No UC/runbook explains how to combine Outline’s native Confluence import path with outline-agent verification/remediation.
- G4: Action-gating heuristic does not include `import` methods.
  - `api.call` mutation gate regex covers create/update/delete/etc. but not `import`, so mutating import methods are not explicitly gated.
- G5: No live integration tests for migration lifecycle.
  - Tests do not cover import invocation, import status tracking, or post-import verification/reporting flow.

## Improvement proposal (specific wrappers/schema/tests/docs)
- Wrappers (`src/tools.js` or split into `src/tools.mutation.js` + `src/tools.navigation.js`):
  - `documents.import_file(args: { filePath: string; collectionId?: string; parentDocumentId?: string; publish?: boolean; view?: 'summary'|'full'; performAction?: boolean })`
  - `file_operations.list(args: { type?: 'import'|'export'; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; view?: 'summary'|'full' })`
  - `file_operations.info(args: { id: string; view?: 'summary'|'full' })`
  - `file_operations.delete(args: { id: string; performAction?: boolean })`
- Client transport (`src/outline-client.js`):
  - Add request-body mode support (`json` vs `multipart`) so `documents.import_file` can send actual file payloads.
  - Preserve existing JSON behavior for all current tools.
- Action gating (`src/action-gate.js`):
  - Extend mutation detection to include `import` (and optionally `export`) so raw mutating import calls require explicit operator intent.
- Schemas (`src/tool-arg-schemas.js`):
  - Add strict schemas for `documents.import_file` and `file_operations.*`.
  - Enforce exactly one placement target (`collectionId` xor `parentDocumentId`) for import targeting.
  - Require `performAction: true` for import and delete-style file operation mutations.
- Tests (`test/live.integration.test.js`):
  - Add migration subtests using suite-created fixtures:
    1. create a local markdown fixture,
    2. import into a suite collection,
    3. verify via `documents.info/search/list`,
    4. validate cleanup flow using patch/batch updates,
    5. cleanup imported test docs.
  - Add a gating test to ensure import mutation paths fail without `performAction=true`.
- Docs:
  - Update `docs/TOOL_CONTRACTS.md` with new wrappers and signatures.
  - Update `README.md` with a “legacy wiki migration” command sequence.
  - Keep this UC-12 file as the scenario anchor for migration-specific guidance.

## Issue resolution matrix
| Issue | Risk if unaddressed | Proposed remediation | Verification step |
| --- | --- | --- | --- |
| G1: No first-class import wrappers. | Operators depend on raw `api.call`, creating inconsistent invocation patterns and higher error rates during migration runs. | Add `documents.import_file` and `file_operations.list/info/delete` wrappers with stable CLI contracts. | Run `node ./bin/outline-agent.js tools contract all --result-mode inline` and confirm new tool contracts are listed and callable. |
| G2: JSON-only transport blocks file import workflows. | Documented import flows cannot be executed from this CLI, forcing manual UI-only import and breaking automated migration pipelines. | Extend `OutlineClient` request handling to support `multipart/form-data` for import while preserving JSON behavior for existing tools. | Execute a live import of a suite fixture file and verify imported content appears via `documents.list/search/info`. |
| G3: Confluence migration flow is undocumented in this repo. | Teams lack a repeatable runbook for combining Outline native import with post-import validation and cleanup, increasing cutover risk. | Add migration runbook guidance in this UC and link command sequence in `README.md` for verification/remediation flow. | Follow documented sequence end to end on a test collection and confirm each step is executable without ad-hoc decisions. |
| G4: Action-gating heuristic does not include `import` methods. | Mutating import calls can run without explicit operator intent, weakening safety guarantees of mutation gating. | Extend action gate mutation detection to include `import` (and optionally `export`) and require `performAction: true`. | Add and run a gating test that fails import mutation without `performAction=true` and passes with explicit approval. |
| G5: No live integration tests for migration lifecycle. | Regressions in import, status tracking, and post-import remediation can ship unnoticed and break production migration workflows. | Add live integration coverage for fixture import, verification queries, remediation operations, and cleanup on suite-created docs. | Run `npm test` in live environment and confirm migration lifecycle subtests pass consistently. |

## Process checklist
1. Confirm migration scope and cutover criteria with workspace owners.
2. Prepare destination collections and access controls in Outline.
3. Execute import path (Outline Import / Confluence import) and capture operation IDs where available.
4. Run automated verification (`collections.tree`, `documents.search`, `documents.resolve`, targeted `documents.info`).
5. Apply deterministic remediation batches (`documents.plan_batch_update` -> `documents.apply_batch_plan` with confirm hash).
6. Re-verify high-risk pages (navigation hubs, runbooks, policy docs).
7. Produce migration report: imported count, failed/skipped items, manual follow-ups, final sign-off.
