# outline-agent-cli

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
npx ./bin/outline-agent.js --help
```

Or when published:

```bash
npx outline-agent --help
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

## Profile Setup

### API key profile (recommended for Outline public API)

```bash
npx ./bin/outline-agent.js profile add prod \
  --base-url https://app.getoutline.com \
  --api-key "$OUTLINE_API_KEY" \
  --set-default
```

### Username/password profile

```bash
npx ./bin/outline-agent.js profile add internal \
  --base-url https://outline.company.com \
  --auth-type password \
  --username agent@company.com \
  --password "$OUTLINE_PASSWORD"
```

Optional token exchange for `password` mode:

```bash
npx ./bin/outline-agent.js profile add internal \
  --base-url https://outline.company.com \
  --auth-type password \
  --username agent@company.com \
  --password "$OUTLINE_PASSWORD" \
  --token-endpoint https://outline.company.com/oauth/token \
  --token-field access_token \
  --token-body '{"grant_type":"password"}'
```

## Agent-Focused Usage

### 1. Discover tool contracts

```bash
npx ./bin/outline-agent.js tools contract all --pretty
```

### 2. Single-tool invoke

```bash
npx ./bin/outline-agent.js invoke documents.search \
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
npx ./bin/outline-agent.js batch --ops '[
  {"tool":"collections.list","args":{"limit":10,"view":"summary"}},
  {"tool":"documents.search","args":{"query":"SLO","limit":5,"view":"ids"}}
]'
```

By default, `batch` uses compact per-item payloads (token-efficient). Use full envelopes when needed:

```bash
npx ./bin/outline-agent.js batch --item-envelope full --ops '[
  {"tool":"auth.info","args":{"view":"summary"}}
]'
```

NDJSON output mode for batch/list-style parsing:

```bash
npx ./bin/outline-agent.js batch --output ndjson --ops '[
  {"tool":"auth.info","args":{"view":"summary"}},
  {"tool":"collections.list","args":{"limit":5,"view":"summary"}}
]'
```

If NDJSON payload is too large and `--result-mode auto|file` is active, output switches to file-pointer NDJSON lines (`type: "file"`).

### 4. Long-response handling (auto temp-file offload)

If response exceeds `--inline-max-bytes` (default `12000`), CLI returns a file pointer instead of streaming full content.

```bash
npx ./bin/outline-agent.js tools contract all --inline-max-bytes 500
# -> {"stored":true,"file":"/.../tmp/...json",...}

npx ./bin/outline-agent.js tmp list
cat /absolute/path/from/result.json | jq '.contract[0]'
```

### 5. Resolve + expand in one agent loop

```bash
npx ./bin/outline-agent.js invoke documents.resolve \
  --args '{"queries":["incident handbook","oncall escalation"],"view":"summary","limit":6}'

npx ./bin/outline-agent.js invoke search.expand \
  --args '{"query":"incident handbook","mode":"semantic","limit":8,"expandLimit":3,"view":"summary"}'
```

For deeper multi-turn research across many docs with evidence merge + follow-up cursor:

```bash
npx ./bin/outline-agent.js invoke search.research \
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
npx ./bin/outline-agent.js invoke collections.tree \
  --args '{"collectionId":"<collection-id>","includeDrafts":false,"maxDepth":4,"view":"summary"}'
```

### 7. Safe mutation and revision workflows

```bash
npx ./bin/outline-agent.js invoke documents.safe_update \
  --args '{"id":"doc-id","expectedRevision":12,"text":"\n\n## Update\n- Added step","editMode":"append","performAction":true}'

npx ./bin/outline-agent.js invoke documents.diff \
  --args '{"id":"doc-id","proposedText":"# Title\n\nUpdated body"}'

npx ./bin/outline-agent.js invoke documents.apply_patch \
  --args '{"id":"doc-id","mode":"replace","patch":"# Title\n\nReplaced body","performAction":true}'

npx ./bin/outline-agent.js invoke documents.batch_update \
  --args '{"updates":[{"id":"doc-1","title":"Renamed"},{"id":"doc-2","text":"\n\nPatch","editMode":"append"}],"continueOnError":true,"performAction":true}'

npx ./bin/outline-agent.js invoke documents.plan_batch_update \
  --args '{
    "query":"incident communication",
    "rules":[{"field":"both","find":"SEV1","replace":"SEV-1","wholeWord":true}],
    "maxDocuments":20
  }'

npx ./bin/outline-agent.js invoke documents.apply_batch_plan \
  --args-file ./apply-plan.json
# apply-plan.json example:
# {
#   "confirmHash":"<planHash-from-plan_batch_update>",
#   "plan": { ...plan object... },
#   "performAction": true
# }

npx ./bin/outline-agent.js invoke documents.info \
  --args '{"id":"doc-id","view":"summary","armDelete":true}'
# copy deleteReadReceipt.token from result, then:
npx ./bin/outline-agent.js invoke documents.delete \
  --args '{"id":"doc-id","readToken":"<deleteReadReceipt.token>","performAction":true}'

npx ./bin/outline-agent.js invoke revisions.list --args '{"documentId":"doc-id","limit":5}'
npx ./bin/outline-agent.js invoke revisions.restore --args '{"id":"doc-id","revisionId":"rev-id","performAction":true}'
```

### 8. Capability mapping and test cleanup

```bash
npx ./bin/outline-agent.js invoke capabilities.map \
  --args '{"includePolicies":true}'

npx ./bin/outline-agent.js invoke documents.cleanup_test \
  --args '{"markerPrefix":"outline-agent-live-test-","olderThanHours":24,"dryRun":true}'
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
- `revisions.restore`
- `search.expand`
- `capabilities.map`
- `documents.cleanup_test`
- `api.call` (raw RPC endpoint)

Contracts (signature + example + AI best practices):

```bash
npx ./bin/outline-agent.js tools contract <tool-name>
```

Full contract doc: [docs/TOOL_CONTRACTS.md](docs/TOOL_CONTRACTS.md)

## Temp File Management

```bash
npx ./bin/outline-agent.js tmp list
npx ./bin/outline-agent.js tmp cat <file>
npx ./bin/outline-agent.js tmp rm <file>
npx ./bin/outline-agent.js tmp gc --max-age-hours 24
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
