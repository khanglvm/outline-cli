# outline-cli

`outline-cli` is a Node.js CLI for the Outline API, optimized for AI agents and automation workflows with deterministic, low-token, machine-readable output.

- Stable JSON envelopes
- Token-efficient `ids` and `summary` views
- Batch operations to reduce API round trips
- Safe mutation gates (`performAction: true`)
- Automatic large-result offload to temp files

## Quick Start

Prerequisites:

- Node.js `>=18.17`
- An Outline workspace URL
- An Outline API key (recommended auth mode)

Install globally (recommended):

```bash
npm i -g @khanglvm/outline-cli
outline-cli --help
```

Alternative (no global install):

```bash
npx @khanglvm/outline-cli --help
```

Local development in this repo:

```bash
npm install
node ./bin/outline-cli.js --help
```

Set up a profile (API key mode):

```bash
outline-cli profile add prod \
  --base-url https://app.getoutline.com \
  --api-key "$OUTLINE_API_KEY" \
  --set-default
```

Verify auth:

```bash
outline-cli profile test prod --pretty
```

Run your first search:

```bash
outline-cli invoke documents.search \
  --args '{"query":"oncall runbook","mode":"semantic","limit":5,"view":"summary"}' \
  --pretty
```

## Day-to-Day Usage

Discover tools and contracts:

```bash
outline-cli tools list
outline-cli tools contract documents.search --pretty
outline-cli tools contract all --result-mode inline
```

Read document metadata by id:

```bash
outline-cli invoke documents.info \
  --args '{"id":"<document-id>","view":"summary"}'
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

Delete is guarded by read-token confirmation.

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

Add password-mode profile:

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

1. Start with `tools contract all --result-mode inline`.
2. Prefer `view:"ids"` or `view:"summary"` first; hydrate to `full` only when needed.
3. Bundle independent reads into one `batch` call.
4. For any mutation endpoint, explicitly set `performAction:true`.
5. For delete, always run `documents.info` with `armDelete:true` first and pass the returned read token.
6. If output is file-offloaded, read only the required fields via `tmp cat` + `jq`.

For structured AI playbooks and scenario guides:

```bash
outline-cli tools help ai-skills --view summary
outline-cli tools help ai-skills --scenario UC-12
```

## Testing (Live Environment)

Set test credentials in local env file:

```bash
cp .env.test.example .env.test.local
# set OUTLINE_TEST_BASE_URL and OUTLINE_TEST_API_KEY
```

Run checks:

```bash
npm run check
npm test
```

Test rule in this repository:

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

## Security Notes

- Never commit real API keys.
- Keep local secrets in untracked files such as `.env.test.local`.
- Profile secrets are stored in OS keychain by default.

## Reference Docs

- Agent rules for this repo: [`AGENTS.md`](AGENTS.md)
- Release script: [`scripts/release.mjs`](scripts/release.mjs)
