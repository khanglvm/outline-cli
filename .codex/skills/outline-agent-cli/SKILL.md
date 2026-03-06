---
name: outline-agent-cli
description: Use the local Outline CLI (`outline-cli`, legacy alias `outline-agent`) to interact with Outline workspaces through deterministic API calls. Trigger when tasks involve searching, listing, reading, creating, updating, patching, deleting, or batch-processing Outline documents/collections, especially when token-efficient `ids/summary` views, profile routing, action gates (`performAction`), delete read tokens, or temp-file offload are relevant.
---

# Goal
Execute Outline workflows with low-token, machine-readable CLI calls while keeping mutation and delete safety guarantees intact.

# Instructions

## Command Policy
- Prefer `outline-cli` in all commands.
- Accept `outline-agent` only when the user explicitly uses that alias.
- Prefer `invoke`/`batch` with structured JSON arguments instead of ad-hoc shell parsing.

## Session Bootstrap (Always)
1. Verify CLI availability:
   ```bash
   outline-cli --version
   ```
2. Confirm available tooling/help:
   ```bash
   outline-cli tools help --view summary
   outline-cli tools contract all --result-mode inline
   ```
3. Confirm profile access before mutations:
   ```bash
   outline-cli profile list --pretty
   outline-cli profile test
   outline-cli invoke auth.info --args '{"view":"summary"}'
   ```

## Retrieval Workflow (Default Read Path)
1. Resolve candidates cheaply with `view:"ids"` or `view:"summary"`:
   - `documents.search`, `documents.list`, `collections.list`, `documents.resolve`.
2. Hydrate only selected IDs:
   - `documents.info`, `collections.info`.
3. Escalate to `view:"full"` only for final documents that truly need full body text.
4. Keep `includePolicies:false` unless policy decisions are required.

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
- Minimal diff planning before write: `documents.diff`, `documents.plan_batch_update`
- Safer patch writes: `documents.apply_patch_safe`
- Capability checks before multi-step plans: `capabilities.map`

## Constraints
- Never run mutating calls without explicit `performAction:true`.
- Never delete without a fresh `readToken` from `documents.info armDelete:true`.
- Never default to `view:"full"` for discovery/exploration.
- Never assume a profile; verify with `profile list/test` and `auth.info`.
- Never send oversized inline markdown when `--args-file` is cleaner and less error-prone.

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
outline-cli invoke documents.info --args '{"id":"doc-a","view":"summary"}'
# capture revision from result.items[0].document.revision

outline-cli invoke documents.apply_patch_safe --args '{
  "id": "doc-a",
  "expectedRevision": 12,
  "mode": "unified",
  "patch": "@@ -1,1 +1,1 @@\n-Old\n+New",
  "performAction": true,
  "view": "summary"
}'
```

## Example 3: Safe delete with read receipt
```bash
outline-cli invoke documents.info --args '{"id":"doc-a","armDelete":true,"view":"summary"}'

outline-cli invoke documents.delete --args '{
  "id": "doc-a",
  "readToken": "<deleteReadReceipt.token>",
  "performAction": true
}'
```

# Read Next
Load additional patterns only when needed:
- `references/tool-playbook.md`
