# AGENTS.md

## Scope
This repository contains `outline-agent`, a Node.js CLI optimized for AI agents to interact with Outline via real API calls.

## Core Principles
- Keep outputs deterministic and machine-readable.
- Optimize for low-token workflows (`summary/ids` views first, hydrate later).
- Prefer batch operations for fewer round trips.
- Never mutate existing workspace content in tests except suite-created test documents.
- Keep security strict: no hardcoded live secrets in tracked files.

## Runtime + Commands
- Node.js: `>=18.17`
- Install: `npm install`
- Basic check: `npm run check`
- Full tests (real environment): `npm test`

## Repository Map
- CLI entrypoint: `bin/outline-agent.js`
- Command wiring/output modes: `src/cli.js`
- API client/auth/retry: `src/outline-client.js`
- Tool registry/core tools: `src/tools.js`
- Navigation/search tools: `src/tools.navigation.js`
- Mutation/revision tools: `src/tools.mutation.js`
- Platform/cleanup/capabilities tools: `src/tools.platform.js`
- Tool arg validation: `src/tool-arg-schemas.js`
- Live integration tests: `test/live.integration.test.js`

## Local Environment
- Template: `.env.test.example`
- Local secret file (untracked): `.env.test.local`
- Required vars for live tests:
  - `OUTLINE_TEST_BASE_URL`
  - `OUTLINE_TEST_API_KEY`

## Development Workflow
1. Pull latest branch and inspect current tool contracts:
   - `node ./bin/outline-agent.js tools contract all --result-mode inline`
2. Refresh raw API method inventory from prior sessions / wrappers, then diff wrapped vs raw:
   - `rg -o 'client\\.call\\(\"[^\"]+\"' src | sed -E 's/.*\\(\"//; s/\"$//' | sort | uniq`
   - record missing high-value endpoints in `/tmp/knowledges/outline-raw-api-gap.md`
3. Implement minimal, compatible changes (preserve response envelopes).
4. Add/adjust arg schema in `src/tool-arg-schemas.js` for every new tool arg.
5. Add/adjust real integration tests in `test/live.integration.test.js`.
6. Run:
   - `npm run check`
   - `npm test`
7. Update docs when behavior/signature changes:
   - `README.md`
   - `docs/TOOL_CONTRACTS.md`

## Testing Rules (Live Env)
- No mocks when endpoint can be exercised live.
- Mutation tests must:
  - create a dedicated test doc first,
  - perform all edits/patch/revision operations on that doc,
  - delete it in cleanup.
- Read-only tools (search/list/info) may use site-wide data.
- Keep tests resilient: isolate steps with subtests and clear assertions.

## Tool/Output Requirements
- Default JSON output remains stable.
- `--output ndjson` must stay stream-friendly and compatible with file-offload behavior.
- Large responses should offload to temp files when `result-mode` is `auto|file`.
- `batch` should default to token-efficient item payloads; full envelopes opt-in.

## Agent Action Gate
- Mutating actions are gated by default and must be explicit:
  - pass `performAction: true` on mutation/delete operations.
- Safe delete flow requires prior read confirmation:
  1. Call `documents.info` with `armDelete: true` on target document(s).
  2. Use returned `deleteReadReceipt.token` as `readToken` for delete.
  3. Execute delete only with `performAction: true`.
- Delete operations must fail if read token is missing, stale, mismatched, or expired.

## Security + Secrets
- Never commit real Outline API keys or `.env.test.local`.
- Secret scan guard test must pass.
- If a key is exposed, rotate immediately and update local env.

## Deployment / Release
- Pre-release checklist:
  1. `npm run check`
  2. `npm test` (live)
  3. verify `README.md` and `docs/TOOL_CONTRACTS.md` are in sync
  4. verify `.gitignore` still blocks local env/knowledge files
- Packaging:
  - Ensure `bin` is executable and `package.json` `bin` mapping is correct.
  - Validate `npx` path: `npx ./bin/outline-agent.js --help`.

## Temporary Knowledge Notes
Use local scratch references under:
- `/tmp/knowledges/*.md`

These are intentionally ignored by git and can store short-lived research/decision notes.
