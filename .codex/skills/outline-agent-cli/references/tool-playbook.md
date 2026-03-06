# Tool Playbook

Use this file for concrete command recipes after reading `SKILL.md`.

## Contract Discovery (Source of Truth)
```bash
outline-cli tools contract all --result-mode inline
```

## Bootstrap and Profile Checks
```bash
outline-cli --version
outline-cli tools help --view summary
outline-cli profile list --pretty
outline-cli profile test
outline-cli invoke auth.info --args '{"view":"summary"}'
```

## Low-Token Retrieval Patterns

### Multi-query semantic search (single call)
```bash
outline-cli invoke documents.search --args '{
  "queries": ["incident process", "escalation policy", "postmortem template"],
  "mode": "semantic",
  "limit": 8,
  "view": "summary",
  "merge": true
}'
```

### Resolve fuzzy references first, hydrate later
```bash
outline-cli invoke documents.resolve --args '{
  "queries": ["oncall runbook", "incident comms"],
  "limit": 6,
  "strict": false,
  "view": "ids"
}'

outline-cli invoke documents.info --args '{
  "ids": ["doc-a", "doc-b", "doc-c"],
  "view": "summary",
  "concurrency": 4
}'
```

### One-call research retrieval
```bash
outline-cli invoke search.research --args '{
  "question": "How do we run incident communication and escalation?",
  "queries": ["incident comms", "escalation matrix"],
  "precisionMode": "precision",
  "limitPerQuery": 8,
  "expandLimit": 4,
  "evidencePerDocument": 3,
  "view": "summary"
}'
```

## Safe Mutation Patterns

### Append incremental text update
```bash
outline-cli invoke documents.update --args '{
  "id": "doc-a",
  "text": "\n\n## Update\n- Added owner",
  "editMode": "append",
  "performAction": true,
  "view": "summary"
}'
```

### Revision-guarded update
```bash
outline-cli invoke documents.safe_update --args '{
  "id": "doc-a",
  "expectedRevision": 12,
  "text": "\n\n## Follow-up\n- Added RCA",
  "editMode": "append",
  "performAction": true,
  "view": "summary"
}'
```

### Patch-first workflow
```bash
outline-cli invoke documents.diff --args '{
  "id": "doc-a",
  "proposedText": "# Title\n\nUpdated body"
}'

outline-cli invoke documents.apply_patch_safe --args '{
  "id": "doc-a",
  "expectedRevision": 12,
  "mode": "unified",
  "patch": "@@ -1,1 +1,1 @@\n-Old\n+New",
  "performAction": true,
  "view": "summary"
}'
```

## Safe Delete Pattern (Required)
```bash
outline-cli invoke documents.info --args '{
  "id": "doc-a",
  "armDelete": true,
  "view": "summary"
}'

outline-cli invoke documents.delete --args '{
  "id": "doc-a",
  "readToken": "<deleteReadReceipt.token>",
  "performAction": true
}'
```

If delete fails with stale/expired token, repeat the `documents.info armDelete:true` call and retry.

## Batch Patterns

### One-shot multi-tool batch
```bash
outline-cli batch --ops '[
  {"tool":"collections.list","args":{"limit":10,"view":"summary"}},
  {"tool":"documents.search","args":{"query":"oncall","view":"ids","limit":5}},
  {"tool":"auth.info","args":{"view":"summary"}}
]'
```

### Batch from file for larger plans
```bash
outline-cli batch --ops-file ./tmp/ops.json --output ndjson
```

## Result Offload and Temp Files

### Force file output
```bash
outline-cli invoke documents.info --args '{"id":"doc-a","view":"full"}' --result-mode file
```

### Read offloaded payload
```bash
outline-cli tmp cat /absolute/path/from/result.json
```

### Cleanup cache
```bash
outline-cli tmp gc --older-than-hours 24
```

## Alias Compatibility
`outline-agent` points to the same binary as `outline-cli`.
Prefer `outline-cli` for new instructions and scripts.
