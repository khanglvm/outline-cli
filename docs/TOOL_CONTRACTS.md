# Tool Contracts

Each tool contract includes signature, usage example, and AI best practices.

Use CLI to get canonical JSON contracts:

```bash
outline-cli tools contract all --pretty
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

- Signature: `documents.list(args?: { limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; collectionId?: string; parentDocumentId?: string | null; userId?: string; statusFilter?: string[]; view?: 'ids'|'summary'|'full'; includePolicies?: boolean })`
- Usage example:

```json
{
  "tool": "documents.list",
  "args": {
    "collectionId": "6f35e6db-5930-4db8-9c31-66fe12f9f4aa",
    "limit": 20,
    "statusFilter": ["published"],
    "view": "summary"
  }
}
```

- Best practice (AI): page with small limits; avoid full view unless needed.

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

- Signature: `documents.apply_patch(args: { id: string; patch: string; mode?: 'unified'|'replace'; title?: string; view?: 'summary'|'full'; performAction?: boolean })`
- Usage example:

```json
{
  "tool": "documents.apply_patch",
  "args": {
    "id": "doc-id",
    "mode": "unified",
    "patch": "@@ -1,1 +1,1 @@\n-Old\n+New"
  }
}
```

- Best practice (AI): use unified patches for minimal edits; fallback to replace mode only when full rewrite is intended.

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
