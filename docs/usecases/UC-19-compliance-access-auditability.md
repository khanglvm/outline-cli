# UC-19: Compliance operations (access model + scoped API keys + auditability)

## Scenario
- use_case_id: UC-19
- name: Compliance operations (access model + scoped API keys + auditability)
- primary_goal: Prove and operate least-privilege access, scoped API credentials, and defensible change/activity evidence from Outline via deterministic CLI contracts.
- typical_actors: security/compliance lead, IAM engineer, platform admin, internal auditor, GRC automation agent.
- core_workflow:
  1. Inventory current access model (users, roles, groups, collection/document memberships).
  2. Validate API credential posture (auth mode, OAuth client scope, active authentications, revocation readiness).
  3. Execute approved access/key mutations with explicit action gates.
  4. Collect audit evidence (events + revision history + mutation receipts).
  5. Generate machine-readable compliance artifacts for ticketing/audit systems.

## Why this is real (source links)
- Outline’s user/role and group model is explicit and central to workspace access governance.
  - sources:
    - https://docs.getoutline.com/s/guide/doc/users-groups-cwCxXP8R3V
    - https://docs.getoutline.com/s/guide/doc/groups-Jy1rROTFmN
- Outline API docs position API usage, auth, and integration as first-class administrative workflows.
  - source: https://docs.getoutline.com/guide/doc/api
- Outline documents revision history as a core traceability/recovery mechanism needed for compliance evidence.
  - source: https://docs.getoutline.com/s/guide/doc/revision-history-AiL6p22Ssq
- OpenAPI explicitly defines access/scope/audit surfaces needed for this scenario:
  - API key + scope model in spec intro (`API key`, `Scopes`):
    - https://github.com/outline/openapi/blob/main/spec3.yml#L53
    - https://github.com/outline/openapi/blob/main/spec3.yml#L85
  - Access/admin endpoints:
    - `auth.info`: https://github.com/outline/openapi/blob/main/spec3.yml#L404
    - `collections.memberships`: https://github.com/outline/openapi/blob/main/spec3.yml#L815
    - `users.list` / `users.info` / `users.invite`: https://github.com/outline/openapi/blob/main/spec3.yml#L4755
  - Scoped auth lifecycle endpoints:
    - `oauthClients.*`: https://github.com/outline/openapi/blob/main/spec3.yml#L3917
    - `oauthAuthentications.list/delete`: https://github.com/outline/openapi/blob/main/spec3.yml#L4210
  - Audit/history endpoints:
    - `events.list` (`auditLog` support): https://github.com/outline/openapi/blob/main/spec3.yml#L3313
    - `revisions.info` / `revisions.list`: https://github.com/outline/openapi/blob/main/spec3.yml#L4291

## Current support in outline-agent
- Access/capability baseline exists:
  - `auth.info` and `capabilities.map` already expose identity, role, probe-based capability inference, and optional policy evidence.
  - sources:
    - [src/tools.js](../../src/tools.js)
    - [src/tools.platform.js](../../src/tools.platform.js)
    - [docs/TOOL_CONTRACTS.md](../TOOL_CONTRACTS.md)
- Mutation safety/audit primitives exist:
  - action gating via `performAction: true`.
  - safe delete handshake (`documents.info armDelete` -> `documents.delete readToken`).
  - revision operations: `revisions.list`, `revisions.restore`.
  - sources:
    - [src/action-gate.js](../../src/action-gate.js)
    - [src/tools.mutation.js](../../src/tools.mutation.js)
    - [README.md](../../README.md)
- Raw endpoint escape hatch exists:
  - `api.call` can reach uncovered OpenAPI methods while preserving machine-readable envelopes.
  - source: [src/tools.js](../../src/tools.js)

## Current limits/gaps in this repo
- G1: No first-class wrappers for core access-model administration.
  - Missing `users.*`, `groups.*`, and membership wrappers needed for deterministic compliance automation.
- G2: No first-class wrappers for scoped API credential lifecycle.
  - `oauthClients.*` and `oauthAuthentications.*` are only reachable via generic `api.call`.
- G3: No first-class audit-feed wrapper.
  - `events.list` (including `auditLog` filtering) is not wrapped despite being compliance-critical.
- G4: Revision evidence is partial.
  - `revisions.list`/`restore` exist, but `revisions.info` is missing for deterministic single-revision hydration.
- G5: `api.call` delete-read-token logic is over-broad.
  - It treats any `.delete` method as document-delete gated, which mismatches non-document compliance endpoints (for example `oauthClients.delete`, `oauthAuthentications.delete`).
  - source: [src/action-gate.js](../../src/action-gate.js)
- G6: Validation/test/docs coverage is document-centric.
  - `src/tool-arg-schemas.js`, `test/live.integration.test.js`, and contracts/readme do not yet cover end-to-end compliance access + key + audit flows.

## Improvement proposal (specific wrappers/schema/tests/docs)
- Wrappers (`src/tools.platform.js` + tool registration):
  - Access model (read): `users.list`, `users.info`, `groups.list`, `groups.info`, `groups.memberships`, `collections.memberships`, `collections.group_memberships`.
  - Access model (mutate, action-gated): `users.invite`, `users.suspend`, `users.activate`, `groups.add_user`, `groups.remove_user`, `collections.add_user`, `collections.remove_user`, `collections.add_group`, `collections.remove_group`.
  - Scoped credential lifecycle: `oauth_clients.list`, `oauth_clients.info`, `oauth_clients.create`, `oauth_clients.update`, `oauth_clients.rotate_secret`, `oauth_clients.delete`, `oauth_authentications.list`, `oauth_authentications.delete`.
  - Audit/history: `events.list` (including `auditLog`, actor/document/collection filters), `revisions.info`.
- Schema (`src/tool-arg-schemas.js`):
  - Add strict arg schemas for every new wrapper (required IDs, pagination bounds, enums, non-empty arrays).
  - Validate OAuth client payloads (`name`, `redirectUris[]`, optional metadata) and auth-revoke payloads (`oauthClientId`, optional scope array).
  - Enforce `performAction: true` for all mutating wrappers.
  - Scope delete-read-token requirements to `documents.delete` / `documents.permanent_delete` only; do not require doc read tokens for unrelated `*.delete` methods.
- Tests (`test/live.integration.test.js`):
  - Read-only compliance coverage: `users.list/info`, `groups.list/info/memberships`, `collections.memberships`, `events.list` (`auditLog: true`), `revisions.info`.
  - Gating coverage: assert each new mutator fails without `performAction=true`.
  - Safe mutation coverage (env-gated): create/update/rotate/delete OAuth client fixture, validate response envelopes and cleanup.
  - Regression: verify non-document delete via `api.call` is not blocked by document read-token gate.
- Docs:
  - Update `docs/TOOL_CONTRACTS.md` with signatures/examples/AI best practices for new compliance wrappers.
  - Update `README.md` with a compliance runbook (`discover access` -> `review scoped creds` -> `dry-run checks` -> `execute gated mutations` -> `collect audit bundle`).
  - Keep this UC-19 file as scenario anchor.

## Process checklist
1. Reconfirm endpoint contracts in Outline API docs and OpenAPI (`users.*`, `groups.*`, `collections.*memberships*`, `oauthClients.*`, `oauthAuthentications.*`, `events.list`, `revisions.info`).
2. Implement first-class wrappers and register contracts in tool metadata.
3. Add strict arg schemas for all new wrappers and mutation gates.
4. Narrow delete read-token enforcement to document-delete methods only.
5. Add live integration subtests (read-only first, then env-gated mutations with cleanup).
6. Run `npm run check`.
7. Run `npm test` (live env configured).
8. Sync `docs/TOOL_CONTRACTS.md` and `README.md` to shipped behavior.
