# UC-02: Team wiki for SOPs and policy pages

## Scenario
- use_case_id: UC-02
- name: Team wiki for SOPs and policy pages
- primary_goal: Keep SOPs and policies centralized, searchable, permission-aware, and easy to update.
- typical_actors: workspace admin, functional owners (HR/IT/SecOps), contributors, readers.
- core_workflow:
  1. Create/organize collections for policy domains.
  2. Create/update policy documents from consistent templates.
  3. Grant access by role/group.
  4. Search and review policies by collection and topic.
  5. Roll out policy text updates safely across multiple pages.

## Why this is real (with source links)
- Outline positions collections as primary organization and permission boundaries for docs: [Collections](https://docs.getoutline.com/s/guide/doc/collections-l9o3LD22sV).
- Outline documents explicit workspace roles (`admin`, `member`, `viewer`, `guest`) used in policy access governance: [Users and roles](https://docs.getoutline.com/s/guide/doc/users-groups-cwCxXP8R3V).
- Outline groups are a first-class way to manage people in sets for access control at scale: [Groups](https://docs.getoutline.com/s/guide/doc/groups-Jy1rROTFmN).
- Policy communication often requires controlled sharing/publication paths supported by share links: [Sharing](https://docs.getoutline.com/s/guide/doc/sharing-LG2sGOLIpl).
- Outline exposes these capabilities via API/OpenAPI, enabling automation for wiki lifecycle operations: [API guide](https://docs.getoutline.com/s/guide/doc/api-1rEIXDfLF6), [Developer API reference](https://www.getoutline.com/developers).

## Current support in outline-agent (tools that help)
- Collection discovery and structure:
  - `collections.list`, `collections.info`, `collections.tree`.
- SOP/policy page lifecycle:
  - `documents.list`, `documents.search`, `documents.resolve`, `documents.info`, `documents.create`, `documents.update`.
- Safe bulk maintenance for policy wording changes:
  - `documents.diff`, `documents.apply_patch`, `documents.plan_batch_update`, `documents.apply_batch_plan`, `documents.batch_update`, `documents.safe_update`.
- Safety controls:
  - mutating tools are action-gated with `performAction: true`; delete flow requires `documents.info(armDelete=true)` read token before `documents.delete`.
- Escape hatch for non-wrapped endpoints:
  - `api.call` can invoke raw Outline API methods when wrappers are missing.

## Current limits/gaps in this repo
- G1: Missing first-class wrappers for people/group governance methods used in wiki permissions:
  - no `users.*` tool wrappers.
  - no `groups.*` tool wrappers.
  - no `collections.add_user/remove_user/memberships` wrappers.
  - no `collections.add_group/remove_group/group_memberships` wrappers.
- G2: Missing first-class wrappers for policy distribution/reuse helpers:
  - no `shares.*` wrappers.
  - no `templates.list/info/update` wrappers (only `templateId` passthrough on document create/update).
- G3: Schema and UX gap:
  - these flows currently require `api.call` with raw method/body, reducing deterministic arg validation and discoverability.
- G4: Test coverage gap:
  - live integration tests currently validate documents/collections flows but not users/groups/membership/share/template wrappers.

## Improvement proposal (concrete: tool wrappers/schema/tests/docs)
- Tool wrappers (phase 1: read + planning):
  - add `users.list`, `users.info`.
  - add `groups.list`, `groups.info`, `groups.memberships`.
  - add `collections.memberships`, `collections.group_memberships`.
  - add `shares.list`, `shares.info`.
  - add `templates.list`, `templates.info`.
- Tool wrappers (phase 2: guarded writes):
  - add `groups.create/update/delete`, `groups.add_user/remove_user`.
  - add `collections.add_user/remove_user`, `collections.add_group/remove_group`.
  - add `shares.create/update/revoke`.
  - add `templates.create/update/delete/duplicate/restore` as needed.
  - enforce `performAction: true` on all mutating wrappers.
- Schema updates (`src/tool-arg-schemas.js`):
  - add explicit schemas for each new tool arg set with required IDs, pagination, and `view` controls.
  - add custom validation for mutually exclusive args (`id` vs `ids`) and bounded batch concurrency.
- Tests (`test/live.integration.test.js`):
  - add read-only subtests for list/info/memberships wrappers.
  - for mutating team-level wrappers, use explicit opt-in env flag and strict create-then-cleanup pattern on suite-created entities only.
  - keep existing deterministic envelope assertions (`tool`, `ok`, `result`) and result-mode compatibility checks.
- Docs:
  - update `docs/TOOL_CONTRACTS.md` signatures/examples for all new wrappers.
  - update `README.md` with governance-oriented examples for SOP/policy wiki operations.

## Issue resolution matrix
| Issue | Risk if unaddressed | Proposed remediation | Verification step |
| --- | --- | --- | --- |
| G1: Missing first-class wrappers for people/group governance methods used in wiki permissions | Permission governance remains dependent on raw calls, increasing access-control mistakes and reducing workflow consistency. | Add `users.*`, `groups.*`, and collection membership wrappers with explicit action-gating on mutating methods. | Add live integration subtests for list/info/memberships wrappers and confirm stable `tool/ok/result` envelopes. |
| G2: Missing first-class wrappers for policy distribution/reuse helpers | Share and template workflows stay ad hoc, making policy rollout and reuse less repeatable. | Add `shares.*` and `templates.*` wrappers in phased read-first then guarded-write rollout. | Validate new tool signatures in `docs/TOOL_CONTRACTS.md` and cover list/info plus selected write operations in live tests. |
| G3: Schema and UX gap | Deterministic arg validation and discoverability degrade when operators must craft raw API payloads manually. | Add explicit arg schemas for all new wrappers, including bounded pagination and exclusivity validation (`id` vs `ids`). | Run `npm run check` to validate schemas, then verify invalid inputs fail with deterministic validation errors. |
| G4: Test coverage gap | Regressions in wrappers can ship unnoticed, especially around permissions, memberships, sharing, and templates. | Expand `test/live.integration.test.js` with wrapper-focused subtests and cleanup-safe mutation coverage under opt-in flags. | Run `npm test` and confirm wrapper scenarios pass with create-then-cleanup behavior for suite-created entities only. |

## Process checklist
- [ ] Confirm target methods against Outline OpenAPI at `https://www.getoutline.com/developers`.
- [ ] Implement wrapper handlers and registration in `src/tools.js` / related tool modules.
- [ ] Add arg schema entries and validation in `src/tool-arg-schemas.js`.
- [ ] Add/adjust live integration tests in `test/live.integration.test.js`.
- [ ] Run `npm run check`.
- [ ] Run `npm test` (live environment configured).
- [ ] Update `docs/TOOL_CONTRACTS.md` and `README.md` when signatures/behavior change.
