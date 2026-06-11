---
name: outline-agent-cli
description: Use the local Outline CLI (`outline-cli`, legacy alias `outline-agent`) to search, read, update, and operate Outline workspaces through deterministic API calls. Trigger when tasks involve company docs/wiki/handbook lookup, specific document names, collections, comments, attachments/images/files, shares, templates, permissions, federated sync, or document create/update/delete workflows, especially when token-efficient `ids/summary` views, profile routing, action gates (`performAction`), delete read tokens, or temp-file offload are relevant.
---

# Goal
Execute Outline workflows with low-token, machine-readable CLI calls while keeping mutation and delete safety guarantees intact.

# Instructions

## Command Policy
- Prefer `outline-cli` in all commands.
- Accept `outline-agent` only when the user explicitly uses that alias.
- Prefer `invoke`/`batch` with structured JSON arguments instead of ad-hoc shell parsing.

## Session Bootstrap (Only When Needed)
1. Verify CLI availability or existing setup only when the session is new or commands are failing:
   ```bash
   outline-cli --version
   outline-cli profile list
   ```
2. Load onboarding/help only when setup is missing, auth is failing, or you truly do not know the tool surface yet:
   ```bash
   outline-cli tools help quick-start-agent --view full
   outline-cli tools contract all --result-mode inline
   ```
3. Confirm profile access before mutations or when auth is suspicious:
   ```bash
   outline-cli profile test
   outline-cli invoke auth.info --args '{"view":"summary"}'
   ```

## Native First-Call Workflow
1. For knowledge lookup, prefer one-call retrieval tools first:
   - `search.research` for multi-query evidence gathering.
   - `documents.answer` for scoped question answering.
   - `documents.search` for direct title/semantic lookup.
2. Use `batch` for independent reads instead of sequential loops.
3. Open `tools help` or `tools contract` only after a validation failure or when the needed capability is still unclear.

## Capability Map
- Retrieval and navigation:
  - `documents.search`, `documents.list`, `documents.info`, `documents.resolve`, `documents.resolve_urls`, `documents.canonicalize_candidates`
  - `collections.list`, `collections.info`, `collections.tree`
  - `search.expand`, `search.research`
- Embedded files and images:
  - `documents.attachments`, `attachments.download`, `documents.download_attachments`
- Safe document mutation:
  - `documents.update`, `documents.safe_update`, `documents.diff`, `documents.apply_patch`, `documents.apply_patch_safe`, `documents.batch_update`
  - `documents.plan_batch_update`, `documents.plan_terminology_refactor`, `documents.apply_batch_plan`
- Lifecycle and collaboration:
  - `revisions.*`, `shares.*`, `templates.*`, `documents.templatize`, `comments.*`, `events.list`
- Knowledge and linkage workflows:
  - `documents.answer`, `documents.answer_batch`
  - `documents.backlinks`, `documents.graph_neighbors`, `documents.graph_report`
  - `documents.issue_refs`, `documents.issue_ref_report`
- Integration/admin wrappers:
  - `federated.sync_manifest`, `federated.sync_probe`, `federated.permission_snapshot`, `capabilities.map`
  - `users.*`, `groups.*`, `collections.*_memberships`, `documents.*_memberships`, `documents.users`
  - `oauth_clients.*`, `oauth_authentications.*`, `oauthClients.delete`, `oauthAuthentications.delete`
  - `webhooks.*`, `file_operations.*`, `documents.import_file`, `documents.create_from_template`, `documents.cleanup_test`
- Escape hatch:
  - `api.call` for JSON RPC endpoints that do not yet have dedicated tools. Do not use it for binary endpoints.

## Retrieval Workflow (Default Read Path)
1. Resolve candidates cheaply with `view:"ids"` or `view:"summary"`:
   - `documents.search`, `documents.list`, `collections.list`, `documents.resolve`.
2. Hydrate only selected IDs:
   - `documents.info`, `collections.info`.
3. Escalate to `view:"full"` only for final documents that truly need full body text.
4. Keep `includePolicies:false` unless policy decisions are required.
5. For embedded document files/images, use attachment-aware tools instead of raw binary endpoints:
   - `documents.attachments` to list `/api/attachments.redirect?id=...` references.
   - `attachments.download` to save one attachment/image locally.
   - `documents.download_attachments` to save all embedded files from a document.
   Do not call `attachments.redirect` through `api.call`; it returns binary bytes, not JSON.

## Mutation Workflow (Safe + Explicit)
1. Read current state first (`documents.info`/`collections.info`).
2. Prefer minimal edits:
   - text increments via `editMode:"append"|"prepend"`, or
   - patch-based changes via `documents.apply_patch_safe`.
3. For revision-sensitive automation, use optimistic concurrency:
   - `documents.safe_update` or `documents.apply_patch_safe` with `expectedRevision`.
4. Pass `performAction:true` only on the final, intentional mutation call.

## Delete Workflow (Mandatory Safe Flow)
1. Arm delete read:
   ```bash
   outline-cli invoke documents.info --args '{"id":"<doc-id>","armDelete":true,"view":"summary"}'
   ```
2. Extract `deleteReadReceipt.token`.
3. Delete with token + explicit action:
   ```bash
   outline-cli invoke documents.delete --args '{"id":"<doc-id>","readToken":"<token>","performAction":true}'
   ```
4. If token is stale/mismatched/expired, re-run step 1 immediately and retry once.

## Batch and Token Efficiency
- Batch independent reads and planning operations:
  ```bash
  outline-cli batch --ops '[
    {"tool":"collections.list","args":{"limit":10,"view":"summary"}},
    {"tool":"documents.search","args":{"query":"incident","limit":8,"view":"ids"}}
  ]'
  ```
- Prefer `queries[]`/`ids[]` tool arguments over repeated single calls.
- Use `--args-file` or `--ops-file` for long payloads.
- Keep responses compact and deterministic; avoid loading full document text unless needed.

## Output Handling
- Output format:
  - default JSON (`--output json`)
  - stream-friendly mode (`--output ndjson`)
- Result mode:
  - `auto` (default): inline until large payloads offload to temp files
  - `inline`: always inline
  - `file`: always temp file pointer
- When offloaded, inspect only required fields:
  ```bash
  outline-cli tmp cat /absolute/path/from/result.json
  ```
- Periodic cleanup:
  ```bash
  outline-cli tmp gc --older-than-hours 24
  ```

## Tool Selection Hints
- Fuzzy title/semantic resolution: `documents.resolve`, `documents.resolve_urls`
- Search + hydrate in one call: `search.expand`, `search.research`
- Embedded images/files: `documents.attachments`, `attachments.download`, `documents.download_attachments`
- Minimal diff planning before write: `documents.diff`, `documents.plan_batch_update`
- Safer patch writes: `documents.apply_patch_safe`
- Capability checks before multi-step plans: `capabilities.map`

## Source References
Every response that presents information retrieved from Outline must include source references linking back to the original document(s).

Build links from available fields:
- Prefer full document `url`: `{baseUrl}{url}`.
- If only `urlId` is available: `{baseUrl}/doc/{urlId}`.
- The `baseUrl` comes from the selected profile or `auth.info`/`profile test` team URL.

Present a compact `Sources` section using document titles as link text. List each contributing document once.

## Constraints
- Never run mutating calls without explicit `performAction:true`.
- Never delete without a fresh `readToken` from `documents.info armDelete:true`.
- Never default to `view:"full"` for discovery/exploration.
- Do not read onboarding/help docs when a working profile already exists and the task can be attempted directly.
- If a direct call fails due to unknown tool or validation issues, use the CLI's error suggestions before falling back to docs.
- Never send oversized inline markdown when `--args-file` is cleaner and less error-prone.
- Never present Outline-derived facts without source references.

# Examples

## Example 1: Low-token discovery then targeted hydrate
```bash
outline-cli invoke documents.search --args '{
  "queries": ["incident process", "escalation matrix"],
  "mode": "semantic",
  "limit": 8,
  "merge": true,
  "view": "ids"
}'

outline-cli invoke documents.info --args '{
  "ids": ["doc-a", "doc-b"],
  "view": "summary",
  "concurrency": 3
}'
```

## Example 2: Safe revision-guarded patch update
```bash
outline-cli invoke documents.apply_patch_safe --args '{
  "query": "incident runbook",
  "expectedRevision": "latest",
  "mode": "unified",
  "patch": "@@ -1,1 +1,1 @@\n-Old\n+New",
  "performAction": true,
  "view": "summary"
}'
```

## Example 3: Batch guarded updates by remembered refs
```bash
outline-cli invoke documents.batch_update --args '{
  "updates": [
    { "query": "incident runbook", "expectedRevision": "latest", "text": "\n\nUpdated", "editMode": "append" },
    { "url": "https://handbook.example.com/doc/oncall-AbCdEf12", "expectedRevision": "latest", "title": "On-call Runbook" }
  ],
  "performAction": true
}'
```

## Example 4: Safe delete with read receipt
```bash
outline-cli invoke documents.info --args '{"id":"doc-a","armDelete":true,"view":"summary"}'

outline-cli invoke documents.delete --args '{
  "id": "doc-a",
  "readToken": "<deleteReadReceipt.token>",
  "performAction": true
}'
```

## Example 5: Embedded image/file download
```bash
outline-cli invoke documents.attachments --args '{
  "url": "https://handbook.example.com/doc/example-title-AbCdEf1234"
}'

outline-cli invoke documents.download_attachments --args '{
  "url": "https://handbook.example.com/doc/example-title-AbCdEf1234",
  "outputDir": "./outline-attachments",
  "overwrite": true
}'
```

# Read Next
Load additional patterns only when needed:
- `references/tool-playbook.md`
