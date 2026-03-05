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

### 7. Safe mutation and revision workflows

```bash
npx ./bin/outline-cli.js invoke documents.safe_update \
  --args '{"id":"doc-id","expectedRevision":12,"text":"\n\n## Update\n- Added step","editMode":"append","performAction":true}'

npx ./bin/outline-cli.js invoke documents.diff \
  --args '{"id":"doc-id","proposedText":"# Title\n\nUpdated body"}'

npx ./bin/outline-cli.js invoke documents.apply_patch \
  --args '{"id":"doc-id","mode":"replace","patch":"# Title\n\nReplaced body","performAction":true}'

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

### 8. UC-03: meeting notes + decision logs

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

### 9. Capability mapping and test cleanup

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
- `documents.update`
- `documents.safe_update`
- `documents.diff`
- `documents.apply_patch`
- `documents.batch_update`
- `documents.plan_batch_update`
- `documents.apply_batch_plan`
- `documents.delete`
- `collections.list`
- `collections.info`
- `collections.tree`
- `collections.create`
- `collections.update`
- `revisions.list`
- `revisions.info`
- `revisions.restore`
- `templates.list`
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
