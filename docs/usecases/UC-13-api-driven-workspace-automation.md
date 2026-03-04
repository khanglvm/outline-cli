# UC-13: API-driven workspace automation

## Scenario
- use_case_id: UC-13
- name: API-driven workspace automation
- primary_goal: Automate workspace operations (identity lifecycle, access provisioning, sharing governance, and audit reporting) using deterministic CLI contracts over the Outline API.
- typical_actors: platform engineer, IT admin, security/compliance analyst, developer productivity engineer, AI automation agent.
- core_workflow:
  1. Discover workspace state (users, groups, collections, memberships, shares, recent events).
  2. Plan desired changes from external systems (HRIS/IdP/ticketing) as an explicit diff.
  3. Execute approved mutations with hard action gates and idempotent semantics.
  4. Verify post-conditions (membership/share state + event trail evidence).
  5. Produce machine-readable run output for scheduled jobs and compliance logs.

## Why this is real (source links)
- Outline’s API guide positions the API as first-class for programmatic control (same surface used by the app), with API key/OAuth auth, scopes, pagination, and rate-limit behavior.
  - source: https://docs.getoutline.com/guide/doc/api
  - source: https://github.com/outline/openapi/blob/main/spec3.yml#L6
  - source: https://github.com/outline/openapi/blob/main/spec3.yml#L53
  - source: https://github.com/outline/openapi/blob/main/spec3.yml#L87
  - source: https://github.com/outline/openapi/blob/main/spec3.yml#L127
  - source: https://github.com/outline/openapi/blob/main/spec3.yml#L148
- OpenAPI exposes workspace-admin automation primitives beyond document editing, including users, groups, memberships, shares, and events.
  - users lifecycle: https://github.com/outline/openapi/blob/main/spec3.yml#L4755
  - groups lifecycle: https://github.com/outline/openapi/blob/main/spec3.yml#L3528
  - collection memberships: https://github.com/outline/openapi/blob/main/spec3.yml#L815
  - document memberships: https://github.com/outline/openapi/blob/main/spec3.yml#L2826
  - shares lifecycle: https://github.com/outline/openapi/blob/main/spec3.yml#L4368
  - event/audit feed: https://github.com/outline/openapi/blob/main/spec3.yml#L3313
- This repository already treats tool contracts as a primary automation interface (`tools contract all` + checked-in contracts doc), confirming contract-driven workflows are an explicit design target.
  - source: ../TOOL_CONTRACTS.md
  - source: ../../README.md

## Current support in outline-agent
- Strong first-class support exists for document-centric automation:
  - discovery/navigation: `documents.search`, `documents.resolve`, `search.expand`, `search.research`, `documents.list`, `documents.info`, `collections.list`, `collections.info`, `collections.tree`.
  - mutation/revision safety: `documents.update`, `documents.safe_update`, `documents.diff`, `documents.apply_patch`, `documents.batch_update`, `documents.plan_batch_update`, `documents.apply_batch_plan`, `documents.delete`, `revisions.list`, `revisions.restore`.
- Platform-oriented support exists but is limited:
  - `capabilities.map` and `documents.cleanup_test`.
- Raw escape hatch exists:
  - `api.call` can invoke uncovered RPC methods while preserving machine-readable envelopes.
- Safety guardrails already exist:
  - explicit `performAction: true` for wrapped mutators.
  - read-token delete safety flow for document deletion.

## Current limits/gaps in this repo
- G1: Missing first-class wrappers for core workspace-admin APIs needed by automation.
  - No dedicated tools for `users.*`, `groups.*`, `collections.memberships*`, `documents.memberships*`, `shares.*`, `events.list`, `fileOperations.*`.
- G2: `api.call` mutation gating has blind spots for workspace operations.
  - Current mutator detection is regex-based and does not explicitly catch verbs like `invite`, `add_user`, `suspend`, `activate`, `revoke` unless another token incidentally matches.
  - source: ../../src/action-gate.js
- G3: No schema-level contracts for workspace lifecycle arguments.
  - Without wrappers, critical shapes/enums (invites array, roles, permissions, membership filters) are not validated by `tool-arg-schemas`.
  - source: ../../src/tool-arg-schemas.js
- G4: Live integration coverage is document-heavy and does not validate workspace automation flows.
  - Current live suite exercises document/search/revision/delete safety paths but not users/groups/shares/events lifecycle flows.
  - source: ../../test/live.integration.test.js
- G5 (inference from source comparison): OpenAPI publishes a much larger RPC surface than the current CLI contract set.
  - Practical impact: agents must use raw `api.call` for many high-value automation steps, reducing determinism and increasing operator error risk.

## Improvement proposal (specific wrappers/schema/tests/docs)
- P1: Add first-class workspace wrappers (read side first).
  - `users.list`, `users.info`
  - `groups.list`, `groups.info`, `groups.memberships`
  - `collections.memberships`, `collections.group_memberships`
  - `documents.users`, `documents.memberships`, `documents.group_memberships`
  - `shares.list`, `shares.info`
  - `events.list`
  - `file_operations.list`, `file_operations.info`
- P2: Add first-class workspace wrappers (mutation side, action-gated).
  - `users.invite`, `users.update_role`, `users.suspend`, `users.activate`
  - `groups.create`, `groups.update`, `groups.delete`, `groups.add_user`, `groups.remove_user`
  - `collections.add_user`, `collections.remove_user`, `collections.add_group`, `collections.remove_group`
  - `documents.add_user`, `documents.remove_user`, `documents.add_group`, `documents.remove_group`
  - `shares.create`, `shares.update`, `shares.revoke`
  - `file_operations.delete`
- P3: Add explicit access-sync orchestration wrappers for deterministic automation runs.
  - `workspace.plan_access_sync(args: { desiredUsers?: ...; desiredGroups?: ...; desiredCollectionMemberships?: ...; desiredDocumentMemberships?: ...; })`
  - `workspace.apply_access_plan(args: { plan: object; confirmHash: string; dryRun?: boolean; continueOnError?: boolean; performAction?: boolean })`
  - behavior: mirror the existing `plan_batch_update/apply_batch_plan` safety pattern for workspace-level ACL changes.
- P4: Expand arg schema coverage in `src/tool-arg-schemas.js`.
  - enforce required IDs and enum constraints (`Permission`, `UserRole`, user filters).
  - validate invite payload shape (`invites[]` non-empty, email/name typing).
  - validate mutually exclusive fields where applicable (`id` vs alternate selectors).
  - require `performAction: true` for all mutating workspace wrappers.
- P5: Harden action gate classification.
  - Replace broad regex heuristic with explicit method-family rules (or broaden regex with `invite|add_|remove_|suspend|activate|revoke|rotate`).
  - Ensure `api.call` enforces action-gating for these mutating workspace methods.
- P6: Add live integration tests in `test/live.integration.test.js`.
  - read-only tests: `users.list`, `groups.list`, `events.list`, `shares.list` (shape/pagination validation).
  - gating tests: every new mutator rejects when `performAction` is absent.
  - safe mutation tests behind explicit env guard + fixture IDs (for sandbox workspaces only), with mandatory cleanup.
- P7: Update docs.
  - `docs/TOOL_CONTRACTS.md`: add signatures/examples for all new wrappers.
  - `README.md`: add “workspace automation” playbook with plan/apply/gating flow.
  - keep this UC-13 doc as the scenario anchor.

## Process checklist
1. Rebuild and review current contract inventory:
   - `node ./bin/outline-agent.js tools contract all --result-mode inline`
2. Validate target endpoint payloads/constraints in Outline API guide + OpenAPI before implementation.
3. Implement wrapper handlers in `src/tools.js` plus `src/tools.navigation.js` / `src/tools.mutation.js` splits.
4. Add/update corresponding arg schemas in `src/tool-arg-schemas.js`.
5. Extend action gating in `src/action-gate.js` for workspace mutator verbs/methods.
6. Add live tests in `test/live.integration.test.js` (read-only baseline + guarded mutation fixtures).
7. Run `npm run check` and `npm test`, then sync docs (`README.md`, `docs/TOOL_CONTRACTS.md`).
