# Search and read

Find documents, read them and browse collections. Searches can use names you remember instead of IDs, and results stay small unless you ask for more.

## Search

```sh
outline-cli invoke documents.search \
  --args '{"query":"onboarding","limit":5,"view":"summary"}'
```

Narrow a search by a collection or a person with names instead of IDs:

```sh
outline-cli invoke documents.search \
  --args '{"query":"incident","collectionQuery":"engineering","userQuery":"alice@example.com","limit":8,"view":"summary"}'
```

To run several searches in one call, pass `queries` instead of `query`. `search.research` goes further: it combines title and meaning-based search across several queries, ranks the results and can fetch the top documents.

```sh
outline-cli invoke search.research \
  --args '{"question":"How do I find onboarding docs?","queries":["onboarding","engineering handbook"],"collectionQuery":"engineering","precisionMode":"precision","limitPerQuery":5,"view":"summary"}'
```

`search.expand` searches and then reads the top results in one step:

```sh
outline-cli invoke search.expand \
  --args '{"query":"incident runbook","collectionQuery":"engineering","expandLimit":3,"view":"summary"}'
```

`documents.answer` asks Outline's AI a question over a set of documents. If your workspace doesn't support that, the CLI falls back to retrieval and suggests a next call:

```sh
outline-cli invoke documents.answer \
  --args '{"question":"Who owns incident escalation?","documentQuery":"incident runbook","collectionQuery":"engineering"}'
```

## Read a document

`documents.info` accepts a UUID, a slug or a full document URL. URLs resolve against the profile you selected, so use the profile for that workspace.

```sh
outline-cli invoke documents.info \
  --args '{"id":"<document-id-or-url>","view":"summary"}'
```

Use `"view":"full"` for the whole text. To read several documents at once, pass `ids` with any mix of UUIDs, slugs and URLs:

```sh
outline-cli invoke documents.info \
  --args '{"ids":["<id-1>","<id-2>"],"view":"summary","concurrency":3}'
```

Each item in a multi-read has its own `ok` field, so one missing document doesn't hide the others.

## Open something by name

`documents.open` reads a document from an ID, a remembered title, a URL or a URL id in one call. It is strict: when a title match is weak, it returns candidates instead of guessing.

```sh
outline-cli invoke documents.open \
  --args '{"query":"engineering handbook","view":"summary"}'

outline-cli invoke documents.open_batch \
  --args '{"refs":["engineering handbook","https://handbook.example.com/doc/oncall-escalation-AbCdEf12"],"ids":["<document-id>"],"view":"summary"}'
```

`collections.open` and `collections.open_batch` do the same for collections.

## Browse collections

```sh
outline-cli invoke collections.list --args '{"query":"engineering","limit":10,"view":"summary"}'
outline-cli invoke collections.tree --args '{"query":"engineering","maxDepth":3,"view":"summary"}'
outline-cli invoke documents.list --args '{"collectionQuery":"engineering","rootOnly":true,"limit":20,"view":"ids"}'
```

`rootOnly` lists only the top-level pages of a collection. `documents.archived` lists archived documents, and `documents.deleted` lists deleted ones.

## Follow links and history

```sh
outline-cli invoke documents.backlinks --args '{"query":"incident runbook","view":"ids","limit":10}'
outline-cli invoke revisions.list --args '{"query":"incident runbook","limit":10,"view":"summary"}'
outline-cli invoke revisions.diff --args '{"query":"incident runbook","revisionPair":"latest","view":"summary"}'
outline-cli invoke events.list --args '{"documentQuery":"incident runbook","userQuery":"alice@example.com","auditLog":true,"limit":10}'
```

`revisions.diff` with `"revisionPair":"latest"` compares the latest two revisions. `documents.graph_neighbors`, `documents.graph_report` and `documents.issue_refs` map links between documents and extract issue-tracker references. Run `outline-cli tools contract <name>` for their arguments.

## How the CLI remembers names

After each successful read, search or list call, the CLI saves the titles, names, emails and URLs it saw in a local index for that profile. Later calls can use `query`, `documentQuery`, `collectionQuery` or `userQuery` to refer to them without a separate lookup. Nothing leaves your machine for this.

```sh
outline-cli invoke memory.lookup --args '{"query":"engineering handbook","type":"document","limit":5}'
outline-cli invoke memory.resolve --args '{"query":"engineering handbook","type":"document","hydrateLimit":1,"view":"summary"}'
outline-cli invoke memory.recent --args '{"type":"document","limit":10}'
```

`memory.lookup` and `memory.recent` use only the local index and make no network call. `memory.resolve` checks memory first, falls back to a live search when it has no match, and reads fresh metadata for the best match. Pass `"fallbackSearch":false` for memory-only behavior. `memory.remember` saves your own alias for a document, and `memory.clear` empties the index for the selected profile (or all with `allProfiles:true`). Both change only the local file, and both need `performAction:true`. `memory.stats` summarizes the index.

Documents that you delete through the CLI are removed from the index, so stale search results don't bring them back. The index file is `~/.cache/outline-cli/memory/observations.json` by default. [Commands](commands.md) lists the environment variable that moves it.
