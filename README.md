# outline-cli

Agent-optimized Node.js CLI for Outline API.

- `npx` runnable
- multi-profile / multi-instance support
- profile auth modes: API key or username/password
- high-level tools for search, list, read, create, update
- batch invoke in one CLI call
- automatic large-response offload to managed temp files
- built-in tool contracts for AI agents

## Install / Run

From this repo:

```bash
npm install
npx ./bin/outline-cli.js --help
```

Or when published:

```bash
npx @khanglvm/outline-cli --help
npx outline-cli --help
```

## Live Test Suite (Real Outline)

This repo includes a real integration suite (no mocks) that runs against an actual Outline instance.

Setup local test env:

```bash
cp .env.test.example .env.test.local
# then set OUTLINE_TEST_BASE_URL and OUTLINE_TEST_API_KEY
```

Run tests:

```bash
npm test
```

Test safety rule implemented by suite:

- Any write/edit/delete test only touches a test document created by the suite itself.
- Search/list/read-only tests are allowed on site-wide documents.

## Release / Deployment

Use the built-in release workflow:

```bash
# patch release
npm run release -- --bump patch

# explicit version
npm run release -- --version 0.2.0
```

Prepare-only (no publish / no push):

```bash
npm run release:prepare -- --bump minor
```

Release script behavior (`scripts/release.mjs`):

- validates clean git tree (unless `--allow-dirty`)
- bumps version (`npm version --no-git-tag-version`)
- updates `CHANGELOG.md` from git commits since latest semver tag
- refreshes entry integrity artifacts (`npm run integrity:refresh`)
- runs `npm run check` and `npm test` (unless skipped)
- validates package with `npm pack --dry-run`
- commits and tags release (`chore(release): vX.Y.Z`, tag `vX.Y.Z`)
- publishes to npm (`npm publish --access public`) unless `--no-publish`
- pushes branch and tag to `origin` unless `--no-push`

Prerequisites:

- `npm login` already completed
- `OUTLINE_ENTRY_BUILD_KEY` set in environment or `.env.local`
- git remote `origin` is configured and writable

## Profile Setup

### API key profile (recommended for Outline public API)

```bash
npx ./bin/outline-cli.js profile add prod \
  --base-url https://app.getoutline.com \
  --api-key "$OUTLINE_API_KEY"
```

### Username/password profile

```bash
npx ./bin/outline-cli.js profile add internal \
  --base-url https://outline.company.com \
  --auth-type password \
  --username agent@company.com \
  --password "$OUTLINE_PASSWORD"
```

Set default profile explicitly when needed:

```bash
npx ./bin/outline-cli.js profile use prod
# or during add:
npx ./bin/outline-cli.js profile add prod ... --set-default
```

Optional token exchange for `password` mode:

```bash
npx ./bin/outline-cli.js profile add internal \
  --base-url https://outline.company.com \
  --auth-type password \
  --username agent@company.com \
  --password "$OUTLINE_PASSWORD" \
  --token-endpoint https://outline.company.com/oauth/token \
  --token-field access_token \
  --token-body '{"grant_type":"password"}'
```

### Profile selection rules

- Runtime commands resolve profile in this order:
  1. `--profile <id>`
  2. configured default profile (`profile use <id>` or `profile add ... --set-default`)
  3. fallback only when exactly one profile exists
- If multiple profiles exist and no default is set, runtime commands must include `--profile <id>` (otherwise CLI returns an error).
- `profile add` does not auto-set default profile unless `--set-default` is passed.

### OS keychain storage (default)

Credential secrets (`apiKey` / `password`) are stored in OS keychain via `@napi-rs/keyring`.

- Profile config keeps metadata only (`credentialRef`), not raw secrets.
- On macOS, approve once and click `Always Allow` for stable CLI access.
- Entry command remains `outline-cli`.

Keychain mode control:

```bash
# default: required
export OUTLINE_CLI_KEYCHAIN_MODE=required

# fallback to inline secret when keychain is unavailable
export OUTLINE_CLI_KEYCHAIN_MODE=optional

# disable keychain (for headless CI/tests only)
export OUTLINE_CLI_KEYCHAIN_MODE=disabled
```

### Build-time entry/submodule integrity binding

Set a strong build key and refresh integrity artifacts before publish:

```bash
echo "OUTLINE_ENTRY_BUILD_KEY=$(openssl rand -base64 48)" >> .env.local
set -a; source .env.local; set +a
npm run integrity:refresh
```

At runtime the entry validates submodule hashes against this build-time signature and fails fast on mismatch.

## Agent-Focused Usage

### 1. Discover tool contracts

```bash
npx ./bin/outline-cli.js tools contract all --pretty
```

### 2. Single-tool invoke

```bash
npx ./bin/outline-cli.js invoke documents.search \
  --args '{
    "queries": ["incident process", "oncall runbook"],
    "mode": "semantic",
    "limit": 6,
    "view": "summary",
    "merge": true
  }'
```

### 3. Batch invoke (multiple tools in one CLI call)

```bash
npx ./bin/outline-cli.js batch --ops '[
  {"tool":"collections.list","args":{"limit":10,"view":"summary"}},
  {"tool":"documents.search","args":{"query":"SLO","limit":5,"view":"ids"}}
]'
```

By default, `batch` uses compact per-item payloads (token-efficient). Use full envelopes when needed:

```bash
npx ./bin/outline-cli.js batch --item-envelope full --ops '[
  {"tool":"auth.info","args":{"view":"summary"}}
]'
```

NDJSON output mode for batch/list-style parsing:

```bash
npx ./bin/outline-cli.js batch --output ndjson --ops '[
  {"tool":"auth.info","args":{"view":"summary"}},
  {"tool":"collections.list","args":{"limit":5,"view":"summary"}}
]'
```

If NDJSON payload is too large and `--result-mode auto|file` is active, output switches to file-pointer NDJSON lines (`type: "file"`).

### 4. Long-response handling (auto temp-file offload)

If response exceeds `--inline-max-bytes` (default `12000`), CLI returns a file pointer instead of streaming full content.

```bash
npx ./bin/outline-cli.js tools contract all --inline-max-bytes 500
# -> {"stored":true,"file":"/.../tmp/...json",...}

npx ./bin/outline-cli.js tmp list
cat /absolute/path/from/result.json | jq '.contract[0]'
```

### 5. Resolve + expand in one agent loop

```bash
npx ./bin/outline-cli.js invoke documents.resolve \
  --args '{"queries":["incident handbook","oncall escalation"],"view":"summary","limit":6}'

npx ./bin/outline-cli.js invoke search.expand \
  --args '{"query":"incident handbook","mode":"semantic","limit":8,"expandLimit":3,"view":"summary"}'
```

For deeper multi-turn research across many docs with evidence merge + follow-up cursor:

```bash
npx ./bin/outline-cli.js invoke search.research \
  --args '{
    "question":"How do incident communication and escalation work?",
    "queries":["incident comms","escalation matrix"],
    "limitPerQuery":8,
    "expandLimit":5,
    "maxDocuments":20,
    "view":"summary"
  }'
```

### 6. Collection hierarchy traversal

```bash
npx ./bin/outline-cli.js invoke collections.tree \
  --args '{"collectionId":"<collection-id>","includeDrafts":false,"maxDepth":4,"view":"summary"}'
```

### 7. Internal FAQ playbook (UC-04)

Use an ids/summary-first loop, then call answer wrappers on narrowed scope.

```bash
# 1) Resolve FAQ collection ids
npx ./bin/outline-agent.js invoke collections.list \
  --args '{"query":"faq","limit":10,"view":"ids"}'

# 2) Resolve candidate FAQ docs with ids first
npx ./bin/outline-agent.js invoke documents.search \
  --args '{"query":"vpn reset","mode":"semantic","limit":8,"view":"ids","collectionId":"<collection-id>"}'

# 3) Hydrate only selected ids as summaries
npx ./bin/outline-agent.js invoke documents.info \
  --args '{"ids":["<doc-id-1>","<doc-id-2>"],"view":"summary","concurrency":2}'

# 4) Ask one question with deterministic answer envelope
npx ./bin/outline-agent.js invoke documents.answer \
  --args '{"question":"How do I reset VPN?","collectionId":"<collection-id>","view":"summary","includeEvidenceDocs":true}'

# 5) Ask repeated questions in one call (per-item isolation)
npx ./bin/outline-agent.js invoke documents.answer_batch \
  --args '{"questions":["How do I reset VPN?","Who approves expense exceptions?"],"collectionId":"<collection-id>","concurrency":2,"view":"summary","includeEvidenceDocs":true}'

# 6) Debug visibility issues for missing answers
npx ./bin/outline-agent.js invoke documents.memberships \
  --args '{"id":"<doc-id>","limit":20,"view":"summary"}'
npx ./bin/outline-agent.js invoke collections.memberships \
  --args '{"id":"<collection-id>","limit":20,"view":"summary"}'
```

### 8. Public help docs sharing playbook (UC-05)

Publish/revoke public help docs with a deterministic share lifecycle on a known document id.

```bash
# 1) Create a share in unpublished state (safe default)
npx ./bin/outline-cli.js invoke shares.create \
  --args '{"documentId":"<help-doc-id>","published":false,"includeChildDocuments":true,"performAction":true,"view":"summary"}'

# 2) Publish the share once link scope is confirmed
npx ./bin/outline-cli.js invoke shares.update \
  --args '{"id":"<share-id>","published":true,"includeChildDocuments":true,"performAction":true,"view":"summary"}'

# 3) Verify share metadata + read through share context
npx ./bin/outline-cli.js invoke shares.info \
  --args '{"id":"<share-id>","view":"full"}'
npx ./bin/outline-cli.js invoke documents.info \
  --args '{"shareId":"<share-id>","view":"summary"}'
npx ./bin/outline-cli.js invoke documents.search \
  --args '{"query":"help landing","mode":"titles","shareId":"<share-id>","limit":5,"view":"summary"}'

# 4) Revoke and confirm public access no longer works
npx ./bin/outline-cli.js invoke shares.revoke \
  --args '{"id":"<share-id>","performAction":true}'
npx ./bin/outline-cli.js invoke documents.info \
  --args '{"shareId":"<share-id>","view":"summary"}'
# expected: API error (forbidden/not_found) after revoke propagation
```

### 9. Department-space visibility playbook (UC-06)

Deterministic operator flow for role-based department spaces: `discover -> grant/check -> audit`.

```bash
# 1) Discover users, groups, and department collection targets
npx ./bin/outline-cli.js invoke users.list \
  --args '{"limit":20,"view":"summary"}'
npx ./bin/outline-cli.js invoke users.info \
  --args '{"id":"<user-id>","view":"summary"}'
npx ./bin/outline-cli.js invoke groups.list \
  --args '{"limit":20,"view":"summary"}'
npx ./bin/outline-cli.js invoke groups.info \
  --args '{"id":"<group-id>","view":"summary"}'
npx ./bin/outline-cli.js invoke collections.list \
  --args '{"query":"department","limit":20,"view":"summary"}'

# 2) Grant access and verify read-path visibility
npx ./bin/outline-cli.js invoke groups.add_user \
  --args '{"id":"<group-id>","userId":"<user-id>","performAction":true}'
npx ./bin/outline-cli.js invoke collections.add_group \
  --args '{"id":"<collection-id>","groupId":"<group-id>","performAction":true}'
npx ./bin/outline-cli.js invoke collections.group_memberships \
  --args '{"id":"<collection-id>","limit":50,"view":"summary"}'
npx ./bin/outline-cli.js invoke documents.group_memberships \
  --args '{"id":"<doc-id>","limit":50,"view":"summary"}'

# Optional (depends on build): group member listing wrapper
npx ./bin/outline-cli.js invoke groups.memberships \
  --args '{"id":"<group-id>","limit":50,"view":"summary"}'
# Fallback when wrapper is unavailable:
npx ./bin/outline-cli.js invoke api.call \
  --args '{"method":"groups.memberships","body":{"id":"<group-id>","limit":50,"offset":0}}'

# 3) Audit and revoke when access should be removed
npx ./bin/outline-cli.js invoke collections.memberships \
  --args '{"id":"<collection-id>","limit":50,"view":"summary"}'
npx ./bin/outline-cli.js invoke documents.memberships \
  --args '{"id":"<doc-id>","limit":50,"view":"summary"}'
npx ./bin/outline-cli.js invoke collections.remove_group \
  --args '{"id":"<collection-id>","groupId":"<group-id>","performAction":true}'
npx ./bin/outline-cli.js invoke groups.remove_user \
  --args '{"id":"<group-id>","userId":"<user-id>","performAction":true}'
```

### 10. Project docs + issue tracker linkage (UC-07)

Deterministic loop: `discover -> extract refs -> report -> hydrate -> patch -> audit`.

```bash
# 1) Discover docs that already mention the issue token/key
npx ./bin/outline-cli.js invoke documents.search \
  --args '{"query":"ENG-4312","mode":"titles","limit":10,"view":"ids"}'

# 2) Extract normalized issue references from explicit docs
npx ./bin/outline-cli.js invoke documents.issue_refs \
  --args '{"ids":["<doc-id-1>","<doc-id-2>"],"issueDomains":["linear.app"],"view":"summary"}'

# 3) Run a query-scoped issue-reference report (summary-first)
npx ./bin/outline-cli.js invoke documents.issue_ref_report \
  --args '{"query":"ENG-4312","collectionId":"<collection-id>","limit":10,"view":"summary"}'

# 4) Resolve fuzzy references, then hydrate only selected docs
npx ./bin/outline-cli.js invoke documents.resolve \
  --args '{"query":"ENG-4312","limit":8,"view":"summary"}'
npx ./bin/outline-cli.js invoke documents.info \
  --args '{"ids":["<doc-id-1>","<doc-id-2>"],"view":"summary","concurrency":2}'

# 5) Patch the target project doc with deterministic issue references
npx ./bin/outline-cli.js invoke documents.update \
  --args '{"id":"<project-doc-id>","text":"\n\n## Issue links\n- Linear: ENG-4312\n- URL: https://linear.app/acme/issue/eng-4312","editMode":"append","performAction":true,"view":"summary"}'

# 6) Traverse internal backlinks (which docs reference the project doc)
npx ./bin/outline-cli.js invoke documents.list \
  --args '{"backlinkDocumentId":"<project-doc-id>","limit":20,"view":"summary"}'

# 7) Audit update context through workspace events
npx ./bin/outline-cli.js invoke events.list \
  --args '{"documentId":"<project-doc-id>","auditLog":true,"limit":25,"sort":"createdAt","direction":"DESC","view":"summary"}'

# Optional metadata taxonomy flow (if data_attributes wrappers are enabled in your build)
npx ./bin/outline-cli.js invoke data_attributes.list \
  --args '{"limit":50,"view":"summary"}'
npx ./bin/outline-cli.js invoke data_attributes.create \
  --args '{"name":"linearIssueKey","performAction":true,"view":"summary"}'
```

### 11. Cross-linked knowledge graph playbook (UC-10)

Deterministic loop: `seed linked docs -> backlinks -> neighbors/report -> hydrate bounded nodes`.

```bash
# 1) Seed linked graph docs (A <- B, A <- C, plus A -> B)
npx ./bin/outline-cli.js invoke documents.create \
  --args '{"title":"uc10-A","text":"# uc10-A","publish":false,"view":"summary"}'
npx ./bin/outline-cli.js invoke documents.info \
  --args '{"id":"<doc-a-id>","view":"full"}'
npx ./bin/outline-cli.js invoke documents.create \
  --args '{"title":"uc10-B","text":"# uc10-B\n\n- Link to A: [uc10-A](<doc-a-url>)","publish":false,"view":"summary"}'
npx ./bin/outline-cli.js invoke documents.info \
  --args '{"id":"<doc-b-id>","view":"full"}'
npx ./bin/outline-cli.js invoke documents.update \
  --args '{"id":"<doc-a-id>","text":"\n\n- Link to B: [uc10-B](<doc-b-url>)","editMode":"append","performAction":true,"view":"summary"}'
npx ./bin/outline-cli.js invoke documents.create \
  --args '{"title":"uc10-C","text":"# uc10-C\n\n- Link to A: [uc10-A](<doc-a-url>)\n- Link to B: [uc10-B](<doc-b-url>)","publish":false,"view":"summary"}'

# 2) Backlink referrers for seed doc A (preferred wrapper + fallback)
npx ./bin/outline-cli.js invoke documents.backlinks \
  --args '{"id":"<doc-a-id>","limit":50,"view":"summary"}'
npx ./bin/outline-cli.js invoke documents.list \
  --args '{"backlinkDocumentId":"<doc-a-id>","limit":50,"view":"summary"}'

# 3) Expand immediate graph neighbors (normalized edges)
npx ./bin/outline-cli.js invoke documents.graph_neighbors \
  --args '{"id":"<doc-a-id>","includeBacklinks":true,"includeSearchNeighbors":false,"limitPerSource":10,"view":"summary"}'

# 4) Generate bounded traversal report for automation-safe fan-out
npx ./bin/outline-cli.js invoke documents.graph_report \
  --args '{"seedIds":["<doc-a-id>"],"depth":1,"maxNodes":25,"includeBacklinks":true,"includeSearchNeighbors":false}'

# 5) Hydrate only bounded node ids from the report for downstream processing
npx ./bin/outline-cli.js invoke documents.info \
  --args '{"ids":["<node-id-1>","<node-id-2>"],"view":"summary","concurrency":2}'
```

### 12. Safe mutation and revision workflows

```bash
npx ./bin/outline-cli.js invoke documents.safe_update \
  --args '{"id":"doc-id","expectedRevision":12,"text":"\n\n## Update\n- Added step","editMode":"append","performAction":true}'

npx ./bin/outline-cli.js invoke documents.diff \
  --args '{"id":"doc-id","proposedText":"# Title\n\nUpdated body"}'

npx ./bin/outline-cli.js invoke documents.apply_patch_safe \
  --args '{"id":"doc-id","mode":"replace","patch":"# Title\n\nReplaced body safely","expectedRevision":12,"performAction":true}'
# optional wrapper; if unavailable in your build, use documents.apply_patch with expectedRevision
npx ./bin/outline-cli.js invoke documents.apply_patch \
  --args '{"id":"doc-id","mode":"replace","patch":"# Title\n\nReplaced body","expectedRevision":12,"performAction":true}'

npx ./bin/outline-cli.js invoke documents.batch_update \
  --args '{"updates":[{"id":"doc-1","title":"Renamed"},{"id":"doc-2","text":"\n\nPatch","editMode":"append"}],"continueOnError":true,"performAction":true}'

npx ./bin/outline-cli.js invoke documents.plan_batch_update \
  --args '{
    "query":"incident communication",
    "rules":[{"field":"both","find":"SEV1","replace":"SEV-1","wholeWord":true}],
    "maxDocuments":20
  }'

npx ./bin/outline-cli.js invoke documents.apply_batch_plan \
  --args-file ./apply-plan.json
# apply-plan.json example:
# {
#   "confirmHash":"<planHash-from-plan_batch_update>",
#   "plan": { ...plan object... },
#   "performAction": true
# }

npx ./bin/outline-cli.js invoke documents.info \
  --args '{"id":"doc-id","view":"summary","armDelete":true}'
# copy deleteReadReceipt.token from result, then:
npx ./bin/outline-cli.js invoke documents.delete \
  --args '{"id":"doc-id","readToken":"<deleteReadReceipt.token>","performAction":true}'

npx ./bin/outline-cli.js invoke revisions.list --args '{"documentId":"doc-id","limit":5}'
npx ./bin/outline-cli.js invoke revisions.restore --args '{"id":"doc-id","revisionId":"rev-id","performAction":true}'
```

### UC-09 operator sequence: draft -> revision inspect -> diff -> rollback-safe recovery

```bash
# 1) Read draft and capture its revision
npx ./bin/outline-cli.js invoke documents.info \
  --args '{"id":"postmortem-doc-id","view":"summary"}'

# 2) Apply precondition-guarded patch (prefer safe wrapper when available)
npx ./bin/outline-cli.js invoke documents.apply_patch_safe \
  --args '{"id":"postmortem-doc-id","mode":"unified","patch":"@@ -1,1 +1,1 @@\n-Old\n+New","expectedRevision":12,"performAction":true,"view":"summary"}'
# fallback if apply_patch_safe is not registered in your build:
npx ./bin/outline-cli.js invoke documents.apply_patch \
  --args '{"id":"postmortem-doc-id","mode":"unified","patch":"@@ -1,1 +1,1 @@\n-Old\n+New","expectedRevision":12,"performAction":true,"view":"summary"}'

# 3) Hydrate revision candidates for RCA review
npx ./bin/outline-cli.js invoke revisions.list \
  --args '{"documentId":"postmortem-doc-id","limit":10,"view":"summary"}'
npx ./bin/outline-cli.js invoke revisions.info \
  --args '{"id":"revision-id","view":"full"}'

# 4) Optional (if your build exposes the contract): compare two revisions directly
npx ./bin/outline-cli.js invoke revisions.diff \
  --args '{"id":"postmortem-doc-id","baseRevisionId":"revision-base-id","targetRevisionId":"revision-target-id","hunkLimit":8,"hunkLineLimit":12}'

# 5) Roll back safely to the chosen revision
npx ./bin/outline-cli.js invoke revisions.restore \
  --args '{"id":"postmortem-doc-id","revisionId":"revision-base-id","performAction":true,"view":"summary"}'
```

If `documents.apply_patch` or `documents.apply_patch_safe` receives a stale `expectedRevision`, it returns deterministic `code: "revision_conflict"` and does not mutate the document.

### 13. UC-03: meeting notes + decision logs

```bash
# 1) Turn a canonical meeting-note document into a reusable template
npx ./bin/outline-agent.js invoke documents.templatize \
  --args '{"id":"meeting-notes-canonical-doc-id","performAction":true}'

npx ./bin/outline-agent.js invoke templates.list \
  --args '{"query":"meeting notes","limit":10,"view":"summary"}'

npx ./bin/outline-agent.js invoke templates.info \
  --args '{"id":"template-id","view":"summary"}'

# 2) Start a fresh meeting note from that template
npx ./bin/outline-agent.js invoke documents.create \
  --args '{"title":"Team Sync 2026-03-05","templateId":"template-id","publish":false,"view":"summary"}'

# 3) Record decision edits + rationale comments
npx ./bin/outline-agent.js invoke documents.update \
  --args '{"id":"meeting-doc-id","text":"\n\n## Decision\n- Adopt option B\n- Owner: Alex\n- Due: 2026-03-12","editMode":"append","performAction":true}'

npx ./bin/outline-agent.js invoke comments.create \
  --args '{"documentId":"meeting-doc-id","text":"Reasoning: lower operational risk","performAction":true}'

npx ./bin/outline-agent.js invoke comments.list \
  --args '{"documentId":"meeting-doc-id","limit":20,"view":"summary"}'

# 4) Hydrate a revision and restore if needed
npx ./bin/outline-agent.js invoke revisions.list \
  --args '{"documentId":"meeting-doc-id","limit":10,"view":"summary"}'

npx ./bin/outline-agent.js invoke revisions.info \
  --args '{"id":"revision-id","view":"full"}'

npx ./bin/outline-agent.js invoke revisions.restore \
  --args '{"id":"meeting-doc-id","revisionId":"revision-id","performAction":true}'
```

### 14. UC-11: template-driven doc pipeline (templatize -> extract -> create_from_template -> validate)

```bash
# 1) Convert a suite-owned canonical document into a template
npx ./bin/outline-cli.js invoke documents.templatize \
  --args '{"id":"canonical-runbook-doc-id","performAction":true,"view":"summary"}'

# 2) Extract deterministic placeholder keys from the template
npx ./bin/outline-cli.js invoke templates.extract_placeholders \
  --args '{"id":"template-id"}'

# 3) Create a document from the template with placeholder substitutions
npx ./bin/outline-cli.js invoke documents.create_from_template \
  --args '{"templateId":"template-id","title":"Billing API Release Checklist 2026-03-05","placeholderValues":{"service_name":"Billing API","owner":"Ops Duty Lead","target_date":"2026-03-31","runbook_url":"https://example.invalid/runbooks/billing-api"},"strictPlaceholders":true,"publish":false,"performAction":true,"view":"summary"}'

# 4) Validate substitutions in the created document
npx ./bin/outline-cli.js invoke documents.info \
  --args '{"id":"created-doc-id","view":"full"}'
```

Use `strictPlaceholders=true` when unresolved tokens must fail the pipeline instead of creating incomplete documents.

### 15. UC-12: legacy wiki migration playbook (import -> track -> verify -> cleanup)

```bash
# 1) Confirm import mutation calls are action-gated
npx ./bin/outline-cli.js invoke api.call \
  --args '{"method":"documents.import","body":{}}'
# expected: CliError with code ACTION_GATED (performAction required)

# 2) Run endpoint-native import (wrapper shape follows deployment endpoint args)
npx ./bin/outline-cli.js invoke documents.import \
  --args '{"collectionId":"<collection-id>","publish":false,"performAction":true,"view":"summary"}'

# 3) Run local file-based import
npx ./bin/outline-cli.js invoke documents.import_file \
  --args '{"filePath":"./fixtures/legacy-wiki-page.md","collectionId":"<collection-id>","publish":false,"performAction":true,"view":"summary"}'

# 4) Track async import operation status
npx ./bin/outline-cli.js invoke file_operations.list \
  --args '{"type":"import","limit":20,"view":"summary"}'
npx ./bin/outline-cli.js invoke file_operations.info \
  --args '{"id":"<file-operation-id>","view":"summary"}'

# 5) Verify imported content with deterministic marker queries
npx ./bin/outline-cli.js invoke documents.search \
  --args '{"query":"<migration-marker>","mode":"titles","limit":20,"view":"summary"}'
npx ./bin/outline-cli.js invoke documents.info \
  --args '{"ids":["<imported-doc-id-1>","<imported-doc-id-2>"],"view":"summary","concurrency":2}'

# 6) Cleanup suite-owned operation metadata + imported docs
npx ./bin/outline-cli.js invoke file_operations.delete \
  --args '{"id":"<file-operation-id>","performAction":true}'
npx ./bin/outline-cli.js invoke documents.info \
  --args '{"id":"<imported-doc-id>","view":"summary","armDelete":true}'
npx ./bin/outline-cli.js invoke documents.delete \
  --args '{"id":"<imported-doc-id>","readToken":"<deleteReadReceipt.token>","performAction":true}'
```

If wrappers are unavailable in your deployment, use `api.call` with `method` set to the same endpoint and keep the same action-gate discipline (`performAction: true` on mutating calls).

### 16. UC-13: API-driven workspace automation (discover -> plan -> gated execute -> verify)

```bash
# 1) Discover principals and workspace context
npx ./bin/outline-cli.js invoke users.list \
  --args '{"limit":25,"view":"summary"}'
npx ./bin/outline-cli.js invoke users.info \
  --args '{"id":"<user-id>","view":"summary"}'
npx ./bin/outline-cli.js invoke documents.users \
  --args '{"id":"<doc-id>","limit":25,"view":"summary"}'

# 2) Preflight mutator contracts safely (without performAction)
npx ./bin/outline-cli.js invoke users.invite \
  --args '{"invites":[]}'
npx ./bin/outline-cli.js invoke users.update_role \
  --args '{"id":"","role":"member"}'
npx ./bin/outline-cli.js invoke users.activate \
  --args '{"id":""}'
npx ./bin/outline-cli.js invoke users.suspend \
  --args '{"id":""}'
# expected: ACTION_GATED or ARG_VALIDATION_FAILED (no mutation)

# 3) Approved execution path (sandbox/explicit approval only)
npx ./bin/outline-cli.js invoke users.invite \
  --args '{"invites":[{"email":"new.user@example.com","name":"New User","role":"member"}],"performAction":true,"view":"summary"}'
npx ./bin/outline-cli.js invoke users.update_role \
  --args '{"id":"<user-id>","role":"member","performAction":true,"view":"summary"}'
npx ./bin/outline-cli.js invoke users.suspend \
  --args '{"id":"<user-id>","performAction":true,"view":"summary"}'
npx ./bin/outline-cli.js invoke users.activate \
  --args '{"id":"<user-id>","performAction":true,"view":"summary"}'

# 4) Verify post-conditions + audit trail
npx ./bin/outline-cli.js invoke users.info \
  --args '{"id":"<user-id>","view":"summary"}'
npx ./bin/outline-cli.js invoke events.list \
  --args '{"documentId":"<doc-id>","limit":20,"view":"summary"}'
```

If optional UC-13 wrappers are unavailable in your deployment, keep the same sequence with `api.call` and explicit `performAction: true` on every mutating method.

### 17. Capability mapping and test cleanup

```bash
npx ./bin/outline-cli.js invoke capabilities.map \
  --args '{"includePolicies":true}'

npx ./bin/outline-cli.js invoke documents.cleanup_test \
  --args '{"markerPrefix":"outline-cli-live-test-","olderThanHours":24,"dryRun":true}'
```

`invoke` now validates tool args before calling the API and returns deterministic machine-readable errors.
Unknown args are rejected with `ARG_VALIDATION_FAILED` to avoid silent typos in automation.
Mutating actions are gated by default; pass `"performAction": true` explicitly to execute writes.
Delete flows require a short-lived read receipt from `documents.info` with `"armDelete": true`.
`capabilities.map` now uses live endpoint evidence + policies (not role-only heuristics) and can return tri-state mutation capabilities (`true|false|null`).

## Built-in Tools

- `auth.info`
- `documents.search`
- `documents.resolve`
- `search.research`
- `documents.list`
- `documents.info`
- `documents.create`
- `documents.import`
- `documents.import_file`
- `documents.create_from_template`
- `documents.update`
- `documents.safe_update`
- `documents.diff`
- `documents.apply_patch`
- `documents.apply_patch_safe` (optional wrapper)
- `documents.batch_update`
- `documents.plan_batch_update`
- `documents.apply_batch_plan`
- `documents.delete`
- `collections.list`
- `collections.info`
- `collections.tree`
- `collections.create`
- `collections.update`
- `collections.memberships`
- `collections.group_memberships`
- `collections.add_user`
- `collections.remove_user`
- `collections.add_group`
- `collections.remove_group`
- `revisions.list`
- `revisions.info`
- `revisions.restore`
- `shares.list`
- `shares.info`
- `shares.create`
- `shares.update`
- `shares.revoke`
- `templates.list`
- `templates.extract_placeholders`
- `templates.info`
- `templates.create`
- `templates.update`
- `templates.delete`
- `templates.restore`
- `templates.duplicate`
- `documents.templatize`
- `comments.list`
- `comments.info`
- `comments.create`
- `comments.update`
- `comments.delete`
- `events.list`
- `file_operations.list`
- `file_operations.info`
- `file_operations.delete`
- `users.list`
- `users.info`
- `users.invite` (optional UC-13 helper; may be unavailable in older builds)
- `users.update_role` (optional UC-13 helper; may be unavailable in older builds)
- `users.activate` (optional UC-13 helper; may be unavailable in older builds)
- `users.suspend` (optional UC-13 helper; may be unavailable in older builds)
- `groups.list`
- `groups.info`
- `groups.create`
- `groups.update`
- `groups.delete`
- `groups.add_user`
- `groups.remove_user`
- `documents.memberships`
- `documents.group_memberships`
- `documents.users` (optional UC-13 helper; may be unavailable in older builds)
- `documents.add_user`
- `documents.remove_user`
- `documents.add_group`
- `documents.remove_group`
- `search.expand`
- `capabilities.map`
- `documents.cleanup_test`
- `api.call` (raw RPC endpoint)

Contracts (signature + example + AI best practices):

```bash
npx ./bin/outline-cli.js tools contract <tool-name>
```

Full contract doc: [docs/TOOL_CONTRACTS.md](docs/TOOL_CONTRACTS.md)

## Temp File Management

```bash
npx ./bin/outline-cli.js tmp list
npx ./bin/outline-cli.js tmp cat <file>
npx ./bin/outline-cli.js tmp rm <file>
npx ./bin/outline-cli.js tmp gc --max-age-hours 24
```

## Notes on Permissions

Outline API enforces permissions/scopes server-side. This CLI does not bypass permissions.

- Authorized actions succeed.
- Unauthorized actions return API errors (e.g. `403`).
- Many endpoints return `policies`; include them when capability reasoning is needed.

## Research Sources

Primary sources used to design this CLI:

- Outline developer docs: https://www.getoutline.com/developers
- Outline OpenAPI spec repo: https://github.com/outline/openapi
- Outline server route behavior: https://github.com/outline/outline
- OpenAI function calling + structured outputs: https://platform.openai.com/docs/guides/function-calling
- Anthropic tool use best practices: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use
- Model Context Protocol tools concept: https://modelcontextprotocol.io/docs/concepts/tools
- AWS CLI output/query patterns: https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-output-format.html
