# Tool Playbook

## Contract Discovery

Always start by pulling current contracts from the CLI:

```bash
outline-agent tools contract all --pretty
```

Use this output as the source of truth for signatures and examples.

## High-Value Patterns

### Multi-query semantic search in one call

```bash
outline-agent invoke documents.search --args '{
  "queries": ["incident process", "escalation policy", "postmortem template"],
  "mode": "semantic",
  "limit": 8,
  "view": "summary",
  "merge": true
}'
```

### Batch hydrate documents by ID

```bash
outline-agent invoke documents.info --args '{
  "ids": ["doc-a", "doc-b", "doc-c"],
  "view": "summary",
  "concurrency": 4
}'
```

### Apply incremental update

```bash
outline-agent invoke documents.update --args '{
  "id": "doc-a",
  "text": "\n\n## Update\n- Added owner",
  "editMode": "append"
}'
```

### One-shot multi-tool batch

```bash
outline-agent batch --ops '[
  {"tool":"collections.list","args":{"limit":10,"view":"summary"}},
  {"tool":"documents.search","args":{"query":"oncall","view":"ids","limit":5}},
  {"tool":"auth.info","args":{"view":"summary"}}
]'
```

## Profile Notes

Use profile IDs to route to different Outline instances. Default profile is used when no `--profile` is passed.

```bash
outline-agent profile list
outline-agent profile use prod
outline-agent invoke auth.info
```

## Output Size Control

- Default mode is `auto`: large payloads are written to temp files.
- Force file mode:

```bash
outline-agent invoke documents.info --args '{"id":"doc-a","view":"full"}' --result-mode file
```

- Force inline mode for small payloads:

```bash
outline-agent invoke collections.list --args '{"limit":5}' --result-mode inline
```
