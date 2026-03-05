# Tool Contracts

Each tool contract includes signature, usage example, and AI best practices.

Use CLI to get canonical JSON contracts:

```bash
outline-cli tools contract all --pretty
```

AI instruction skills (scenario help) are available via:

```bash
outline-cli tools help ai-skills --view summary
outline-cli tools help ai-skills --scenario UC-19
outline-cli tools help ai-skills --skill oauth_compliance_audit --view full
```

## Runtime Profile Routing

- Runtime commands (`invoke`, `batch`, `profile test`) resolve profile in this order:
  1. `--profile <id>`
  2. configured default profile
  3. single-profile fallback when exactly one profile exists
- If multiple profiles exist and no default is configured, `--profile <id>` is required.
- `profile add` only sets default when `--set-default` is provided.

## `api.call`

- Signature: `api.call(args: { method?: string; endpoint?: string; body?: object; includePolicies?: boolean; maxAttempts?: number; select?: string[]; performAction?: boolean; readToken?: string })`
- Usage example:

```json
{
  "tool": "api.call",
  "args": {
    "method": "documents.info",
    "body": { "id": "outline-api-NTpezNwhUP" }
  }
}
```

- Best practice (AI): use for endpoints not wrapped yet; keep `body` minimal; use `select` to cut tokens. Mutating methods require explicit `performAction=true`.
- Best practice (AI): pass either `method` or `endpoint`; both map to Outline RPC method path.

## `auth.info`

- Signature: `auth.info(args?: { includePolicies?: boolean; view?: 'summary' | 'full' })`
- Usage example:

```json
{
  "tool": "auth.info",
  "args": { "view": "summary" }
}
```

- Best practice (AI): call once at session start to confirm identity/workspace.

## `oauth_clients.list` (optional wrapper)

- Signature: `oauth_clients.list(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "oauth_clients.list",
  "args": {
    "limit": 25,
    "view": "summary"
  }
}
```

- Availability: optional UC-19 helper; contract may be unavailable in older deployments/builds.
- Alias mapping: wrapper `oauth_clients.list` maps to raw endpoint `oauthClients.list`; fallback via `api.call` supports either `method` or `endpoint`.
- Best practice (AI): start with `view: "summary"` for deterministic discovery, then hydrate only selected ids.
- Best practice (AI): treat `401/403/404/405/501` as deployment-policy dependent in live compliance smoke checks and skip gracefully.

## `oauth_clients.info` (optional wrapper)

- Signature: `oauth_clients.info(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "oauth_clients.info",
  "args": {
    "id": "oauth-client-id",
    "view": "summary"
  }
}
```

- Availability: optional UC-19 helper; contract may be unavailable in older deployments/builds.
- Alias mapping: wrapper `oauth_clients.info` maps to raw endpoint `oauthClients.info`; fallback via `api.call` supports either `method` or `endpoint`.
- Best practice (AI): prefer explicit `id` hydration from a prior `oauth_clients.list` call for deterministic reads.
- Best practice (AI): if no candidate ids are discoverable in a tenant, treat synthetic-id probes as non-destructive contract checks only.

## `oauth_authentications.list` (optional wrapper)

- Signature: `oauth_authentications.list(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "oauth_authentications.list",
  "args": {
    "limit": 25,
    "view": "summary"
  }
}
```

- Availability: optional UC-19 helper; contract may be unavailable in older deployments/builds.
- Alias mapping: wrapper `oauth_authentications.list` maps to raw endpoint `oauthAuthentications.list`; fallback via `api.call` supports either `method` or `endpoint`.
- Best practice (AI): keep list probes read-only and token-efficient (`limit`, `view: "summary"`) for compliance automation.
- Best practice (AI): for production tenants, avoid broad pagination during routine checks unless explicitly required.

## `oauth_authentications.delete` (optional wrapper)

- Signature: `oauth_authentications.delete(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "oauth_authentications.delete",
  "args": {
    "id": "oauth-authentication-id",
    "performAction": true
  }
}
```

- Availability: optional UC-19 helper; contract may be unavailable in older deployments/builds.
- Alias mapping: wrapper `oauth_authentications.delete` maps to raw endpoint `oauthAuthentications.delete`; fallback via `api.call` supports either `method` or `endpoint`.
- Best practice (AI): this tool is action-gated; preflight without `performAction` in compliance tests to validate safe mutation guards.
- Best practice (AI): in shared/live environments, only delete explicitly scoped test resources and keep synthetic-id probes non-destructive by default.

## `users.list`

- Signature: `users.list(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "users.list",
  "args": {
    "limit": 20,
    "view": "summary"
  }
}
```

- Best practice (AI): use `view: "summary"` for roster discovery, then hydrate only selected users with `users.info`.
- Best practice (AI): apply pagination (`limit`/`offset`) for deterministic audits on larger workspaces.

## `users.info`

- Signature: `users.info(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "users.info",
  "args": {
    "id": "user-id",
    "view": "summary"
  }
}
```

- Best practice (AI): prefer a specific `id` to keep hydration deterministic and cheap.
- Best practice (AI): use `ids[]` + `concurrency` when hydrating multiple principals.

## `users.invite` (optional wrapper)

- Signature: `users.invite(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "users.invite",
  "args": {
    "invites": [
      {
        "email": "new.user@example.com",
        "name": "New User",
        "role": "member"
      }
    ],
    "performAction": true,
    "view": "summary"
  }
}
```

- Availability: optional UC-13 helper; contract may be unavailable in older deployments/builds.
- Best practice (AI): keep invites batched and explicit; always pass `performAction: true` only at the final approved mutation step.
- Best practice (AI): run with `view: "summary"` and audit `result` rows per invite for partial failures.

## `users.update_role` (optional wrapper)

- Signature: `users.update_role(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "users.update_role",
  "args": {
    "id": "user-id",
    "role": "member",
    "performAction": true,
    "view": "summary"
  }
}
```

- Availability: optional UC-13 helper; contract may be unavailable in older deployments/builds.
- Best practice (AI): resolve the target user with `users.info` first and persist the original role for rollback planning.
- Best practice (AI): treat role mutation as high-impact; require explicit approval before sending `performAction: true`.

## `users.activate` (optional wrapper)

- Signature: `users.activate(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "users.activate",
  "args": {
    "id": "user-id",
    "performAction": true,
    "view": "summary"
  }
}
```

- Availability: optional UC-13 helper; contract may be unavailable in older deployments/builds.
- Best practice (AI): verify current lifecycle state via `users.info` before activation to keep idempotent runs deterministic.
- Best practice (AI): log activation evidence via follow-up `events.list` filters.

## `users.suspend` (optional wrapper)

- Signature: `users.suspend(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "users.suspend",
  "args": {
    "id": "user-id",
    "performAction": true,
    "view": "summary"
  }
}
```

- Availability: optional UC-13 helper; contract may be unavailable in older deployments/builds.
- Best practice (AI): suspend only after confirming the principal and blast radius; keep action gating explicit.
- Best practice (AI): run post-checks with `users.info` + `events.list` for compliance evidence.

## `groups.list`

- Signature: `groups.list(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "groups.list",
  "args": {
    "limit": 20,
    "view": "summary"
  }
}
```

- Best practice (AI): discover candidate department/security groups with compact views before membership reads.
- Best practice (AI): persist resolved group IDs for downstream `groups.info` and permission checks.

## `groups.info`

- Signature: `groups.info(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "groups.info",
  "args": {
    "id": "group-id",
    "view": "summary"
  }
}
```

- Best practice (AI): use this as the authoritative group metadata read before grant/revoke steps.
- Best practice (AI): hydrate multiple IDs in one call when running scheduled audits.

## `groups.memberships` (optional wrapper)

- Signature: `groups.memberships(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "groups.memberships",
  "args": {
    "id": "group-id",
    "limit": 50,
    "view": "summary"
  }
}
```

- Best practice (AI): if this wrapper is unavailable in your build, use `api.call` with `method: "groups.memberships"` as a read-only fallback.
- Best practice (AI): treat `401/403/404/405` as deployment/permission-dependent and skip gracefully in live smoke checks.

## `documents.search`

- Signature: `documents.search(args: { query?: string; queries?: string[]; mode?: 'semantic' | 'titles'; limit?: number; offset?: number; collectionId?: string; documentId?: string; userId?: string; statusFilter?: string[]; dateFilter?: 'day'|'week'|'month'|'year'; snippetMinWords?: number; snippetMaxWords?: number; sort?: string; direction?: 'ASC'|'DESC'; view?: 'summary'|'ids'|'full'; includePolicies?: boolean; merge?: boolean; concurrency?: number; })`
- Usage example:

```json
{
  "tool": "documents.search",
  "args": {
    "queries": ["deployment runbook", "incident response"],
    "mode": "semantic",
    "limit": 8,
    "view": "summary",
    "merge": true
  }
}
```

- Best practice (AI): use `queries[]` for multi-search in one call, start with `view: ids`, then hydrate only selected docs.

## `documents.list`

- Signature: `documents.list(args?: { limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; collectionId?: string; parentDocumentId?: string | null; backlinkDocumentId?: string; userId?: string; statusFilter?: string[]; view?: 'ids'|'summary'|'full'; includePolicies?: boolean })`
- Usage example:

```json
{
  "tool": "documents.list",
  "args": {
    "backlinkDocumentId": "outline-api-NTpezNwhUP",
    "limit": 20,
    "view": "summary"
  }
}
```

- Best practice (AI): use `backlinkDocumentId` for deterministic internal graph traversal (which docs reference a known source doc).
- Best practice (AI): `documents.backlinks` (when available) is the explicit wrapper for the same traversal intent; keep `documents.list(backlinkDocumentId=...)` as the compatibility fallback.
- Best practice (AI): page with small limits; avoid full view unless needed.

## `documents.backlinks`

- Signature: `documents.backlinks(args: { id: string; limit?: number; offset?: number; view?: 'ids'|'summary'|'full' })`
- Usage example:

```json
{
  "tool": "documents.backlinks",
  "args": {
    "id": "outline-api-NTpezNwhUP",
    "limit": 20,
    "view": "summary"
  }
}
```

- Best practice (AI): use this wrapper when available for explicit graph intent; it should mirror backlink traversal behavior from `documents.list(backlinkDocumentId=...)`.
- Best practice (AI): treat unsupported/unauthorized responses as deployment-dependent and skip gracefully in live smoke tests.

## `documents.graph_neighbors`

- Signature: `documents.graph_neighbors(args: { id?: string; ids?: string[]; includeBacklinks?: boolean; includeSearchNeighbors?: boolean; searchQueries?: string[]; limitPerSource?: number; view?: 'ids'|'summary' })`
- Usage example:

```json
{
  "tool": "documents.graph_neighbors",
  "args": {
    "id": "outline-api-NTpezNwhUP",
    "includeBacklinks": true,
    "includeSearchNeighbors": false,
    "limitPerSource": 10,
    "view": "summary"
  }
}
```

- Best practice (AI): request neighbor expansion with bounded limits and consume normalized edge rows for deterministic traversal.
- Best practice (AI): start from one seed `id`, then fan out selectively by hydrating only returned document IDs.

## `documents.graph_report`

- Signature: `documents.graph_report(args: { seedIds: string[]; depth?: number; maxNodes?: number; includeBacklinks?: boolean; includeSearchNeighbors?: boolean; })`
- Usage example:

```json
{
  "tool": "documents.graph_report",
  "args": {
    "seedIds": ["outline-api-NTpezNwhUP"],
    "depth": 2,
    "maxNodes": 50,
    "includeBacklinks": true,
    "includeSearchNeighbors": false
  }
}
```

- Best practice (AI): keep `depth` and `maxNodes` conservative to preserve deterministic output size for automation.
- Best practice (AI): treat report output as bounded graph context, then call `documents.info` only on selected node IDs.

## `documents.issue_refs`

- Signature: `documents.issue_refs(args: { id?: string; ids?: string[]; issueDomains?: string[]; keyPattern?: string; view?: 'summary'|'full'; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "documents.issue_refs",
  "args": {
    "id": "outline-api-NTpezNwhUP",
    "issueDomains": ["linear.app"],
    "view": "summary"
  }
}
```

- Best practice (AI): call this on explicit document IDs first to produce deterministic issue-link extraction without broad search fan-out.
- Best practice (AI): use `issueDomains`/`keyPattern` to keep extraction focused and machine-friendly for downstream patch/audit steps.

## `documents.issue_ref_report`

- Signature: `documents.issue_ref_report(args: { query?: string; queries?: string[]; collectionId?: string; issueDomains?: string[]; keyPattern?: string; limit?: number; view?: 'ids'|'summary'; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "documents.issue_ref_report",
  "args": {
    "query": "ENG-4312",
    "collectionId": "collection-id",
    "limit": 10,
    "view": "summary"
  }
}
```

- Best practice (AI): run report queries with bounded `limit` and `view: "ids"`/`"summary"` first, then hydrate only selected docs via `documents.info`.
- Best practice (AI): pair report results with `events.list` for deterministic "link discovered -> doc updated -> audit trail" workflows.

## `documents.info`

- Signature: `documents.info(args: { id?: string; ids?: string[]; shareId?: string; view?: 'summary'|'full'; includePolicies?: boolean; concurrency?: number; armDelete?: boolean; readTokenTtlSeconds?: number })`
- Usage example:

```json
{
  "tool": "documents.info",
  "args": {
    "ids": ["doc-1", "doc-2", "doc-3"],
    "view": "summary",
    "concurrency": 3
  }
}
```

- Best practice (AI): batch IDs to reduce round trips; check per-item `ok` in batch results. Use `armDelete=true` before delete to obtain a read receipt token.

## `documents.answer`

- Signature: `documents.answer(args: { question?: string; query?: string; ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "documents.answer",
  "args": {
    "question": "How do I reset VPN access?",
    "collectionId": "collection-id",
    "view": "summary",
    "includeEvidenceDocs": true
  }
}
```

- Best practice (AI): keep question wording specific and scope by `collectionId` or `documentId` when possible.
- Best practice (AI): consume deterministic wrapper envelope (`result.question` + endpoint payload) and branch explicitly on no-hit signals.

## `documents.answer_batch`

- Signature: `documents.answer_batch(args: { question?: string; questions?: Array<string | { question?: string; query?: string; ...endpointArgs }>; ...endpointArgs; concurrency?: number; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "documents.answer_batch",
  "args": {
    "questions": [
      "How do I reset VPN access?",
      { "question": "Who approves expense exceptions?", "documentId": "doc-id" }
    ],
    "collectionId": "collection-id",
    "concurrency": 2,
    "view": "summary"
  }
}
```

- Best practice (AI): keep batch sizes small and use low concurrency for predictable latency/token usage.
- Best practice (AI): inspect per-item `ok/status/error` and retry only failed questions.

## `documents.users` (optional wrapper)

- Signature: `documents.users(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "documents.users",
  "args": {
    "id": "doc-id",
    "limit": 20,
    "view": "summary"
  }
}
```

- Availability: optional UC-13 helper; contract may be unavailable in older deployments/builds.
- Best practice (AI): use this read path for direct principal visibility checks before ACL mutations.
- Best practice (AI): pair with `documents.memberships`/`documents.group_memberships` for complete user + group audit trails.

## `documents.memberships`

- Signature: `documents.memberships(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "documents.memberships",
  "args": {
    "id": "doc-id",
    "limit": 20,
    "view": "summary"
  }
}
```

- Best practice (AI): use for read-path visibility debugging before requesting permission mutations.
- Best practice (AI): keep `view` compact unless full user attributes are required.

## `documents.group_memberships`

- Signature: `documents.group_memberships(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "documents.group_memberships",
  "args": {
    "id": "doc-id",
    "limit": 20,
    "view": "summary"
  }
}
```

- Best practice (AI): use for department-space exception checks at document scope.
- Best practice (AI): pair with `documents.memberships` to audit direct-user and group grants together.

## `collections.memberships`

- Signature: `collections.memberships(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "collections.memberships",
  "args": {
    "id": "collection-id",
    "limit": 20,
    "view": "summary"
  }
}
```

- Best practice (AI): use collection membership checks when FAQ answers appear missing due to collection-level access.
- Best practice (AI): page through membership lists with `limit/offset` for deterministic audit loops.

## `collections.group_memberships`

- Signature: `collections.group_memberships(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "collections.group_memberships",
  "args": {
    "id": "collection-id",
    "limit": 20,
    "view": "summary"
  }
}
```

- Best practice (AI): use this read path immediately after `collections.add_group` / `collections.remove_group` to verify effective visibility changes.
- Best practice (AI): keep reads paginated for large department collections.

## `documents.create`

- Signature: `documents.create(args: { title?: string; text?: string; collectionId?: string; parentDocumentId?: string; publish?: boolean; icon?: string; color?: string; templateId?: string; fullWidth?: boolean; view?: 'summary'|'full' })`
- Usage example:

```json
{
  "tool": "documents.create",
  "args": {
    "title": "Incident 2026-03-04",
    "text": "# Incident\n\nSummary...",
    "collectionId": "collection-id",
    "publish": true
  }
}
```

- Best practice (AI): store long markdown in args file and pass `--args-file`.

## `documents.import`

- Signature: `documents.import(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "documents.import",
  "args": {
    "collectionId": "collection-id",
    "publish": false,
    "performAction": true,
    "view": "summary"
  }
}
```

- Best practice (AI): this tool is action-gated; keep `performAction=true` only on explicit operator-approved migration runs.
- Best practice (AI): treat provider-specific payload requirements as deployment-dependent and prefer dry verification (search/list/info) after each import batch.

## `documents.import_file`

- Signature: `documents.import_file(args: { filePath: string; collectionId?: string; parentDocumentId?: string; publish?: boolean; view?: 'summary'|'full'; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "documents.import_file",
  "args": {
    "filePath": "./fixtures/legacy-wiki-page.md",
    "collectionId": "collection-id",
    "publish": false,
    "performAction": true,
    "view": "summary"
  }
}
```

- Best practice (AI): use suite-owned fixture files and deterministic markers in import payloads so post-import verification and cleanup are scoped and auditable.
- Best practice (AI): run `file_operations.list/info` after import submission to track async status before downstream remediation.

## `file_operations.list`

- Signature: `file_operations.list(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "file_operations.list",
  "args": {
    "type": "import",
    "limit": 20,
    "view": "summary"
  }
}
```

- Best practice (AI): filter to `type: "import"` and keep payloads compact (`view: "summary"`) when polling migration status loops.

## `file_operations.info`

- Signature: `file_operations.info(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "file_operations.info",
  "args": {
    "id": "file-operation-id",
    "view": "summary"
  }
}
```

- Best practice (AI): hydrate specific operation IDs from `documents.import_file` or `file_operations.list` responses; avoid broad polling when operation IDs are known.

## `file_operations.delete`

- Signature: `file_operations.delete(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "file_operations.delete",
  "args": {
    "id": "file-operation-id",
    "performAction": true
  }
}
```

- Best practice (AI): only delete operation records created by the current controlled migration run; avoid mutating unrelated workspace operation history.
- Best practice (AI): this tool is action-gated; set `performAction=true` only after confirming the operation record is safe to remove.

## `documents.update`

- Signature: `documents.update(args: { id: string; title?: string; text?: string; editMode?: 'replace'|'append'|'prepend'; publish?: boolean; collectionId?: string; templateId?: string; fullWidth?: boolean; insightsEnabled?: boolean; view?: 'summary'|'full'; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "documents.update",
  "args": {
    "id": "doc-id",
    "text": "\n\n## Follow-up\n- Added RCA",
    "editMode": "append"
  }
}
```

- Best practice (AI): use append/prepend for incremental edits to minimize payloads. This tool is action-gated; set `performAction=true` only after explicit confirmation.

## `collections.list`

- Signature: `collections.list(args?: { query?: string; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; statusFilter?: string[]; view?: 'summary'|'full'; includePolicies?: boolean })`
- Usage example:

```json
{
  "tool": "collections.list",
  "args": { "query": "engineering", "limit": 10, "view": "summary" }
}
```

- Best practice (AI): resolve collection IDs early and reuse.

## `collections.info`

- Signature: `collections.info(args: { id?: string; ids?: string[]; view?: 'summary'|'full'; includePolicies?: boolean; concurrency?: number })`
- Usage example:

```json
{
  "tool": "collections.info",
  "args": { "ids": ["col-1", "col-2"], "view": "summary" }
}
```

- Best practice (AI): batch ID hydration in one command.

## `collections.create`

- Signature: `collections.create(args: { name: string; description?: string; permission?: string; icon?: string; color?: string; sharing?: boolean; view?: 'summary'|'full' })`
- Usage example:

```json
{
  "tool": "collections.create",
  "args": {
    "name": "Agent Notes",
    "description": "Working area for AI-assisted drafts",
    "permission": "read_write",
    "sharing": false
  }
}
```

- Best practice (AI): create collection first, then place documents under it.

## `collections.update`

- Signature: `collections.update(args: { id: string; name?: string; description?: string; permission?: string; icon?: string; color?: string; sharing?: boolean; view?: 'summary'|'full'; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "collections.update",
  "args": {
    "id": "col-id",
    "description": "Updated description",
    "sharing": true
  }
}
```

- Best practice (AI): update only changed fields for clear diffs and smaller payloads.

## `documents.resolve`

- Signature: `documents.resolve(args: { query?: string; queries?: string[]; collectionId?: string; limit?: number; strict?: boolean; strictThreshold?: number; view?: 'ids'|'summary'|'full'; concurrency?: number; })`
- Usage example:

```json
{
  "tool": "documents.resolve",
  "args": {
    "queries": ["incident handbook", "oncall escalation"],
    "limit": 6,
    "view": "summary"
  }
}
```

- Best practice (AI): resolve fuzzy refs once, then operate by exact IDs; use `strict=true` for automation safety.

## `collections.tree`

- Signature: `collections.tree(args: { collectionId: string; includeDrafts?: boolean; maxDepth?: number; view?: 'summary'|'full'; pageSize?: number; maxPages?: number; })`
- Usage example:

```json
{
  "tool": "collections.tree",
  "args": {
    "collectionId": "collection-id",
    "includeDrafts": false,
    "maxDepth": 4,
    "view": "summary"
  }
}
```

- Best practice (AI): use low `maxDepth` + summary view for navigation, then hydrate selected node IDs.

## `search.expand`

- Signature: `search.expand(args: { query?: string; queries?: string[]; mode?: 'semantic'|'titles'; limit?: number; expandLimit?: number; view?: 'ids'|'summary'|'full'; concurrency?: number; hydrateConcurrency?: number; })`
- Usage example:

```json
{
  "tool": "search.expand",
  "args": {
    "query": "postmortem template",
    "mode": "semantic",
    "limit": 8,
    "expandLimit": 3,
    "view": "summary"
  }
}
```

- Best practice (AI): keep `expandLimit` small to control tokens while still fetching full docs for top hits.

## `search.research`

- Signature: `search.research(args: { question?: string; query?: string; queries?: string[]; collectionId?: string; limitPerQuery?: number; offset?: number; includeTitleSearch?: boolean; includeSemanticSearch?: boolean; expandLimit?: number; maxDocuments?: number; seenIds?: string[]; view?: 'ids'|'summary'|'full'; concurrency?: number; hydrateConcurrency?: number; contextChars?: number; excerptChars?: number; maxAttempts?: number; })`
- Usage example:

```json
{
  "tool": "search.research",
  "args": {
    "question": "How do incident communication and escalation work?",
    "queries": ["incident comms", "escalation matrix"],
    "limitPerQuery": 8,
    "expandLimit": 5,
    "maxDocuments": 20,
    "view": "summary"
  }
}
```

- Best practice (AI): pass previous `next.seenIds` into `seenIds` in follow-up turns to avoid repeated evidence.

## `documents.safe_update`

- Signature: `documents.safe_update(args: { id: string; expectedRevision: number; title?: string; text?: string; editMode?: 'replace'|'append'|'prepend'; icon?: string; color?: string; fullWidth?: boolean; templateId?: string; collectionId?: string; insightsEnabled?: boolean; publish?: boolean; dataAttributes?: any[]; view?: 'summary'|'full'; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "documents.safe_update",
  "args": {
    "id": "doc-id",
    "expectedRevision": 3,
    "text": "\n\n## Changes\n- Added note",
    "editMode": "append"
  }
}
```

- Best practice (AI): pass revision from latest `documents.info`; on `revision_conflict`, re-read then retry intentionally.

## `documents.diff`

- Signature: `documents.diff(args: { id: string; proposedText: string; includeFullHunks?: boolean; hunkLimit?: number; hunkLineLimit?: number })`
- Usage example:

```json
{
  "tool": "documents.diff",
  "args": {
    "id": "doc-id",
    "proposedText": "# Title\n\nUpdated body"
  }
}
```

- Best practice (AI): diff before mutation to detect unexpectedly large changes.

## `documents.apply_patch`

- Signature: `documents.apply_patch(args: { id: string; patch: string; mode?: 'unified'|'replace'; expectedRevision?: number; title?: string; view?: 'summary'|'full'; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "documents.apply_patch",
  "args": {
    "id": "doc-id",
    "expectedRevision": 7,
    "mode": "unified",
    "patch": "@@ -1,1 +1,1 @@\n-Old\n+New"
  }
}
```

- Best practice (AI): pass `expectedRevision` to make patch application concurrency-safe; stale revisions deterministically return `code: "revision_conflict"` and skip mutation.
- Best practice (AI): use unified patches for minimal edits; fallback to replace mode only when full rewrite is intended.

## `documents.apply_patch_safe` (optional wrapper)

- Availability: optional UC-09 helper; contract may be unavailable in older deployments/builds.
- Signature: `documents.apply_patch_safe(args: { id: string; patch: string; expectedRevision: number; mode?: 'unified'|'replace'; title?: string; view?: 'summary'|'full'; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "documents.apply_patch_safe",
  "args": {
    "id": "doc-id",
    "expectedRevision": 12,
    "mode": "replace",
    "patch": "# Title\n\nUpdated body safely"
  }
}
```

- Best practice (AI): read revision from `documents.info` immediately before patching and pass it as `expectedRevision`.
- Best practice (AI): on `code: "revision_conflict"`, re-read and regenerate patch intentionally instead of auto-retrying stale payloads.

## `documents.batch_update`

- Signature: `documents.batch_update(args: { updates: Array<{ id: string; expectedRevision?: number; title?: string; text?: string; editMode?: 'replace'|'append'|'prepend' }>; concurrency?: number; continueOnError?: boolean; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "documents.batch_update",
  "args": {
    "updates": [
      { "id": "doc-1", "title": "Renamed" },
      { "id": "doc-2", "text": "\n\nPatch", "editMode": "append" }
    ],
    "continueOnError": true,
    "concurrency": 2
  }
}
```

- Best practice (AI): include per-item `expectedRevision` for concurrency safety in multi-agent runs.

## `documents.delete`

- Signature: `documents.delete(args: { id: string; readToken: string; performAction?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "documents.delete",
  "args": {
    "id": "doc-id",
    "readToken": "<token from documents.info armDelete=true>",
    "performAction": true
  }
}
```

- Best practice (AI): read first with `documents.info` + `armDelete=true`, then delete with the returned read token and explicit `performAction=true`.

## `documents.permanent_delete` (optional wrapper)

- Signature: `documents.permanent_delete(args: { id: string; readToken: string; performAction?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "documents.permanent_delete",
  "args": {
    "id": "doc-id",
    "readToken": "<token from documents.info armDelete=true>",
    "performAction": true
  }
}
```

- Availability: optional wrapper; if unavailable in your build, use `api.call` with `method: "documents.permanent_delete"` and pass `readToken` at the top-level `api.call` args.
- Best practice (AI): treat this as irreversible destruction. Read immediately before execute (`documents.info` + `armDelete=true`) and use the token right away.
- Best practice (AI): do not reuse read tokens across delete stages. Issue a fresh token for each explicit delete/permanent-delete action.

## `documents.plan_batch_update`

- Signature: `documents.plan_batch_update(args: { id?: string; ids?: string[]; query?: string; queries?: string[]; collectionId?: string; rules?: Array<{ field?: 'title'|'text'|'both'; find: string; replace?: string; caseSensitive?: boolean; wholeWord?: boolean; all?: boolean }>; includeTitleSearch?: boolean; includeSemanticSearch?: boolean; limitPerQuery?: number; offset?: number; maxDocuments?: number; readConcurrency?: number; includeUnchanged?: boolean; hunkLimit?: number; hunkLineLimit?: number; maxAttempts?: number; })`
- Usage example:

```json
{
  "tool": "documents.plan_batch_update",
  "args": {
    "query": "incident communication",
    "rules": [
      {
        "field": "both",
        "find": "SEV1",
        "replace": "SEV-1",
        "wholeWord": true
      }
    ],
    "maxDocuments": 20
  }
}
```

- Best practice (AI): review `impacts` and `planHash` with the user before any apply call.

## `documents.apply_batch_plan`

- Signature: `documents.apply_batch_plan(args: { plan: object; confirmHash: string; dryRun?: boolean; continueOnError?: boolean; concurrency?: number; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean; })`
- Usage example:

```json
{
  "tool": "documents.apply_batch_plan",
  "args": {
    "confirmHash": "<planHash>",
    "plan": {
      "version": 1,
      "items": [
        {
          "id": "doc-id",
          "expectedRevision": 12,
          "title": "Renamed title"
        }
      ]
    }
  }
}
```

- Best practice (AI): use `dryRun=true` for final confirmation in automation loops, then execute with same `confirmHash`.

## `revisions.list`

- Signature: `revisions.list(args: { documentId: string; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; view?: 'summary'|'full' })`
- Usage example:

```json
{
  "tool": "revisions.list",
  "args": {
    "documentId": "doc-id",
    "limit": 10,
    "view": "summary"
  }
}
```

- Best practice (AI): capture revision IDs from list before restore.

## `revisions.restore`

- Signature: `revisions.restore(args: { id: string; revisionId: string; collectionId?: string; view?: 'summary'|'full'; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "revisions.restore",
  "args": {
    "id": "doc-id",
    "revisionId": "revision-id"
  }
}
```

- Best practice (AI): restore only after explicit target revision confirmation.

## `revisions.info`

- Signature: `revisions.info(args: { id: string; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "revisions.info",
  "args": {
    "id": "revision-id",
    "view": "full"
  }
}
```

- Best practice (AI): hydrate a specific revision from `revisions.list` before restore so recovery targets are explicit and auditable.

## `revisions.diff`

- Availability: optional UC-09 helper; contract may be unavailable in older deployments/builds.
- Signature: `revisions.diff(args: { id: string; baseRevisionId: string; targetRevisionId: string; includeFullHunks?: boolean; hunkLimit?: number; hunkLineLimit?: number })`
- Usage example:

```json
{
  "tool": "revisions.diff",
  "args": {
    "id": "doc-id",
    "baseRevisionId": "revision-base-id",
    "targetRevisionId": "revision-target-id",
    "hunkLimit": 8,
    "hunkLineLimit": 12
  }
}
```

- Best practice (AI): hydrate candidate revisions first (`revisions.info`) so the compared pair is explicit and auditable.
- Best practice (AI): keep hunk limits low for operator review loops, then re-run with fuller hunks only when needed.

## `shares.list`

- Signature: `shares.list(args?: { query?: string; documentId?: string; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; includePolicies?: boolean; view?: 'ids'|'summary'|'full'; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "shares.list",
  "args": {
    "documentId": "help-doc-id",
    "limit": 10,
    "view": "summary"
  }
}
```

- Best practice (AI): scope by `documentId` and start with `view: "summary"` to keep share inventory deterministic.

## `shares.info`

- Signature: `shares.info(args: { id?: string; documentId?: string; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "shares.info",
  "args": {
    "id": "share-id",
    "view": "full"
  }
}
```

- Best practice (AI): pass `id` when available; use `documentId` only when resolving current share state for a single doc.

## `shares.create`

- Signature: `shares.create(args: { documentId: string; includeChildDocuments?: boolean; published?: boolean; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "shares.create",
  "args": {
    "documentId": "help-doc-id",
    "published": false,
    "includeChildDocuments": true,
    "performAction": true,
    "view": "summary"
  }
}
```

- Best practice (AI): create with `published: false` first, verify scope/read behavior, then publish via `shares.update`.

## `shares.update`

- Signature: `shares.update(args: { id: string; includeChildDocuments?: boolean; published?: boolean; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "shares.update",
  "args": {
    "id": "share-id",
    "published": true,
    "includeChildDocuments": true,
    "performAction": true,
    "view": "summary"
  }
}
```

- Best practice (AI): always send explicit `published` and `includeChildDocuments` values to avoid accidental scope drift.

## `shares.revoke`

- Signature: `shares.revoke(args: { id: string; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "shares.revoke",
  "args": {
    "id": "share-id",
    "performAction": true
  }
}
```

- Best practice (AI): after revoke, run `documents.info` with the same `shareId` and require a denied/not-found result before considering revocation complete.

## `documents.templatize`

- Signature: `documents.templatize(args: { id: string; collectionId?: string | null; publish?: boolean; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "documents.templatize",
  "args": {
    "id": "doc-id",
    "performAction": true,
    "view": "summary"
  }
}
```

- Best practice (AI): run on a suite-owned canonical note document, then persist resulting `templateId` for later `documents.create`.

## `templates.extract_placeholders`

- Signature: `templates.extract_placeholders(args: { id: string; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "templates.extract_placeholders",
  "args": {
    "id": "template-id"
  }
}
```

- Best practice (AI): run immediately after `documents.templatize` (or template update) so placeholder key discovery stays deterministic.
- Best practice (AI): normalize keys to bare names (`service_name` vs `{{service_name}}`) before building `placeholderValues`.

## `documents.create_from_template`

- Signature: `documents.create_from_template(args: { templateId: string; title?: string; collectionId?: string; parentDocumentId?: string; publish?: boolean; placeholderValues?: Record<string, string>; strictPlaceholders?: boolean; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "documents.create_from_template",
  "args": {
    "templateId": "template-id",
    "title": "Billing API Release Checklist 2026-03-05",
    "placeholderValues": {
      "service_name": "Billing API",
      "owner": "Ops Duty Lead",
      "target_date": "2026-03-31"
    },
    "strictPlaceholders": true,
    "publish": false,
    "performAction": true,
    "view": "summary"
  }
}
```

- Best practice (AI): use `templates.extract_placeholders` first and pass a complete `placeholderValues` object.
- Best practice (AI): set `strictPlaceholders=true` in automation to fail fast on unresolved tokens.
- Best practice (AI): this tool is action-gated; set `performAction=true` only for the final create step.

## `templates.list`

- Signature: `templates.list(args?: { collectionId?: string; query?: string; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; includePolicies?: boolean; view?: 'ids'|'summary'|'full'; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "templates.list",
  "args": {
    "query": "meeting notes",
    "limit": 10,
    "view": "summary"
  }
}
```

- Best practice (AI): use summary/ids views first, then hydrate selected template IDs with `templates.info`.

## `templates.info`

- Signature: `templates.info(args: { id?: string; ids?: string[]; includePolicies?: boolean; concurrency?: number; view?: 'summary'|'full'; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "templates.info",
  "args": {
    "id": "template-id",
    "view": "full"
  }
}
```

- Best practice (AI): prefer batched `ids[]` hydration when validating multiple templates.

## `templates.create`

- Signature: `templates.create(args: { title: string; data: object; icon?: string; color?: string; collectionId?: string; fullWidth?: boolean; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "templates.create",
  "args": {
    "title": "Weekly Team Meeting",
    "data": {
      "text": "# Agenda\n\n## Decisions\n- Owner:\n- Due:"
    },
    "performAction": true
  }
}
```

- Best practice (AI): keep `data` minimal and deterministic; gate writes with explicit `performAction=true`.

## `templates.update`

- Signature: `templates.update(args: { id: string; title?: string; data?: object; icon?: string | null; color?: string | null; collectionId?: string | null; fullWidth?: boolean; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "templates.update",
  "args": {
    "id": "template-id",
    "title": "Weekly Team Meeting v2",
    "performAction": true
  }
}
```

- Best practice (AI): patch only changed fields to keep write payloads small and reviewable.

## `templates.delete`

- Signature: `templates.delete(args: { id: string; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "templates.delete",
  "args": {
    "id": "template-id",
    "performAction": true
  }
}
```

- Best practice (AI): delete only suite-created templates in test automation.

## `templates.restore`

- Signature: `templates.restore(args: { id: string; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "templates.restore",
  "args": {
    "id": "template-id",
    "performAction": true,
    "view": "summary"
  }
}
```

- Best practice (AI): use restore for controlled rollback after accidental template deletion.

## `templates.duplicate`

- Signature: `templates.duplicate(args: { id: string; title?: string; collectionId?: string | null; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "templates.duplicate",
  "args": {
    "id": "template-id",
    "title": "Weekly Team Meeting Copy",
    "performAction": true
  }
}
```

- Best practice (AI): duplicate then customize to preserve stable base templates.

## `comments.list`

- Signature: `comments.list(args?: { documentId?: string; collectionId?: string; parentCommentId?: string; includeAnchorText?: boolean; includeReplies?: boolean; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; includePolicies?: boolean; view?: 'ids'|'summary'|'full'; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "comments.list",
  "args": {
    "documentId": "doc-id",
    "limit": 20,
    "view": "summary"
  }
}
```

- Best practice (AI): scope by `documentId` in meeting-note workflows to keep review output deterministic.

## `comments.info`

- Signature: `comments.info(args: { id: string; includeAnchorText?: boolean; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "comments.info",
  "args": {
    "id": "comment-id",
    "view": "full"
  }
}
```

- Best practice (AI): hydrate individual comment records before moderation or deletion actions.

## `comments.create`

- Signature: `comments.create(args: { documentId: string; text?: string; data?: object; parentCommentId?: string; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "comments.create",
  "args": {
    "documentId": "doc-id",
    "text": "Decision rationale: lower migration risk.",
    "performAction": true
  }
}
```

- Best practice (AI): provide `text` for human-readable rationale threads; use `data` only when rich payloads are required.

## `comments.update`

- Signature: `comments.update(args: { id: string; text?: string; data?: object; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "comments.update",
  "args": {
    "id": "comment-id",
    "text": "Updated rationale after stakeholder review.",
    "performAction": true
  }
}
```

- Best practice (AI): update comment text in place to preserve thread continuity for decision history.

## `comments.delete`

- Signature: `comments.delete(args: { id: string; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "comments.delete",
  "args": {
    "id": "comment-id",
    "performAction": true
  }
}
```

- Best practice (AI): reserve deletes for invalid/noise comments; prefer edits for audit continuity.

## `events.list`

- Signature: `events.list(args?: { actorId?: string; documentId?: string; collectionId?: string; name?: string; auditLog?: boolean; ip?: string; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; includePolicies?: boolean; view?: 'ids'|'summary'|'full'; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "events.list",
  "args": {
    "documentId": "doc-id",
    "auditLog": true,
    "limit": 25,
    "sort": "createdAt",
    "direction": "DESC",
    "view": "summary"
  }
}
```

- Best practice (AI): use document/collection/actor filters to keep audit windows deterministic and token-efficient.
- Best practice (AI): treat empty/no-row responses as deployment-policy dependent and handle gracefully in live smoke checks.

## `data_attributes.list` (optional wrapper)

- Signature: `data_attributes.list(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "data_attributes.list",
  "args": {
    "limit": 50,
    "view": "summary"
  }
}
```

- Best practice (AI): discover taxonomy keys once, then cache IDs/names for downstream issue-link tagging workflows.
- Best practice (AI): if unavailable in your build, fallback to `api.call` with `method: "dataAttributes.list"`.

## `data_attributes.info` (optional wrapper)

- Signature: `data_attributes.info(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })`
- Usage example:

```json
{
  "tool": "data_attributes.info",
  "args": {
    "id": "data-attribute-id",
    "view": "summary"
  }
}
```

- Best practice (AI): hydrate attribute metadata before mutation to keep schema/value usage consistent.
- Best practice (AI): for batch hydration, use ids in stable chunks and low concurrency.

## `data_attributes.create` (optional wrapper)

- Signature: `data_attributes.create(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "data_attributes.create",
  "args": {
    "name": "linearIssueKey",
    "performAction": true,
    "view": "summary"
  }
}
```

- Best practice (AI): create only after checking list/info to prevent duplicate taxonomy entries.
- Best practice (AI): this tool is action-gated; set `performAction=true` only for explicit metadata writes.

## `data_attributes.update` (optional wrapper)

- Signature: `data_attributes.update(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "data_attributes.update",
  "args": {
    "id": "data-attribute-id",
    "name": "linearIssueKey",
    "performAction": true,
    "view": "summary"
  }
}
```

- Best practice (AI): mutate only changed fields to keep change reviews/audit trails concise.
- Best practice (AI): this tool is action-gated; set `performAction=true` only for explicit metadata writes.

## `data_attributes.delete` (optional wrapper)

- Signature: `data_attributes.delete(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "data_attributes.delete",
  "args": {
    "id": "data-attribute-id",
    "performAction": true
  }
}
```

- Best practice (AI): delete only after verifying no active issue-link workflows depend on the attribute.
- Best practice (AI): this tool is action-gated; set `performAction=true` only for explicitly confirmed deletes.

## `capabilities.map`

- Signature: `capabilities.map(args?: { includePolicies?: boolean; includeRaw?: boolean })`
- Usage example:

```json
{
  "tool": "capabilities.map",
  "args": {
    "includePolicies": true
  }
}
```

- Best practice (AI): treat mutation capability fields as evidence-based and potentially tri-state (`true`, `false`, `null` when unknown).

- Best practice (AI): call once before mutation planning; enable policies only when you need deeper authorization reasoning.

## `documents.cleanup_test`

- Signature: `documents.cleanup_test(args?: { markerPrefix?: string; olderThanHours?: number; dryRun?: boolean; maxPages?: number; pageLimit?: number; concurrency?: number; allowUnsafePrefix?: boolean; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "documents.cleanup_test",
  "args": {
    "markerPrefix": "outline-cli-live-test-",
    "olderThanHours": 24,
    "dryRun": true
  }
}
```

- Best practice (AI): run dry-run first and keep marker prefixes specific to your test suite.
