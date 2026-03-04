# UC-03: Meeting notes and decision logs

## Scenario
- use_case_id: UC-03
- name: Meeting notes and decision logs
- primary_goal: Capture recurring meeting notes, record decisions with ownership, and retrieve outcomes quickly.
- typical_actors: facilitator, team lead, contributor, stakeholder.
- core_workflow:
  1. Start meeting notes from a repeatable template.
  2. Capture agenda, key discussion points, decisions, owners, and due dates.
  3. Search historical decisions by topic/team/project.
  4. Review revision history when decisions are edited.
  5. Restore prior revisions when an edit introduces errors.

## Why this is real (source links)
- Outline supports reusable templates for repeatable documentation workflows:
  - https://docs.getoutline.com/s/guide/doc/templates-GP6DXgRtxl
- Outline terminology explicitly calls out templates for recurring formats such as meeting notes:
  - https://docs.getoutline.com/s/guide/doc/terminology-5M71wRBwAl
- Outline provides document revision history and restore controls for auditability:
  - https://docs.getoutline.com/s/guide/doc/revision-history-AiL6p22Ssq
- Outline provides search and AI answers to find knowledge across documents:
  - https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06
- External use-case evidence: teams commonly maintain decision logs as a dedicated artifact:
  - https://www.atlassian.com/software/confluence/templates/decision-log

## Current support in outline-agent
- Note capture/edit lifecycle:
  - `documents.create`, `documents.update`, `documents.safe_update`
  - `documents.diff`, `documents.apply_patch`, `documents.batch_update`
- Retrieval/discovery for decisions:
  - `documents.search`, `documents.resolve`
  - `search.expand`, `search.research`
- Structure and context navigation:
  - `collections.list`, `collections.info`, `collections.tree`
  - `documents.list`, `documents.info`
- Decision audit/rollback:
  - `revisions.list`, `revisions.restore`
- Controlled mutation safety:
  - `performAction: true` gate for mutating tools
  - delete read-receipt handshake (`documents.info armDelete` -> `documents.delete readToken`)
- Escape hatch for missing wrappers:
  - `api.call`

## Current limits/gaps in this repo
- G1: Template lifecycle is not first-class.
  - Missing wrappers for `templates.create|list|info|update|delete|restore|duplicate`.
- G2: No dedicated wrapper for turning an existing meeting-note doc into a reusable template.
  - Missing wrapper for `documents.templatize`.
- G3: Revision inspection is partial.
  - `revisions.list` and `revisions.restore` exist, but no `revisions.info` wrapper for deterministic single-revision hydration.
- G4: Decision discussion context is not first-class.
  - Missing `comments.create|info|list|update|delete` wrappers for per-note decision rationale threads.
- G5: Live integration coverage is missing for template + comment workflows.
  - `test/live.integration.test.js` covers search/batch/revision basics, but not template/templatize/comment flows.

## Improvement proposal (specific wrappers/schema/tests/docs)
- P1: Add wrappers for meeting-notes and decision-log lifecycle.
  - templates: `templates.create`, `templates.list`, `templates.info`, `templates.update`, `templates.delete`, `templates.restore`, `templates.duplicate`
  - document templating: `documents.templatize`
  - revision detail: `revisions.info`
  - decision discussion: `comments.create`, `comments.info`, `comments.list`, `comments.update`, `comments.delete`
- P2: Add arg schemas in `src/tool-arg-schemas.js` for every new wrapper.
  - enforce required IDs and mutually exclusive args (`id` vs `ids` where relevant)
  - enforce enum constraints and pagination bounds
  - enforce `performAction: true` on every mutating wrapper
- P3: Add live integration subtests in `test/live.integration.test.js`.
  - flow A (template): create doc -> `documents.templatize` -> `templates.info/list` -> instantiate via `documents.create(templateId)` -> cleanup
  - flow B (decision log edits): update doc -> `revisions.list` -> `revisions.info` -> `revisions.restore`
  - flow C (decision rationale): `comments.create/list/update/delete` on suite-created test doc
- P4: Update docs.
  - `docs/TOOL_CONTRACTS.md`: signatures/examples/best-practice notes for all new wrappers
  - `README.md`: concise UC-03 command sequence (template-first notes, decision search, revision recovery)

## Process checklist
1. Confirm API methods and payload shapes against Outline developer references:
   - https://www.getoutline.com/developers
   - https://github.com/outline/openapi/blob/main/spec3.yml
2. Implement wrappers in `src/tools.js` and scenario modules (`src/tools.navigation.js`, `src/tools.mutation.js`) as appropriate.
3. Add/validate schemas in `src/tool-arg-schemas.js`.
4. Add live tests in `test/live.integration.test.js` with strict create-and-cleanup of suite-created docs.
5. Run `npm run check`.
6. Run `npm test` (live env configured).
7. Update `docs/TOOL_CONTRACTS.md` and `README.md` when signatures/behavior change.
