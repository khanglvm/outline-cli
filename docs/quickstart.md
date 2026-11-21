# Quickstart

Go from a saved profile to a search, a document read and a safe edit in a few commands. This assumes you finished [Install and connect](install.md).

Every command has the same shape: `outline-cli invoke <tool> --args '<json>'`. The tool name says what to do and the JSON holds its arguments.

## 1. Find a document

```sh
outline-cli invoke documents.search \
  --args '{"query":"onboarding","limit":5,"view":"summary"}'
```

`view` controls how much comes back. `ids` returns identifiers only, `summary` adds titles and short excerpts, and `full` returns everything. Start small and ask for more only when you need it.

## 2. Read it

Use the document's UUID, its slug or its full URL as the `id`:

```sh
outline-cli invoke documents.info \
  --args '{"id":"<document-id-or-url>","view":"full"}'
```

Without `"view":"full"`, you get metadata and a short excerpt, plus a hint on how to get the whole text. You can also write tool names with underscores, such as `documents_search`.

## 3. Preview an edit

`documents.diff` compares the current text with the text you propose and changes nothing:

```sh
outline-cli invoke documents.diff \
  --args '{"id":"<document-id>","proposedText":"# Onboarding\n\nUpdated body"}'
```

## 4. Apply an edit

Calls that change existing content need `"performAction":true`. Without it the CLI refuses with an `ACTION_GATED` error. This example appends a section:

```sh
outline-cli invoke documents.update \
  --args '{"id":"<document-id>","text":"\n\n## Follow-up\n- Added notes","editMode":"append","performAction":true,"view":"summary"}'
```

To avoid overwriting someone else's change, use `documents.safe_update` or `documents.apply_patch_safe`, which check the revision first. See [Edit documents](edit-documents.md).

## What next

- Work with several workspaces: [Profiles](profiles.md).
- Find things faster, including by title: [Search and read](search-and-read.md).
- Remove a document safely: [Delete documents](delete-documents.md).
- Every result is JSON. [Output and batch calls](output-and-batch.md) explains large results, NDJSON and running many operations in one call.
