# UC-08: Engineering runbooks and incident playbooks

## Scenario
- use_case_id: UC-08
- name: Engineering runbooks and incident playbooks
- primary_goal: Standardize incident response execution and post-incident learning with reusable runbook/playbook documents.
- typical_actors: on-call engineer, incident commander, service owner, SRE lead.
- core_workflow:
  1. Define runbook and incident-playbook templates for common incidents (availability, latency, dependency outage, rollback).
  2. Instantiate an incident document from a template when an alert fires.
  3. Search quickly for the right runbook by service/component/keyword during triage.
  4. Update timeline, decisions, mitigations, and ownership safely while multiple responders are editing.
  5. Use revision history for post-incident review and restore prior content when edits go wrong.

## Why this is real (source links)
- Outline Templates docs cover reusable templates for recurring documentation patterns and document standardization.
  - source: https://docs.getoutline.com/s/guide/doc/templates-GP6DXgRtxl
- Outline Search and AI answers docs describe fast retrieval across workspace knowledge, which is critical during incident triage.
  - source: https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06
- Outline Revision history docs describe revision tracking and restore, which maps directly to incident auditability and rollback needs.
  - source: https://docs.getoutline.com/s/guide/doc/revision-history-AiL6p22Ssq
- External runbook/wiki evidence: Wikimedia operates a dedicated runbook wiki for production systems and emergency procedures.
  - source: https://runbooks.wikimedia.org/wiki/Main_Page

## Current support in outline-agent
- Runbook/playbook authoring lifecycle is supported:
  - `documents.create`, `documents.update`, `documents.safe_update`
  - `documents.diff`, `documents.apply_patch`, `documents.batch_update`
- Template application is partially supported:
  - `documents.create` and `documents.update` accept `templateId` when the template ID is already known.
- Retrieval and triage support is strong:
  - `documents.search`, `documents.resolve`, `search.expand`, `search.research`
  - `documents.list`, `documents.info`, `collections.list`, `collections.info`, `collections.tree`
- Revision rollback primitives exist:
  - `revisions.list`, `revisions.restore`
- Safety and extensibility primitives exist:
  - mutating action gate via `performAction: true`
  - raw endpoint fallback via `api.call`

## Current limits/gaps in this repo
- G1: Template lifecycle is not first-class.
  - Missing wrappers for `templates.list|info|create|update|delete|restore|duplicate`.
- G2: No dedicated wrapper for converting a high-quality incident doc into a reusable template.
  - Missing wrapper for `documents.templatize`.
- G3: Revision inspection is incomplete for deterministic incident forensics.
  - `revisions.list` and `revisions.restore` exist, but `revisions.info` wrapper is missing.
- G4: Incident timeline discussion is not first-class.
  - Missing `comments.list|info|create|update|delete` wrappers for per-incident responder notes.
- G5: Live integration tests do not cover end-to-end runbook/playbook workflows.
  - `test/live.integration.test.js` validates search and basic revision operations, but not template/templatize/comments incident flows.

## Improvement proposal (specific wrappers/schema/tests/docs)
- P1: Add incident-runbook wrappers.
  - template lifecycle: `templates.list`, `templates.info`, `templates.create`, `templates.update`, `templates.delete`, `templates.restore`, `templates.duplicate`
  - template conversion: `documents.templatize`
  - revision hydration: `revisions.info`
  - incident timeline notes: `comments.list`, `comments.info`, `comments.create`, `comments.update`, `comments.delete`
- P2: Add strict arg schemas in `src/tool-arg-schemas.js`.
  - enforce required identifiers and `id` vs `ids` exclusivity where applicable
  - enforce pagination bounds + enum constraints
  - require `performAction: true` for every mutating wrapper
- P3: Add live integration coverage in `test/live.integration.test.js`.
  - flow A (template): create suite-owned incident doc -> `documents.templatize` -> `templates.info/list` -> create a new incident doc using `templateId` -> cleanup
  - flow B (incident updates + revisions): apply edits -> `revisions.list` -> `revisions.info` -> `revisions.restore`
  - flow C (incident timeline notes): `comments.create/list/update/delete` against suite-owned incident doc
- P4: Update docs.
  - `docs/TOOL_CONTRACTS.md`: add signatures/examples/best practices for new wrappers
  - `README.md`: add a deterministic UC-08 command sequence (template-first incident response + revision recovery)

## Issue resolution matrix
| Issue | Risk if unaddressed | Proposed remediation | Verification step |
| --- | --- | --- | --- |
| G1: Template lifecycle is not first-class (`templates.list|info|create|update|delete|restore|duplicate` wrappers missing). | Incident teams cannot reliably standardize or evolve runbook/playbook templates through CLI-first workflows. | Implement template lifecycle wrappers and expose deterministic output modes consistent with existing tool contracts. | Add live integration subtests that create, list, inspect, update, duplicate, restore, and delete suite-owned templates. |
| G2: No dedicated wrapper for `documents.templatize`. | High-quality incident docs are not easily promoted into reusable templates, causing repeated manual setup. | Add `documents.templatize` wrapper with explicit argument validation and mutation gating. | Add flow coverage that creates a suite-owned incident doc, templatizes it, and uses the resulting template in `documents.create` via `templateId`. |
| G3: Revision inspection is incomplete because `revisions.info` is missing. | Post-incident forensics and deterministic audit trails remain shallow when responders need full revision hydration. | Implement `revisions.info` and align schema/output with existing revision wrappers. | Extend revision flow tests to call `revisions.list`, hydrate selected entries via `revisions.info`, then verify restore behavior. |
| G4: Incident timeline discussion is not first-class (`comments.*` wrappers missing). | Responder notes and decision context become fragmented outside document-native workflows, reducing incident traceability. | Implement `comments.list|info|create|update|delete` wrappers with strict schemas and `performAction` on mutations. | Add live tests that create, list, update, and delete comments on suite-owned incident docs. |
| G5: Live integration tests do not cover full runbook/playbook workflows. | Regressions can ship in template, templatize, comment, and revision paths without deterministic detection. | Add end-to-end UC-08 test flows for template lifecycle, incident edits/revisions, and comment timeline operations. | Run `npm test` in live env and confirm dedicated UC-08 subtests pass across all newly wrapped endpoints. |

## Process checklist
1. Verify endpoint contracts in Outline developer references and OpenAPI.
   - https://www.getoutline.com/developers
   - https://github.com/outline/openapi/blob/main/spec3.yml
2. Implement wrappers in `src/tools.js` and the appropriate scenario modules (`src/tools.navigation.js`, `src/tools.mutation.js`).
3. Add/validate arg schemas in `src/tool-arg-schemas.js` for every new wrapper argument.
4. Add live subtests in `test/live.integration.test.js` using only suite-created docs/entities.
5. Run `npm run check`.
6. Run `npm test` with live test env configured.
7. Update `docs/TOOL_CONTRACTS.md` and `README.md` to keep contracts and examples synchronized.
