# Tool Playbook

Use this file for concrete command recipes after reading `SKILL.md`.

## Contract Discovery (Source of Truth)
```bash
outline-cli tools contract all --result-mode inline
```

List tool names quickly:
```bash
outline-cli tools contract all --result-mode inline | jq -r '.contract[].name'
```

## Bootstrap and Profile Checks
```bash
outline-cli --version
outline-cli tools help --view summary
outline-cli profile list
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

### Resolve URL/title references then hydrate
```bash
outline-cli invoke documents.resolve_urls --args '{
  "urls": ["https://docs.example.com/doc/incident-handbook-AbCd1234"],
  "strict": true,
  "view": "ids"
}'

outline-cli invoke documents.info --args '{
  "ids": ["doc-a", "doc-b"],
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

### Canonicalize duplicate/noisy candidates
```bash
outline-cli invoke documents.canonicalize_candidates --args '{
  "queries": ["campaign detail", "campaign tracking event"],
  "strict": true,
  "titleSimilarityThreshold": 0.8,
  "view": "summary"
}'
```

## Embedded Attachments and Images

### List embedded attachment refs without downloading
```bash
outline-cli invoke documents.attachments --args '{
  "url": "https://docs.example.com/doc/example-title-AbCd1234"
}'
```

### Download all embedded images/files from a document
```bash
outline-cli invoke documents.download_attachments --args '{
  "url": "https://docs.example.com/doc/example-title-AbCd1234",
  "outputDir": "./outline-attachments",
  "overwrite": true,
  "concurrency": 2
}'
```

### Download one attachment by id or redirect URL
```bash
outline-cli invoke attachments.download --args '{
  "id": "15831936-7fef-4a58-b17b-121a65c3d787",
  "outputDir": "./outline-attachments",
  "overwrite": true
}'
```

Do not use `api.call` for `attachments.redirect`; it returns binary bytes.

## Template Pipeline

### Extract placeholder keys from template
```bash
outline-cli invoke templates.extract_placeholders --args '{"id":"template-id"}'
```

### Instantiate with strict placeholder enforcement
```bash
outline-cli invoke documents.create_from_template --args '{
  "templateId": "template-id",
  "title": "Service A - Incident Postmortem",
  "placeholderValues": {
    "service_name": "Service A",
    "owner": "SRE Team"
  },
  "strictPlaceholders": true,
  "publish": true,
  "performAction": true,
  "view": "summary"
}'
```

## Comments and Review Queue
```bash
outline-cli invoke comments.review_queue --args '{
  "documentIds": ["doc-a", "doc-b"],
  "includeReplies": true,
  "includeAnchorText": true,
  "limitPerDocument": 20,
  "view": "summary"
}'
```

Deep-dive specific threads:
```bash
outline-cli invoke comments.list --args '{"documentId":"doc-a"}'
outline-cli invoke comments.info --args '{"id":"comment-id"}'
```

## Issue Linkage and Graph Mapping

### Deterministic issue ref extraction
```bash
outline-cli invoke documents.issue_refs --args '{
  "ids": ["doc-a", "doc-b"],
  "issueDomains": ["jira.example.com", "github.com"],
  "keyPattern": "[A-Z][A-Z0-9]+-\\d+",
  "view": "summary"
}'
```

### Query-driven issue linkage report
```bash
outline-cli invoke documents.issue_ref_report --args '{
  "queries": ["incident response", "release checklist"],
  "collectionId": "collection-id",
  "issueDomains": ["jira.example.com"],
  "limit": 12,
  "view": "summary"
}'
```

### Backlinks and graph report
```bash
outline-cli invoke documents.backlinks --args '{"id":"doc-a","limit":20,"view":"summary"}'

outline-cli invoke documents.graph_report --args '{
  "seedIds": ["doc-a"],
  "depth": 2,
  "maxNodes": 80,
  "includeBacklinks": true,
  "limitPerSource": 8,
  "view": "ids"
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

### Planned multi-document terminology refactor
```bash
outline-cli invoke documents.plan_terminology_refactor --args '{
  "query": "incident communication",
  "glossary": [
    {"from":"SEV1","to":"SEV-1"},
    {"from":"SEV2","to":"SEV-2"}
  ]
}'
```

Apply the generated plan hash explicitly:
```bash
outline-cli invoke documents.apply_batch_plan --args '{
  "planHash": "<from-plan-output>",
  "performAction": true
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

## Federated Sync and ACL Reconciliation
```bash
outline-cli invoke federated.sync_manifest --args '{
  "collectionId": "collection-id",
  "since": "2026-03-01T00:00:00.000Z",
  "limit": 100,
  "offset": 0
}'

outline-cli invoke federated.sync_probe --args '{
  "queries": ["runbook escalation", "incident policy"],
  "mode": "both",
  "limit": 8
}'

outline-cli invoke federated.permission_snapshot --args '{
  "ids": ["doc-a", "doc-b"],
  "includeDocumentMemberships": true,
  "includeCollectionMemberships": true
}'
```

## Access and Capability Audits
```bash
outline-cli invoke capabilities.map --args '{"includePolicies":true}'
outline-cli invoke documents.users --args '{"id":"doc-a"}'
outline-cli invoke collections.group_memberships --args '{"id":"collection-id"}'
outline-cli invoke groups.memberships --args '{"id":"group-id"}'
```

## Import and File Operations
```bash
outline-cli invoke documents.import_file --args '{
  "filePath": "./tmp/wiki-export.md",
  "collectionId": "collection-id",
  "publish": false,
  "performAction": true
}'

outline-cli invoke file_operations.list --args '{}'
outline-cli invoke file_operations.info --args '{"id":"operation-id"}'
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

## Built-in Guidance Surfaces
```bash
outline-cli tools help quick-start-agent --view full
outline-cli tools help ai-skills --view full
```

## Alias Compatibility
`outline-agent` points to the same binary as `outline-cli`.
Prefer `outline-cli` for new instructions and scripts.
