# UC-01: Company handbook / onboarding hub

## Scenario
- use_case_id: UC-01
- name: Company handbook and onboarding hub
- primary_goal: Keep onboarding knowledge centralized, searchable, permission-safe, and easy to update in bulk.
- typical_actors: [people_ops_admin, team_manager, new_hire]
- core_workflow:
  1. Build handbook structure by collection and nested docs.
  2. Reuse onboarding templates for role-specific pages/checklists.
  3. Answer newcomer questions via search over published docs.
  4. Roll out policy edits across many docs with preview before apply.
  5. Keep a revision trail and restore quickly when needed.

## Why this is real (with source links)
- E1: GitLab states its handbook is the central repository for how the company runs and that it is very large/open.
  - source: https://about.gitlab.com/handbook/
- E2: GitLab has a dedicated onboarding handbook page ("GitLab Onboarding") with onboarding issue templates.
  - source: https://handbook.gitlab.com/handbook/people-group/general-onboarding/
- E3: Outline positions itself as a team knowledge base for internal documentation and onboarding.
  - source: https://www.getoutline.com/
- E4: Outline docs define collections as the main organizational and permission boundary.
  - source: https://docs.getoutline.com/s/guide/doc/collections-l9o3LD22sV
- E5: Outline docs provide templates for repeatable documentation workflows.
  - source: https://docs.getoutline.com/s/guide/doc/templates-GP6DXgRtxl
- E6: Outline docs provide search/AI answers and document revision history for self-serve onboarding and governance.
  - sources:
    - https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06
    - https://docs.getoutline.com/s/guide/doc/revision-history-AiL6p22Ssq

## Current support in outline-agent (tools that help)
- Discovery/navigation:
  - `collections.list`, `collections.info`, `collections.tree`
  - `documents.list`, `documents.info`, `documents.search`, `documents.resolve`
  - `search.expand`, `search.research`
- Authoring and controlled edits:
  - `documents.create`, `documents.update`, `documents.safe_update`
  - `documents.diff`, `documents.apply_patch`
- Multi-doc maintenance:
  - `documents.plan_batch_update`, `documents.apply_batch_plan`, `documents.batch_update`
- Safety/governance:
  - `revisions.list`, `revisions.restore`
  - mutation action gate via `performAction: true`
  - safe delete handshake (`documents.info armDelete` -> `documents.delete readToken`)

## Current limits/gaps in this repo
- G1: Onboarding access provisioning is not first-class.
  - Missing wrappers for key permission/user flows (`users.invite`, `groups.*`, `collections.memberships/add_user/add_group/remove_*`, `documents.add_user/add_group/remove_*`, `shares.*`).
  - Today this requires generic `api.call`, which is less deterministic for agent workflows.
- G2: Template lifecycle is incomplete.
  - No dedicated wrappers for `templates.*` or `documents.templatize` (only `templateId` passthrough on create/update).
- G3: Handbooks need workflow-level helpers, not only primitives.
  - No single deterministic tool to bootstrap/update onboarding hubs (structure + templates + access policy checks).
- G4: Wrapper coverage is still narrow versus published API surface.
  - Local scan in this repo shows `13` wrapped RPC calls, while Outline OpenAPI publishes `107` methods.
  - source: https://github.com/outline/openapi/blob/main/spec3.yml

## Improvement proposal (concrete: tool wrappers/schema/tests/docs)
- P1: Add onboarding-critical wrappers.
  - access: `users.invite`, `groups.create/list/add_user/remove_user`, `collections.memberships/add_user/add_group/remove_user/remove_group`, `shares.create/list/revoke`
  - templates: `templates.list/info/create/update/delete`, `documents.templatize`
- P2: Add strict arg schemas in `src/tool-arg-schemas.js` for every new wrapper.
  - enforce required identifiers, non-empty arrays, role enums, and `performAction` gating on mutating calls.
- P3: Add live integration subtests in `test/live.integration.test.js`.
  - template flow: create doc -> templatize -> list template -> instantiate -> cleanup.
  - access flow: create temporary collection/doc -> grant/revoke membership/share -> verify with info/list calls -> cleanup.
  - invite flow: gated test path only when dedicated safe test account env vars are present.
- P4: Update docs.
  - `README.md`: add "handbook onboarding playbook" with deterministic command sequence.
  - `docs/TOOL_CONTRACTS.md`: add signatures/examples/best practices for each new wrapper.

## Issue resolution matrix
| Issue | Risk if unaddressed | Proposed remediation | Verification step |
| --- | --- | --- | --- |
| G1: Onboarding access provisioning is not first-class. | Access setup stays dependent on generic `api.call`, which reduces determinism for agent workflows and increases risk of inconsistent permission changes. | Implement dedicated wrappers listed under P1 for users/groups/memberships/shares and enforce mutating action gates per P2. | Add and run live access-flow subtests from P3 (grant/revoke + share + cleanup), then verify via `collections.info`/`documents.info` list outputs. |
| G2: Template lifecycle is incomplete. | Teams cannot run a deterministic template lifecycle through first-class tools, causing manual workarounds and weaker automation contracts. | Add `templates.*` wrappers and `documents.templatize` in P1, with strict schemas from P2. | Add and run the template flow subtests in P3: create doc -> templatize -> list template -> instantiate -> cleanup. |
| G3: Handbooks need workflow-level helpers, not only primitives. | Onboarding hub setup remains fragmented across many low-level calls, making repeatable playbooks harder to execute and audit. | Document and expose a deterministic onboarding playbook sequence in README and TOOL_CONTRACTS as defined in P4, building on existing primitives and planned wrappers. | Execute the process checklist end-to-end on a test handbook flow and confirm each step output is reproducible. |
| G4: Wrapper coverage is still narrow versus published API surface. | High-value endpoints remain uncovered, forcing fallback to generic calls and reducing contract stability for automation. | Use the gap-driven wrapper expansion in P1 and keep schemas/tests/docs aligned via P2-P4 to close high-value coverage gaps first. | Re-run the local wrapped-RPC inventory and compare against current OpenAPI method list; confirm newly wrapped endpoints are documented and tested. |

## Process checklist
1. Resolve target collection and current tree (`collections.list` + `collections.tree`).
2. Resolve canonical onboarding docs (`documents.resolve` / `search.research` with `view=ids`).
3. Preview handbook-wide policy edits (`documents.plan_batch_update`).
4. Confirm hash and apply (`documents.apply_batch_plan` with `performAction=true`).
5. Verify sampled docs (`documents.info`) and revision entries (`revisions.list`).
6. For access changes, use explicit wrapper calls (currently `api.call`; proposed dedicated wrappers).
7. Record outputs/contracts updates in docs, then run `npm run check` and `npm test`.
