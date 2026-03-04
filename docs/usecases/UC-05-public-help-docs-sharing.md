# UC-05: Public help page/docs landing via shared links

## Scenario
- use_case_id: UC-05
- name: Public help page/docs landing via shared links
- primary_goal: Publish customer-facing help docs from Outline using shared links, with controlled publish/revoke operations.
- typical_actors: docs owner, support lead, product marketing owner, external readers.
- core_workflow:
  1. Create a help/docs landing page with child documentation pages.
  2. Publish via share link and set a memorable `/s/...` path when needed.
  3. Validate public read access from share context.
  4. Keep content updated without breaking public link distribution.
  5. Revoke or disable sharing quickly when required.

## Why this is real (source links)
- Outline Sharing docs state that documents and collections can be published to the public web, and child documents are included in the share scope.
  - source: https://docs.getoutline.com/s/guide/doc/sharing-LG2sGOLIpl
- Outline Sharing docs explicitly call out custom `/s/...` links as useful for publishing help pages and documentation.
  - source: https://docs.getoutline.com/s/guide/doc/sharing-LG2sGOLIpl
- Outline Sharing docs also document that admins can disable sharing at workspace or collection level.
  - source: https://docs.getoutline.com/s/guide/doc/sharing-LG2sGOLIpl
- Public help/knowledge-base landing pages are a common pattern: Atlassian operates a public “Atlassian knowledge base” landing page for support articles.
  - source: https://support.atlassian.com/atlassian-knowledge-base/kb/
- Another public-docs precedent: Notion’s publishing guide lists company handbooks and knowledge bases as common public page use cases.
  - source: https://www.notion.com/help/guides/publish-notion-pages-to-the-web

## Current support in outline-agent
- Share-context document read is already supported: `documents.info` accepts `shareId`.
- Share-context filtering is already supported in current implementation/schema: `documents.search` accepts `shareId`.
- Public-doc lifecycle primitives exist: `documents.list`, `documents.resolve`, `documents.info`, `documents.update`, `documents.safe_update`, `documents.diff`, `documents.apply_patch`.
- Collection-level sharing flags are exposed via wrappers: `collections.create` / `collections.update` (`sharing` arg).
- Raw fallback exists for non-wrapped endpoints: `api.call`.

## Current limits/gaps in this repo
- G1: No dedicated `shares.*` wrappers (`shares.info`, `shares.list`, `shares.create`, `shares.update`, `shares.revoke`).
  - source: https://github.com/outline/openapi/blob/main/spec3.yml
- G2: Share lifecycle automation currently requires generic `api.call`, which reduces deterministic tool discoverability and schema enforcement.
- G3: No first-class share lifecycle tests in `test/live.integration.test.js`.
- G4: No public-docs-sharing playbook in docs contracts/README despite this being a common deployment path.

## Improvement proposal (specific wrappers/schema/tests/docs)
- Wrappers:
  - add `shares.info`, `shares.list` (read operations).
  - add `shares.create`, `shares.update`, `shares.revoke` (mutations, action-gated).
  - keep existing response envelope shape (`tool`, `profile`, `result`) for compatibility.
- Schema (`src/tool-arg-schemas.js`):
  - `shares.info`: require one of `id` or `documentId`.
  - `shares.list`: validate `limit`, `offset`, `sort`, `direction`, optional `query`.
  - `shares.create`: require `documentId`.
  - `shares.update`: require `id` and `published`.
  - `shares.revoke`: require `id`; require `performAction=true`.
- Tests (`test/live.integration.test.js`):
  - create suite-owned test document.
  - create share -> publish share -> read via `documents.info({ shareId })`.
  - run share-scoped search/read assertions.
  - revoke share and assert access failure, then cleanup.
- Docs:
  - update `docs/TOOL_CONTRACTS.md` with `shares.*` signatures/examples.
  - update `README.md` with a deterministic public-help-docs sharing flow.

## Issue resolution matrix
| Issue | Risk if unaddressed | Proposed remediation | Verification step |
| --- | --- | --- | --- |
| G1: No dedicated `shares.*` wrappers (`shares.info`, `shares.list`, `shares.create`, `shares.update`, `shares.revoke`). | Share operations stay fragmented behind generic calls, lowering contract clarity and agent discoverability. | Add dedicated `shares.*` wrappers with stable `tool/profile/result` envelopes. | Run `tools contract all` and confirm all `shares.*` tools are listed with expected signatures. |
| G2: Share lifecycle automation currently requires generic `api.call`, which reduces deterministic tool discoverability and schema enforcement. | Invalid or inconsistent arguments can reach runtime and reduce deterministic behavior in automation. | Add strict `shares.*` argument schemas in `src/tool-arg-schemas.js` and route share lifecycle through typed wrappers. | Execute invalid-arg and valid-arg calls to verify schema rejection/acceptance behavior for each `shares.*` tool. |
| G3: No first-class share lifecycle tests in `test/live.integration.test.js`. | Regressions in create/publish/read/revoke flows can ship without detection. | Add live integration subtests that create a suite-owned doc, exercise share lifecycle, and clean up. | Run `npm test` and confirm the share lifecycle subtests pass end-to-end. |
| G4: No public-docs-sharing playbook in docs contracts/README despite this being a common deployment path. | Users lack a deterministic reference flow, increasing misuse and support overhead. | Document the public help docs sharing flow in `docs/TOOL_CONTRACTS.md` and `README.md` with examples. | Review docs output to confirm `shares.*` usage and flow steps are documented consistently. |

## Process checklist
1. Verify share endpoint contracts against Outline Sharing docs and OpenAPI.
2. Implement `shares.*` wrappers and register contracts.
3. Add strict arg schemas for all new share wrappers.
4. Add live integration subtests using suite-created docs only.
5. Update `docs/TOOL_CONTRACTS.md` and `README.md`.
6. Run `npm run check` and `npm test`.
