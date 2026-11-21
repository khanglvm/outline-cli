# Output and batch calls

Every command prints JSON. Choose an output format, control what happens to large results, and run many operations in one call.

## Output formats

Set the format with `--output` on `invoke`, `batch`, `tools` and `tmp` commands:

- `--output json` (the default) prints one JSON document. Add `--pretty` to indent it.
- `--output ndjson` prints one JSON object per line, which suits streaming and `jq`. Lists become a `meta` line followed by one line per item.

A single tool call prints an envelope with the tool name, the profile and the result:

```json
{ "tool": "documents.info", "profile": "work", "result": { } }
```

Errors go to standard error as JSON with `ok: false`, and the process exits with code 1:

```json
{ "ok": false, "error": { "type": "CliError", "message": "...", "code": "ACTION_GATED" } }
```

## Large results

By default (`--result-mode auto`), a result bigger than 12,000 bytes is written to a temporary file and the command prints a pointer instead:

```json
{ "ok": true, "stored": true, "file": "/path/to/result.json", "bytes": 48213, "preview": {}, "hint": "..." }
```

Change the behavior with `--result-mode inline` (always print the whole result), `--result-mode file` (always write a file) or `--inline-max-bytes <n>` (move the threshold). `--tmp-dir <path>` picks the folder for these files.

Work with stored files through the `tmp` commands:

```sh
outline-cli tmp list
outline-cli tmp cat /absolute/path/from/result.json
outline-cli tmp rm /absolute/path/from/result.json
outline-cli tmp gc --max-age-hours 24
```

`tmp cat` prints the file, so you can pipe it to `jq` and read only the fields you need. `tmp gc` deletes files older than the age you give (24 hours by default). The default folder is `~/.cache/outline-cli/tmp`.

## Batch calls

`batch` runs several tool calls in one process. Operations run in parallel, so don't rely on their order:

```sh
outline-cli batch --ops '[
  {"tool":"collections.list","args":{"limit":5,"view":"summary"}},
  {"tool":"documents.search","args":{"query":"incident","limit":5,"view":"ids"}}
]'
```

Each operation has `tool`, optional `args` and an optional `profile`, so one batch can read from several workspaces. For a long list, use `--ops-file ops.json`.

The output reports totals and one item per operation, in the order you gave them:

```json
{ "ok": true, "total": 2, "failed": 0, "succeeded": 2,
  "items": [ { "index": 0, "tool": "collections.list", "profile": "work", "ok": true, "result": { } } ] }
```

A failed item has `"ok": false` and an `error` object instead of a `result`, and the other items still run. The batch's own `ok` is `false` when any item failed.

| Flag | Default | What it does |
| --- | --- | --- |
| `--parallel <n>` | `4` | How many operations run at once. |
| `--item-envelope <mode>` | `compact` | `compact` returns each item's `result` only. `full` returns the whole tool envelope. |
| `--strict-exit` | off | Exit with code 2 when any operation failed. |

Without `--strict-exit`, a batch with failed items still exits with code 0, so check `failed` in the output.
