# Edit documents

Create and change documents, from a plain update to revision-checked patches and bulk renames. Most calls that change data need `"performAction":true`.

## The action gate

A call that updates, deletes or reshares content stops with an `ACTION_GATED` error unless its arguments include `"performAction":true`. Reads never need it. Treat the flag as the last step: read, preview, then set it on the final call. `documents.create` and `collections.create` are the exceptions: they don't check the flag, so they create content as soon as you run them. `outline-cli tools contract <name>` shows `performAction` in the signature of every gated tool.

## Create a document

```sh
outline-cli invoke documents.create \
  --args '{"title":"Release Notes","text":"# Release Notes","collectionId":"<collection-id>","publish":false,"view":"summary"}'
```

With `"publish":false` the document stays a draft. Set `"publish":true` when you know the collection or parent document. For long Markdown, put the arguments in a JSON file and use `--args-file args.json` to avoid shell quoting problems.

## Update a document

```sh
outline-cli invoke documents.update \
  --args '{"id":"<document-id>","text":"\n\nUpdated by automation.","editMode":"append","performAction":true,"view":"summary"}'
```

`editMode` is `replace`, `append` or `prepend`. For `append` and `prepend`, send only the new text, not the whole document.

## Preview before you write

`documents.diff` shows a line-level diff between the current text and the text you propose. It changes nothing, and you can target the document by `id` or by a remembered `query` title:

```sh
outline-cli invoke documents.diff \
  --args '{"query":"incident runbook","proposedText":"# Incident Runbook\n\nUpdated body"}'
```

## Guard against someone else's edit

Two people, or two agents, can change a document between your read and your write. The safe tools compare the revision first:

```sh
outline-cli invoke documents.apply_patch_safe \
  --args '{"query":"incident runbook","expectedRevision":"latest","patch":"@@ -1,1 +1,1 @@\n-Old\n+New","performAction":true}'

outline-cli invoke documents.safe_update \
  --args '{"query":"incident runbook","expectedRevision":"latest","text":"\n\n## Changes\n- added new action","editMode":"append","performAction":true}'
```

- `expectedRevision` is a revision number from an earlier read, or `"latest"`, which means the revision read inside this same call.
- When the revision changed, nothing is written. The result has `"ok":false`, `"code":"revision_conflict"`, `"updated":false` and both revision numbers. Read the document again and rebuild your change.
- `documents.apply_patch_safe` takes a unified diff (`"mode":"unified"`, the default) or a full replacement (`"mode":"replace"`). If the patch no longer applies, it reports `patch_apply_failed`.
- `documents.apply_patch` is the same without the mandatory revision check.

To change several documents at once, use `documents.batch_update`. Each item gets its own result, and `"continueOnError":false` stops at the first failure.

```sh
outline-cli invoke documents.batch_update \
  --args '{"updates":[{"query":"incident runbook","expectedRevision":"latest","text":"\n\nUpdated","editMode":"append"},{"url":"https://handbook.example.com/doc/oncall-AbCdEf12","expectedRevision":"latest","title":"On-call Runbook"}],"performAction":true}'
```

Items named by a title or other fuzzy reference need `expectedRevision`.

## Rename or refactor across documents

Plan first, review, then apply. `documents.plan_batch_update` finds documents and previews the replacements without writing:

```sh
outline-cli invoke documents.plan_batch_update \
  --args '{"query":"incident communication","rules":[{"field":"both","find":"SEV1","replace":"SEV-1","wholeWord":true}],"maxDocuments":20}'
```

The result lists each affected document, its replacement counts and a `planHash`. To apply the plan, pass the plan and its hash to `documents.apply_batch_plan`. A changed plan fails with `PLAN_HASH_MISMATCH`, and `"dryRun":true` checks everything without writing.

```sh
outline-cli invoke documents.apply_batch_plan \
  --args '{"plan":{...},"confirmHash":"<planHash>","performAction":true}'
```

`documents.plan_terminology_refactor` builds the same kind of plan from a `glossary` or a `map` of old to new terms.

## Templates

```sh
outline-cli invoke templates.extract_placeholders \
  --args '{"templateQuery":"incident postmortem"}'

outline-cli invoke documents.create_from_template \
  --args '{"templateQuery":"incident postmortem","title":"Service A - Incident Postmortem","placeholderValues":{"service_name":"Service A","owner":"SRE Team"},"strictPlaceholders":true,"publish":true,"performAction":true}'
```

`templates.extract_placeholders` lists the `{{key}}` names in a template. With `strictPlaceholders`, creation fails when a placeholder has no value.

## Revisions

`revisions.list` and `revisions.diff` show history (see [Search and read](search-and-read.md)). `revisions.restore` restores a document to a revision and needs `performAction:true`. Deleting is covered in [Delete documents](delete-documents.md).
