---
name: outline-agent-cli
description: Use the local Outline CLI to interact with Outline workspaces in an agent-optimized way. Trigger when tasks involve searching, listing, reading, creating, or updating Outline documents/collections, especially when multi-profile routing, batch calls, token-efficient output, or temp-file offloading for large responses is needed.
---

# Outline Agent CLI

Use this skill to operate Outline via the local `outline-agent` command.

## Quick Start

1. Discover tool contracts first:

```bash
outline-agent tools contract all --pretty
```

2. Verify profile access before edits:

```bash
outline-agent profile test
```

3. Prefer `invoke` with structured JSON args:

```bash
outline-agent invoke documents.search --args '{"query":"runbook","view":"summary"}'
```

## Workflow

1. Identify the target workspace profile.
2. Resolve IDs with summary views (`collections.list`, `documents.search`, `documents.list`).
3. Hydrate only selected IDs (`documents.info`, `collections.info`).
4. Apply minimal mutations (`documents.update` append/prepend or small field diffs).
5. Use `batch` to reduce round trips when multiple calls are needed.

## AI Efficiency Rules

- Use `view: "ids"` or `view: "summary"` for exploration.
- Use `ids[]` or `queries[]` batch args to collapse many operations into one CLI call.
- Keep `includePolicies` off unless capability decisions are required.
- Rely on automatic temp-file offload for large responses; inspect files with shell tools.
- Use `--args-file` for long markdown payloads instead of inline JSON escaping.

## Temp-File Handling

Large results are automatically stored when payload exceeds inline size limit.

```bash
outline-agent invoke documents.info --args '{"ids":["doc1","doc2"],"view":"full"}'
# returns JSON with "stored": true and "file": "/abs/path/..."
```

Then inspect with shell:

```bash
jq '.result.items[] | {id, ok}' /abs/path/result.json
```

Cleanup:

```bash
outline-agent tmp gc --max-age-hours 24
```

## Core Commands

- `outline-agent tools list`
- `outline-agent tools contract <tool|all>`
- `outline-agent invoke <tool> --args <json> | --args-file <path>`
- `outline-agent batch --ops <json-array> | --ops-file <path>`
- `outline-agent profile add/list/show/use/remove/test`
- `outline-agent tmp list/cat/rm/gc`

## Read Next

For tool-by-tool signatures, examples, and best practices, read:
`references/tool-playbook.md`
