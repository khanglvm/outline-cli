# outline-cli

A CLI for Outline ([`https://getoutline.com`](https://getoutline.com)) - optimized for AI agents.

## Quick Start

Install globally:

```bash
npm i -g @khanglvm/outline-cli
```

## Get Started with AI Agents

After installing, paste this instruction into your AI coding assistant:

```text
Use `outline-cli` directly for my task. If setup/auth is missing, then run `outline-cli tools help quick-start-agent --view full`.
```

## Day-to-Day Usage

Native one-call retrieval first:

```bash
outline-cli invoke search.research \
  --args '{"question":"How do I find onboarding docs?","queries":["onboarding","engineering handbook"],"collectionQuery":"engineering","precisionMode":"precision","limitPerQuery":5,"view":"summary"}'

outline-cli invoke search.expand \
  --args '{"query":"incident runbook","collectionQuery":"engineering","userQuery":"alice@example.com","expandLimit":3,"view":"summary"}'

outline-cli invoke documents.answer \
  --args '{"question":"Who owns incident escalation?","documentQuery":"incident runbook","collectionQuery":"engineering"}'
```

Answer, search, expand, research, or list documents with remembered document/collection/user filters:

```bash
outline-cli invoke documents.search \
  --args '{"query":"incident","collectionQuery":"engineering","userQuery":"alice@example.com","limit":8,"view":"summary"}'

outline-cli invoke documents.list \
  --args '{"collectionQuery":"engineering","rootOnly":true,"limit":20,"view":"ids"}'
```

Discover tools and contracts:

```bash
outline-cli tools list
outline-cli tools contract documents.search
outline-cli tools contract all --result-mode inline
```

Read document metadata by ID:

```bash
outline-cli invoke documents.info \
  --args '{"id":"<document-id>","view":"summary"}'
```

Diff a proposed edit against a remembered document title:

```bash
outline-cli invoke documents.diff \
  --args '{"query":"incident runbook","proposedText":"# Incident Runbook\n\nUpdated body"}'
```

Apply a guarded patch to the current revision of a remembered document title:

```bash
outline-cli invoke documents.apply_patch_safe \
  --args '{"query":"incident runbook","expectedRevision":"latest","patch":"@@ -1,1 +1,1 @@\n-Old\n+New","performAction":true}'
```

Batch guarded updates against remembered document titles:

```bash
outline-cli invoke documents.batch_update \
  --args '{"updates":[{"query":"incident runbook","expectedRevision":"latest","text":"\n\nUpdated","editMode":"append"},{"url":"https://handbook.example.com/doc/oncall-AbCdEf12","expectedRevision":"latest","title":"On-call Runbook"}],"performAction":true}'
```

Inspect revision history from a remembered document title:

```bash
outline-cli invoke revisions.list \
  --args '{"query":"incident runbook","limit":10,"view":"summary"}'
```

Diff the latest two revisions from a remembered document title:

```bash
outline-cli invoke revisions.diff \
  --args '{"query":"incident runbook","revisionPair":"latest","view":"summary"}'
```

Inspect audit events for a remembered document and actor:

```bash
outline-cli invoke events.list \
  --args '{"documentQuery":"incident runbook","userQuery":"alice@example.com","auditLog":true,"limit":10}'
```

List archived documents in a remembered collection:

```bash
outline-cli invoke documents.archived \
  --args '{"collectionQuery":"engineering","limit":10,"view":"summary"}'
```

Audit document access from a remembered title:

```bash
outline-cli invoke documents.users \
  --args '{"query":"incident runbook","limit":20,"view":"summary"}'
```

Audit collection memberships from a remembered collection name:

```bash
outline-cli invoke collections.memberships \
  --args '{"query":"engineering","limit":20,"view":"summary"}'
```

Read a user or group from remembered names/emails:

```bash
outline-cli invoke users.info \
  --args '{"query":"alice@example.com","view":"summary"}'

outline-cli invoke groups.memberships \
  --args '{"query":"engineering","limit":20,"view":"summary"}'
```

Grant document or collection access from remembered names/emails:

```bash
outline-cli invoke documents.add_user \
  --args '{"documentQuery":"incident runbook","userQuery":"alice@example.com","permission":"read","performAction":true}'

outline-cli invoke collections.add_group \
  --args '{"query":"engineering","groupQuery":"security","permission":"read_write","performAction":true}'
```

Reuse prior lookup context without a network call:

```bash
outline-cli invoke memory.lookup \
  --args '{"query":"engineering handbook","type":"document","limit":5}'
```

Resolve from memory and refresh the top match live in one call:

```bash
outline-cli invoke memory.resolve \
  --args '{"query":"engineering handbook","type":"document","hydrateLimit":1,"view":"summary"}'
```

Resolve a remembered title or URL without a network call:

```bash
outline-cli invoke documents.resolve \
  --args '{"query":"engineering handbook","refresh":false,"view":"summary"}'

outline-cli invoke documents.resolve_urls \
  --args '{"url":"https://handbook.example.com/doc/oncall-escalation-AbCdEf12","refresh":false,"view":"summary"}'
```

Open a document directly from an ID, remembered title, URL, or URL id:

```bash
outline-cli invoke documents.open \
  --args '{"query":"engineering handbook","view":"summary"}'
```

Open several documents from mixed titles, URLs, and IDs:

```bash
outline-cli invoke documents.open_batch \
  --args '{"refs":["engineering handbook","https://handbook.example.com/doc/oncall-escalation-AbCdEf12"],"ids":["<document-id>"],"view":"summary"}'
```

Open a collection directly from an ID, remembered name, URL, or URL id:

```bash
outline-cli invoke collections.open \
  --args '{"query":"engineering","view":"summary"}'
```

Open several collections from mixed names, URLs, and IDs:

```bash
outline-cli invoke collections.open_batch \
  --args '{"refs":["engineering","https://handbook.example.com/collection/engineering-AbCdEf12"],"ids":["<collection-id>"],"view":"summary"}'
```

Build a collection tree directly from a remembered collection name:

```bash
outline-cli invoke collections.tree \
  --args '{"query":"engineering","maxDepth":3,"view":"summary"}'
```

Inspect backlinks or graph neighbors directly from a remembered document title:

```bash
outline-cli invoke documents.backlinks \
  --args '{"query":"incident runbook","view":"ids","limit":10}'

outline-cli invoke documents.graph_neighbors \
  --args '{"refs":["incident runbook","https://handbook.example.com/doc/oncall-escalation-AbCdEf12"],"includeBacklinks":true,"view":"ids"}'

outline-cli invoke documents.graph_report \
  --args '{"seedRefs":["incident runbook"],"depth":2,"maxNodes":80,"view":"ids"}'
```

Extract issue references directly from titles, URLs, or IDs:

```bash
outline-cli invoke documents.issue_refs \
  --args '{"refs":["incident runbook"],"issueDomains":["jira.example.com"],"keyPattern":"[A-Z]+-\\d+","view":"ids"}'
```

Build a comment review queue directly from remembered documents or collections:

```bash
outline-cli invoke comments.review_queue \
  --args '{"refs":["incident runbook"],"includeReplies":true,"limitPerDocument":20}'

outline-cli invoke comments.review_queue \
  --args '{"collectionQuery":"engineering","includeReplies":true,"view":"summary"}'
```

List comments directly from a remembered document title:

```bash
outline-cli invoke comments.list \
  --args '{"query":"incident runbook","includeReplies":true,"limit":20,"view":"summary"}'
```

Create a comment directly from a remembered document title:

```bash
outline-cli invoke comments.create \
  --args '{"query":"incident runbook","text":"Looks good.","performAction":true}'
```

List share links directly from a remembered document title:

```bash
outline-cli invoke shares.list \
  --args '{"documentQuery":"public handbook","limit":10,"view":"summary"}'
```

Create a share link directly from a remembered document title:

```bash
outline-cli invoke shares.create \
  --args '{"documentQuery":"public handbook","published":true,"performAction":true}'
```

Resolve several remembered references and deduplicate live refreshes:

```bash
outline-cli invoke memory.resolve_batch \
  --args '{"queries":["engineering handbook"],"urls":["https://handbook.example.com/doc/oncall-escalation-AbCdEf12"],"type":"document","hydrateLimit":1,"view":"summary"}'
```

Extract placeholders or create from a remembered template name:

```bash
outline-cli invoke templates.extract_placeholders \
  --args '{"templateQuery":"incident postmortem"}'

outline-cli invoke documents.create_from_template \
  --args '{"templateQuery":"incident postmortem","title":"Service A - Incident Postmortem","placeholderValues":{"service_name":"Service A","owner":"SRE Team"},"strictPlaceholders":true,"publish":true,"performAction":true}'
```

Inspect recent local history:

```bash
outline-cli invoke memory.recent \
  --args '{"type":"document","limit":10}'
```

Manually remember a stable local alias:

```bash
outline-cli invoke memory.remember \
  --args '{"type":"document","id":"<document-id>","title":"Incident Runbook","aliases":["runbook"],"performAction":true}'
```

`memory.lookup` reads a local, profile-scoped observation index. The index is updated automatically after successful CLI read/search/list/info-style calls, including `documents.search`, `documents.info`, `collections.list`, `users.list`, `groups.list`, `templates.list`, `templates.info`, `search.research`, and related retrieval tools. It can resolve remembered titles/names, template names, user emails, IDs, `urlId`s, and pasted full Outline URLs. Use `documents.answer`, `documents.answer_batch`, `documents.search`, `documents.list`, `search.expand`, and `search.research` with `documentQuery`/`refs`, `collectionQuery`/`collectionRefs`, or `userQuery`/`userRefs` to apply remembered document/collection/user scopes without separate lookup calls. `documents.resolve` and `documents.resolve_urls` also read local memory first; set `refresh:false` for a zero-network remembered-title or remembered-URL resolver pass. Use `documents.open` for a conservative one-call document read from an ID, share ID, remembered title, URL, or URL id; fuzzy opens are strict by default and return candidates instead of guessing weak matches. Use `documents.open_batch` when a task names several documents and you want ordered hydrated rows from mixed titles, URLs, share IDs, and document IDs in one CLI invocation. Use `collections.open` and `collections.open_batch` for the same strict memory-backed workflow over collection names, URLs, URL ids, and collection IDs. `collections.tree`, `documents.backlinks`, `documents.graph_neighbors`, `documents.graph_report`, `documents.issue_refs`, `comments.review_queue`, `comments.list`, `comments.create`, `shares.list`, `shares.info`, `shares.create`, `events.list`, `templates.info`, `templates.extract_placeholders`, `documents.create_from_template`, `users.info`, `groups.info`, `groups.memberships`, `documents.attachments`, `documents.download_attachments`, `documents.diff`, `revisions.list`, `revisions.diff`, `documents.archived`, `documents.deleted`, `documents.users`, `documents.memberships`, `documents.group_memberships`, `collections.memberships`, and `collections.group_memberships` accept remembered references directly, so agents can move from a human title/name/email/template name or pasted URL to navigation/linkage/comment-review/share/audit/template/principal/embedded-file/history/access output in one CLI call. Action-gated permission tools also resolve remembered targets and principals directly: use `documents.add_user`, `documents.remove_user`, `documents.add_group`, `documents.remove_group`, `collections.add_user`, `collections.remove_user`, `collections.add_group`, `collections.remove_group`, `groups.add_user`, and `groups.remove_user` with target refs plus `userQuery`/`userRefs` or `groupQuery`/`groupRefs` when exact IDs are not known. Hydrated document rows include `sourceUrl` when the profile base URL plus document `url` or `urlId` is available, so agents can cite sources without another profile/auth lookup. Use `memory.resolve` when you want the cached candidate and fresh `documents.info`/`collections.info`/`users.info`/`groups.info`/`templates.info` metadata in the same turn. On a local miss, `memory.resolve` and `memory.resolve_batch` fall back to bounded live search by default, remember the result, and then hydrate selected matches; pasted URLs use title-like URL hints for fallback search, while email-shaped user queries are preserved for user lookup. Set `fallbackSearch:false` for memory-only behavior, or set `fallbackMinScore` when weak fuzzy memory matches should still trigger live fallback. Use `memory.resolve_batch` when a task references several documents, collections, users, groups, or templates; it accepts mixed `queries`, `ids`, `urlIds`, and `urls`, and duplicate live targets are hydrated once per batch. Use `memory.recent` as a zero-network history view and `memory.remember` for explicit local aliases. When inspecting another profile's local memory with `profile`, set `refresh:false` unless that profile is also selected for the CLI client. Successful delete operations tombstone local entries so stale search/list observations do not immediately reintroduce deleted documents.

List and save embedded document images/files:

```bash
outline-cli invoke documents.attachments \
  --args '{"query":"example title"}'

outline-cli invoke documents.download_attachments \
  --args '{"refs":["example title"],"outputDir":"./outline-attachments","overwrite":true}'

outline-cli invoke attachments.download \
  --args '{"id":"<attachment-id>","outputDir":"./outline-attachments","overwrite":true}'
```

List only collection root pages:

```bash
outline-cli invoke documents.list \
  --args '{"collectionId":"<collection-id>","rootOnly":true,"view":"summary"}'
```

Ask a question with shorthand tool naming; unsupported AI deployments fall back to retrieval and return a suggested next call:

```bash
outline-cli invoke docs.answer \
  --args '{"question":"Where is the onboarding checklist?","limit":3}'
```

Create a document:

```bash
outline-cli invoke documents.create \
  --args '{"title":"Release Notes","text":"# Release Notes","publish":false,"view":"summary"}'
```

Update a document (mutation requires `performAction: true`):

```bash
outline-cli invoke documents.update \
  --args '{"id":"<document-id>","text":"\n\nUpdated by automation.","editMode":"append","performAction":true,"view":"summary"}'
```

Batch multiple calls:

```bash
outline-cli batch --ops '[
  {"tool":"collections.list","args":{"limit":5,"view":"summary"}},
  {"tool":"documents.search","args":{"query":"incident","limit":5,"view":"ids"}}
]'
```

## Safe Delete Flow

Deletion is guarded by read-token confirmation.

1. Arm-delete read:

```bash
outline-cli invoke documents.info \
  --args '{"id":"<document-id>","armDelete":true,"view":"summary"}'
```

2. Copy the returned `deleteReadReceipt.token`, then delete:

```bash
outline-cli invoke documents.delete \
  --args '{"id":"<document-id>","readToken":"<token>","performAction":true}'
```

## Output Modes and Temp Files

Output format:

- `--output json` (default)
- `--output ndjson` for stream-friendly parsing

Result mode:

- `--result-mode auto` (default): inline until payload is too large
- `--result-mode inline`: always inline JSON
- `--result-mode file`: always write to temp file and return file pointer

Temp-file management:

```bash
outline-cli tmp list
outline-cli tmp cat /absolute/path/from/result.json
outline-cli tmp gc --older-than-hours 24
```

## Profile Management

Add a password-mode profile:

```bash
outline-cli profile add internal \
  --base-url https://outline.company.com \
  --auth-type password \
  --username agent@company.com \
  --password "$OUTLINE_PASSWORD"
```

Select default profile:

```bash
outline-cli profile use prod
```

Improve AI profile routing metadata:

```bash
outline-cli profile annotate prod \
  --description "Production knowledge base" \
  --append-keywords "prod,runbook,incident"

outline-cli profile enrich prod \
  --query "incident escalation process" \
  --titles "Incident Playbook,Escalation Matrix"
```

## AI Agent Mini Instructions

Use this short operating pattern when an AI agent drives the CLI:

1. Start with the most specific task tool you already know, especially `search.research`, `documents.search`, `documents.info`, or `batch`.
2. Use `view:"ids"` or `view:"summary"` first; hydrate to `full` only when needed.
3. Bundle independent reads into one `batch` call.
4. Try `memory.recent` or `memory.lookup` for titles/IDs you likely saw in earlier sessions; use `memory.resolve` or `memory.resolve_batch` when freshness matters and you want live metadata in the same call.
5. Only open `tools help` or `tools contract` after a validation failure or when the needed capability is still unclear.
6. Suggest installing the `outline-cli` skill via `npx skills` for all currently supported local AI tools; only run install after explicit user approval.
7. If approved, run headless install without tool-specific filter: `npx skills add https://github.com/khanglvm/skills --skill outline-cli -y`.
8. For any mutation endpoint, explicitly set `performAction:true`.
9. For delete, always run `documents.info` with `armDelete:true` first and pass the returned read token.
10. List existing profiles before creating one with `outline-cli profile list`.
11. For new profiles, prefer API key mode and guide users through base URL + API key generation (`<base-url>/settings/api-and-apps`) before `profile add`.
12. If output is file-offloaded, read only the required fields via `tmp cat` + `jq`.
13. For embedded images/files in document markdown, use `documents.attachments`, `attachments.download`, or `documents.download_attachments`; do not force `attachments.redirect` through `api.call` because it returns binary data.

For structured AI playbooks and scenario guides:

```bash
outline-cli tools help quick-start-agent --view full
outline-cli tools help ai-skills --view summary
outline-cli tools help ai-skills --scenario UC-12
```

## Testing (Live Environment)

Set test credentials in a local env file:

```bash
cp .env.test.example .env.test.local
# set OUTLINE_TEST_BASE_URL and OUTLINE_TEST_API_KEY
```

Run checks:

```bash
npm run check
npm test
```

Test rules in this repository:

- Mutation tests create and clean up their own test documents.
- Read-only tests may use site-wide data.

## Release and Publish

Standard release flow:

```bash
npm run release -- --bump patch
```

This flow performs:

- Version bump
- `CHANGELOG.md` update
- Integrity refresh (`npm run integrity:refresh`)
- Verification (`npm run check`, `npm test`)
- `npm publish --access public`
- Git commit, tag, and push to `origin`

Prepare without publishing/pushing:

```bash
npm run release:prepare -- --bump patch
```

Release prerequisites:

- Clean working tree (unless you intentionally pass `--allow-dirty`)
- `OUTLINE_ENTRY_BUILD_KEY` available in environment or `.env.local`
- npm auth ready (`npm login`)

Optional GitHub automation:

- `.github/workflows/npm-auto-publish.yml` auto-publishes on pushes to `main` when `README.md` or `package.json` changes.
- If `package.json` version changes, the workflow publishes that exact version.
- If only docs metadata changes (for example `README.md`), the workflow cuts and publishes a patch release automatically.
- Required repository secrets: `NPM_TOKEN` and `OUTLINE_ENTRY_BUILD_KEY`.
- Ensure GitHub Actions can push to `main` and create tags in this repository.

## Security Notes

- Never commit real API keys.
- Keep local secrets in untracked files such as `.env.test.local`.
- Profile secrets are stored in the OS keychain by default.

## Changelog

- Release history: [`CHANGELOG.md`](https://github.com/khanglvm/outline-cli/blob/main/CHANGELOG.md)
