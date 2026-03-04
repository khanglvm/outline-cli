# UC-06: Department spaces with role-based visibility

## Scenario
- use_case_id: UC-06
- name: Department spaces with role-based visibility
- primary_goal: Keep each department’s knowledge space visible only to the right people while preserving discoverability and governance.
- typical_actors: workspace admin, department lead, department member, cross-functional stakeholder.
- core_workflow:
  1. Create department collections (HR, Finance, Engineering, Legal).
  2. Map people to roles and groups.
  3. Grant collection visibility by group/user membership.
  4. Validate who can see what before and after access changes.
  5. Audit and maintain access over time as org membership changes.

## Why this is real (source links)
- Outline Collections are the main structure for organizing docs and controlling access boundaries at the collection level.
  - source: https://docs.getoutline.com/s/guide/doc/collections-l9o3LD22sV
- Outline Users and roles document explicit workspace role types (`admin`, `member`, `viewer`, `guest`) used in visibility governance.
  - source: https://docs.getoutline.com/s/guide/doc/users-groups-cwCxXP8R3V
- Outline Groups are the scalable mechanism for assigning permissions to sets of users instead of one-by-one updates.
  - source: https://docs.getoutline.com/s/guide/doc/groups-Jy1rROTFmN
- Outline API/OpenAPI exposes collection/group/user membership endpoints needed to automate this pattern.
  - sources:
    - https://docs.getoutline.com/s/guide/doc/api-1rEIXDfLF6
    - https://github.com/outline/openapi/blob/main/spec3.yml

## Current support in outline-agent
- Available wrappers help with structure/document lifecycle, but not department-access administration:
  - collections: `collections.list`, `collections.info`, `collections.tree`, `collections.create`, `collections.update`
  - documents/search: `documents.list`, `documents.info`, `documents.search`, `documents.resolve`, `search.expand`, `search.research`
  - mutation safety/revisions: `documents.update`, `documents.safe_update`, `documents.diff`, `documents.apply_patch`, `documents.plan_batch_update`, `documents.apply_batch_plan`, `documents.batch_update`, `documents.delete`, `revisions.list`, `revisions.restore`
  - platform/auth: `auth.info`, `capabilities.map`
  - escape hatch: `api.call` for non-wrapped endpoints
- Net: the repo can organize department spaces and edit content safely, but role/group visibility control is mostly indirect through `api.call`.

## Current limits/gaps in this repo
- No first-class `users.*` wrappers for role-aware administration (for example, `users.list`, `users.info`, `users.update_role`).
- No first-class `groups.*` wrappers (`groups.list/info/create/update/delete/memberships/add_user/remove_user`).
- No first-class collection membership wrappers:
  - `collections.memberships`, `collections.group_memberships`
  - `collections.add_user`, `collections.remove_user`, `collections.add_group`, `collections.remove_group`
- Related document-level access wrappers are also missing (`documents.memberships`, `documents.group_memberships`, `documents.add_user/remove_user/add_group/remove_group`) for exceptions under department spaces.
- `src/tool-arg-schemas.js` has no dedicated schemas for the missing users/groups/membership surfaces.
- `test/live.integration.test.js` has no live coverage for role/group/membership visibility workflows.
- `docs/TOOL_CONTRACTS.md` and `README.md` currently do not provide a role-based department-space playbook using first-class wrappers.

## Improvement proposal (specific wrappers/schema/tests/docs)
- Wrappers (read-first):
  - users: `users.list`, `users.info`
  - groups: `groups.list`, `groups.info`, `groups.memberships`
  - collection visibility: `collections.memberships`, `collections.group_memberships`
- Wrappers (guarded writes with `performAction: true`):
  - groups: `groups.create`, `groups.update`, `groups.delete`, `groups.add_user`, `groups.remove_user`
  - collection visibility: `collections.add_user`, `collections.remove_user`, `collections.add_group`, `collections.remove_group`
  - optional role admin wrapper: `users.update_role` (strictly gated, explicit role enum)
- Schema updates (`src/tool-arg-schemas.js`):
  - add explicit schemas for every new wrapper with required IDs, pagination bounds, and role enum validation.
  - enforce mutually exclusive arg rules where applicable (`id` vs `ids`).
  - enforce `performAction: true` on all mutating wrappers.
- Tests (`test/live.integration.test.js`):
  - add read subtests for `users.list/info`, `groups.list/info/memberships`, `collections.memberships/group_memberships`.
  - add guarded mutation subtests on suite-created entities only:
    - create isolated collection as department space
    - create group
    - add/remove group to collection
    - add/remove user to group/collection
    - verify access/membership deltas via info/list wrappers
    - cleanup all created entities
  - keep destructive/tenant-sensitive paths behind explicit env opt-in when needed.
- Docs:
  - `docs/TOOL_CONTRACTS.md`: add signatures/examples/best practices for all new wrappers.
  - `README.md`: add deterministic “department spaces” sequence (discover -> grant -> verify -> audit).

## Process checklist
1. Confirm endpoint contracts against Outline API docs/OpenAPI (`collections.*`, `users.*`, `groups.*`).
2. Implement wrapper handlers and registration (`src/tools.js` + relevant module files).
3. Add arg validation for each wrapper in `src/tool-arg-schemas.js`.
4. Add live integration subtests for membership/role/group flows in `test/live.integration.test.js`.
5. Run `npm run check`.
6. Run `npm test` (live env configured).
7. Update `docs/TOOL_CONTRACTS.md` and `README.md` to match shipped contracts.
