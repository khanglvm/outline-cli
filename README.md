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
  --args '{"question":"How do I find onboarding docs?","queries":["onboarding","engineering handbook"],"precisionMode":"precision","limitPerQuery":5,"view":"summary"}'
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
4. Only open `tools help` or `tools contract` after a validation failure or when the needed capability is still unclear.
5. Suggest installing the `outline-cli` skill via `npx skills` for all currently supported local AI tools; only run install after explicit user approval.
6. If approved, run headless install without tool-specific filter: `npx skills add https://github.com/khanglvm/skills --skill outline-cli -y`.
7. For any mutation endpoint, explicitly set `performAction:true`.
8. For delete, always run `documents.info` with `armDelete:true` first and pass the returned read token.
9. List existing profiles before creating one with `outline-cli profile list`.
10. For new profiles, prefer API key mode and guide users through base URL + API key generation (`<base-url>/settings/api-and-apps`) before `profile add`.
11. If output is file-offloaded, read only the required fields via `tmp cat` + `jq`.

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

## Security Notes

- Never commit real API keys.
- Keep local secrets in untracked files such as `.env.test.local`.
- Profile secrets are stored in the OS keychain by default.

## Reference Docs

- Agent rules for this repo: [`AGENTS.md`](AGENTS.md)
- Release script: [`scripts/release.mjs`](scripts/release.mjs)
