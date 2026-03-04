# UC-11: Standardized doc creation via templates/placeholders

## Scenario
- use_case_id: UC-11
- name: Standardized doc creation via templates/placeholders
- primary_goal: Produce consistent, repeatable documents by creating from templates and filling placeholders deterministically.
- typical_actors: operations lead, project manager, technical writer, support manager, AI automation agent.
- core_workflow:
  1. Create or templatize a high-quality canonical document for a recurring workflow.
  2. Define placeholders (for example `{{service_name}}`, `{{owner}}`, `{{target_date}}`) inside the template.
  3. Instantiate new documents from that template for each run/project/incident.
  4. Fill placeholder values consistently before publish.
  5. Enforce that unresolved placeholders are detected early to prevent low-quality or incomplete docs.

## Why this is real (source links)
- Outline Templates documentation explicitly supports reusable templates and placeholder variables using `{{...}}`, with values filled once during document creation.
  - source: https://docs.getoutline.com/s/guide/doc/templates-GP6DXgRtxl
- Outline OpenAPI includes a full template lifecycle (`templates.create`, `templates.list`, `templates.info`, `templates.update`, `templates.delete`, `templates.restore`, `templates.duplicate`).
  - source: https://github.com/outline/openapi/blob/main/spec3.yml#L5197
- Outline OpenAPI includes `documents.templatize`, which formalizes converting an existing document into a reusable template.
  - source: https://github.com/outline/openapi/blob/main/spec3.yml#L2459
- Outline OpenAPI defines a `Template` schema (`data` as Prosemirror document + metadata), confirming templates are first-class API entities rather than UI-only behavior.
  - source: https://github.com/outline/openapi/blob/main/spec3.yml#L6488

## Current support in outline-agent
- Template application is partially supported on document operations:
  - `documents.create`, `documents.update`, and `documents.safe_update` accept `templateId`.
- Safety primitives already exist for mutations:
  - mutating operations require explicit `performAction: true` where action-gated.
- Deterministic read/search primitives are available to support pipeline orchestration:
  - `documents.list`, `documents.info`, `documents.search`, `documents.resolve`, `search.expand`.
- Raw API fallback exists:
  - `api.call` can invoke uncovered template endpoints when operators know raw method names.

## Current limits/gaps in this repo
- G1: No first-class wrappers for template lifecycle endpoints.
  - Missing `templates.list|info|create|update|delete|restore|duplicate`.
- G2: No dedicated wrapper for `documents.templatize`.
  - Users must drop to `api.call` for a core template pipeline step.
- G3: No standardized placeholder pipeline abstraction.
  - There is no wrapper contract for placeholder extraction/validation or deterministic value injection rules.
- G4: No live integration coverage for template-driven creation flows.
  - `test/live.integration.test.js` does not validate templatize/template lifecycle/placeholder completion flows.
- G5: Contract documentation does not expose template lifecycle operations as first-class tools.
  - `docs/TOOL_CONTRACTS.md` currently documents `templateId` passthrough but not template wrappers.

## Improvement proposal (specific wrappers/schema/tests/docs)
- P1: Add explicit wrapper tools for template lifecycle and conversion.
  - `templates.list(args?: { collectionId?: string; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; view?: 'ids'|'summary'|'full'; includePolicies?: boolean })`
  - `templates.info(args: { id?: string; ids?: string[]; view?: 'summary'|'full'; includePolicies?: boolean; concurrency?: number })`
  - `templates.create(args: { title: string; data: object; icon?: string; color?: string; collectionId?: string; view?: 'summary'|'full'; performAction?: boolean })`
  - `templates.update(args: { id: string; title?: string; data?: object; icon?: string | null; color?: string | null; fullWidth?: boolean; collectionId?: string | null; view?: 'summary'|'full'; performAction?: boolean })`
  - `templates.delete(args: { id: string; performAction?: boolean })`
  - `templates.restore(args: { id: string; view?: 'summary'|'full'; performAction?: boolean })`
  - `templates.duplicate(args: { id: string; title?: string; collectionId?: string | null; view?: 'summary'|'full'; performAction?: boolean })`
  - `documents.templatize(args: { id: string; collectionId?: string | null; publish: boolean; view?: 'summary'|'full'; performAction?: boolean })`
- P2: Add placeholder-aware high-level pipeline wrappers.
  - `templates.extract_placeholders(args: { id: string })` (read-only): parse template `data` text nodes and return sorted unique placeholder keys.
  - `documents.create_from_template(args: { templateId: string; title?: string; collectionId?: string; parentDocumentId?: string; publish?: boolean; placeholderValues?: Record<string,string>; strictPlaceholders?: boolean; view?: 'summary'|'full'; performAction?: boolean })`.
  - behavior: create document from template, optionally apply placeholder values, and fail deterministically when unresolved placeholders remain and `strictPlaceholders=true`.
- P3: Add arg schemas in `src/tool-arg-schemas.js` for every wrapper arg.
  - enforce required IDs and `id` vs `ids` exclusivity.
  - enforce pagination bounds and enum constraints.
  - enforce object shape for `placeholderValues` and boolean flags for strict validation.
  - require `performAction: true` for all mutating template wrappers.
- P4: Add live integration tests in `test/live.integration.test.js`.
  - flow A: create suite-owned doc -> `documents.templatize` -> assert `templates.list/info` visibility.
  - flow B: instantiate from template with placeholder values -> assert expected values are present and unresolved placeholder tokens are absent in strict mode.
  - flow C: template lifecycle mutation checks (`update`, `duplicate`, `delete`, `restore`) with cleanup.
- P5: Update docs.
  - `docs/TOOL_CONTRACTS.md`: add signatures/examples for all template wrappers + placeholder pipeline tools.
  - `README.md`: add UC-11 command sequence (templatize -> list/info -> create_from_template -> validate -> cleanup).

## Issue resolution matrix
| Issue | Risk if unaddressed | Proposed remediation | Verification step |
| --- | --- | --- | --- |
| G1: No first-class wrappers for template lifecycle endpoints. | Template operations remain dependent on low-level `api.call`, reducing consistency, discoverability, and safe defaults. | Implement explicit wrapper tools for `templates.list|info|create|update|delete|restore|duplicate` with stable views and action gating. | Run live integration tests that exercise lifecycle listing, read, mutation, and recovery paths for suite-created templates. |
| G2: No dedicated wrapper for `documents.templatize`. | A core conversion step in template pipelines stays manual and error-prone, increasing operator complexity. | Add `documents.templatize` as a first-class wrapper with validated arguments and `performAction` gating. | Execute a live flow that creates a suite-owned doc, templatizes it, and verifies visibility through template list/info wrappers. |
| G3: No standardized placeholder pipeline abstraction. | Placeholder handling can drift across callers, causing unresolved tokens or inconsistent generated docs. | Add `templates.extract_placeholders` and `documents.create_from_template` with deterministic placeholder validation and strict mode failure on unresolved tokens. | Add tests that instantiate from a template with placeholder values and assert expected substitutions plus strict-mode unresolved-token failure behavior. |
| G4: No live integration coverage for template-driven creation flows. | Regressions in template lifecycle and placeholder behavior may ship undetected. | Add live integration subtests for templatize, lifecycle mutation, placeholder completion, and cleanup in `test/live.integration.test.js`. | Run `npm test` in configured live environment and confirm passing UC-11 related subtests. |
| G5: Contract documentation does not expose template lifecycle operations as first-class tools. | Users and agents cannot reliably discover canonical template workflows from docs, increasing misuse and support overhead. | Update `docs/TOOL_CONTRACTS.md` and `README.md` with signatures, examples, and UC-11 flow sequence. | Verify docs include template lifecycle wrappers and placeholder pipeline examples aligned with implemented tool contracts. |

## Process checklist
1. Validate endpoint contracts and payloads in Outline Templates docs and OpenAPI:
   - https://docs.getoutline.com/s/guide/doc/templates-GP6DXgRtxl
   - https://github.com/outline/openapi/blob/main/spec3.yml
2. Implement wrapper handlers in `src/tools.js` and module splits (`src/tools.navigation.js`, `src/tools.mutation.js`) where appropriate.
3. Add arg validation entries in `src/tool-arg-schemas.js` for each new wrapper argument.
4. Add live subtests in `test/live.integration.test.js` using suite-created docs/templates only.
5. Run `npm run check`.
6. Run `npm test` with `OUTLINE_TEST_BASE_URL` and `OUTLINE_TEST_API_KEY` configured.
7. Update `docs/TOOL_CONTRACTS.md` and `README.md` so contracts/examples remain synchronized.
