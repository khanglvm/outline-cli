# UC-14: Event-driven workflows via webhooks

## Scenario
- use_case_id: UC-14
- name: Event-driven workflows via webhooks
- primary_goal: Trigger external automations from Outline changes (create/update/archive/delete events) with deterministic, auditable execution.
- typical_actors: platform engineer, DevOps/SRE, security engineer, internal tooling engineer, AI automation agent.
- core_workflow:
  1. Register one or more webhook subscriptions for target event types.
  2. Receive signed webhook POST payloads in an automation endpoint.
  3. Verify signature, deduplicate, and enqueue downstream jobs (ticketing, sync, notifications, policy checks).
  4. Run idempotent processors that read/update Outline data as needed.
  5. Monitor failures and reconcile missed events with API reads.

## Why this is real (source links)
- Outline documents a dedicated webhook system that sends JSON payloads to external endpoints when subscribed events occur.
  - source: https://docs.getoutline.com/s/guide/doc/webhooks-6f8NdD4XjC
- Outline documents request signing (`Outline-Signature`) and verification using HMAC SHA-256 with a shared secret, which is a production-grade event integrity requirement.
  - source: https://docs.getoutline.com/s/guide/doc/webhooks-6f8NdD4XjC
- Outline documents delivery behavior with retries/backoff and automatic disabling after repeated failures, which is exactly the operating model for event-driven pipelines.
  - source: https://docs.getoutline.com/s/guide/doc/webhooks-6f8NdD4XjC
- Outline API docs expose webhook lifecycle endpoints as first-class methods:
  - `webhooks.list`: https://docs.getoutline.com/s/guide/api-1/webhooks-list-pc5r8A0aBy
  - `webhooks.create`: https://docs.getoutline.com/s/guide/api-1/webhooks-create-p3W4b8M3wQ
  - `webhooks.info`: https://docs.getoutline.com/s/guide/api-1/webhooks-info-QG4SopH6ie
  - `webhooks.update`: https://docs.getoutline.com/s/guide/api-1/webhooks-update-iKKQqfD2ea
  - `webhooks.delete`: https://docs.getoutline.com/s/guide/api-1/webhooks-delete-8gik4kK8a5

## Current support in outline-agent
- No first-class `webhooks.*` tools exist today.
- Generic raw API access exists via `api.call`, so advanced users can invoke webhook endpoints manually when they know exact method names.
- Mutating raw calls are already action-gated (`performAction: true`) via `api.call` mutation detection.
- Existing read/mutation primitives (`documents.*`, `collections.*`, batch tools) can implement downstream processing after webhook-triggered jobs resolve target document IDs.

## Current limits/gaps in this repo
- G1: Missing webhook wrappers in the tool registry and contracts.
  - `webhooks.list|create|info|update|delete` are not discoverable as dedicated tools.
- G2: Missing webhook argument schemas.
  - No typed validation for webhook lifecycle inputs (`events`, `url`, pagination/filter args, required IDs).
- G3: `api.call` delete-safe flow is document-specific and over-matches any `*.delete` method.
  - Current logic requires `readToken` from `documents.info armDelete=true` for delete methods, which does not fit `webhooks.delete`.
- G4: No live integration coverage for webhook lifecycle and gating behavior.
  - Tests do not currently exercise create/list/info/update/delete for webhooks.
- G5: No documented webhook automation runbook in this repo.
  - README and TOOL_CONTRACTS do not describe event-driven setup patterns.

## Improvement proposal (specific wrappers/schema/tests/docs)
- P1: Add explicit webhook wrappers.
  - `webhooks.list(args?: { sort?: string; direction?: 'ASC'|'DESC'; event?: string; limit?: number; offset?: number; includeSubscriptions?: boolean; view?: 'summary'|'full'; includePolicies?: boolean })`
  - `webhooks.info(args: { id: string; includeSubscriptions?: boolean; view?: 'summary'|'full'; includePolicies?: boolean })`
  - `webhooks.create(args: { name: string; url: string; events: string[]; view?: 'summary'|'full'; includePolicies?: boolean; performAction?: boolean })`
  - `webhooks.update(args: { id: string; name?: string; url?: string; events?: string[]; view?: 'summary'|'full'; includePolicies?: boolean; performAction?: boolean })`
  - `webhooks.delete(args: { id: string; performAction?: boolean })`
- P2: Narrow delete read-confirmation logic for raw API calls.
  - In `api.call`, require read-receipt token only for document delete methods (`documents.delete`, `documents.permanent_delete`), not every method name that ends in `.delete`.
  - Keep `performAction: true` mandatory for all mutating webhook wrappers.
- P3: Add arg schemas in `src/tool-arg-schemas.js`.
  - Enforce required fields and enum bounds for list/info/create/update/delete args.
  - Enforce non-empty `events` arrays for create/update when provided.
  - Enforce `id` required on info/delete/update and “at least one mutable field” on update.
- P4: Add live integration tests in `test/live.integration.test.js`.
  - Flow: `webhooks.create` -> `webhooks.list`/`webhooks.info` verify -> `webhooks.update` verify -> `webhooks.delete` cleanup.
  - Gate tests: mutating webhook calls fail without `performAction=true`.
  - Regression test: non-document delete methods are not blocked by document read-token gate.
- P5: Update docs.
  - `docs/TOOL_CONTRACTS.md`: add webhook tool signatures, examples, and gating notes.
  - `README.md`: add a webhook lifecycle example plus signature-verification/retry operational notes.

## Issue resolution matrix
| Issue | Risk if unaddressed | Proposed remediation | Verification step |
| --- | --- | --- | --- |
| G1: Missing webhook wrappers in the tool registry and contracts. | Webhook lifecycle operations stay hard to discover and harder to automate safely with stable tool contracts. | Implement P1 by adding and registering `webhooks.list|info|create|update|delete` wrappers and exposing them in contracts. | Run `node ./bin/outline-agent.js tools contract all --result-mode inline` and confirm all `webhooks.*` entries are present. |
| G2: Missing webhook argument schemas. | Invalid webhook payloads can pass through to runtime calls, increasing failed requests and inconsistent behavior. | Implement P3 by adding strict schemas for list/info/create/update/delete, including required IDs and non-empty `events`. | Add and run live tests that assert schema failures for missing required fields and invalid update payloads. |
| G3: `api.call` delete-safe flow is document-specific and over-matches any `*.delete` method. | Legitimate non-document deletes such as `webhooks.delete` can be incorrectly blocked by document read-token requirements. | Implement P2 by scoping read-token enforcement to `documents.delete` and `documents.permanent_delete` only. | Add regression coverage proving `webhooks.delete` works with `performAction=true` and does not require document read tokens. |
| G4: No live integration coverage for webhook lifecycle and gating behavior. | Regressions in create/list/info/update/delete and action gating may ship undetected. | Implement P4 with end-to-end live webhook lifecycle subtests plus gating assertions. | Run `npm test` and confirm webhook lifecycle and gating subtests pass in live environment. |
| G5: No documented webhook automation runbook in this repo. | Teams cannot reliably adopt event-driven patterns and may implement insecure or non-idempotent webhook handling. | Implement P5 by documenting webhook contracts, lifecycle examples, signature verification, retry, and operational notes. | Review `README.md` and `docs/TOOL_CONTRACTS.md` for webhook sections that match implemented tool signatures and gating behavior. |

## Process checklist
1. Confirm target events and receiving endpoint contract (payload schema, idempotency key, retry handling).
2. Validate Outline webhook endpoint contracts against docs before implementation.
3. Implement `webhooks.*` wrappers in tool modules and register them in the tool map.
4. Add strict arg schemas for all new webhook tools.
5. Fix `api.call` delete-read-token scope so non-document deletes (like `webhooks.delete`) work safely.
6. Add live webhook lifecycle and gating subtests with deterministic cleanup of suite-created webhooks.
7. Run `npm run check` and `npm test`, then sync `README.md` and `docs/TOOL_CONTRACTS.md` with final contracts.
