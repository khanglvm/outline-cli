# Use with coding agents

A coding agent that drives outline-cli needs these exact details: setup, command grammar, output shapes, safety gates, error codes and limits. Follow them as written and do not invent flags or tool names.

## Setup check

Run these first. If both work, skip onboarding and do the task.

```sh
outline-cli --version
outline-cli profile list
```

If the command is missing, install it (Node.js 18.17 or newer is required):

```sh
npm i -g @khanglvm/outline-cli
```

If `profile list` shows no usable profile, read the built-in onboarding guide:

```sh
outline-cli tools help quick-start-agent --view full
```

An optional agent skill adds setup and workflow guidance. Install it only after the user approves:

```sh
npx skills add https://github.com/khanglvm/skills --skill outline-cli -y
```

To start an agent on an Outline task, paste this prompt:

```text
Use outline-cli for my Outline task. If missing, install it with
`npm i -g @khanglvm/outline-cli`. Check `outline-cli profile list` first.
If setup is missing, read `outline-cli tools help quick-start-agent --view full`.
Start with search or document reads using view:"summary". Read a document before
editing it, and use performAction:true only for changes I have asked for.
```

Every page of these docs is also published as plain text: `docs.khangle.dev/outline-cli/llms-full.txt` holds all of them in one file.

## Authentication

1. List profiles first with `outline-cli profile list`. Reuse a working profile.
2. For a new profile, prefer API key mode. The user creates the key in Outline at `<base-url>/settings/api-and-apps`.
3. The user exports the key as an environment variable. Never print, log or paste the key, and never write it to a tracked file.
4. Add and verify the profile:

   ```sh
   outline-cli profile add <id> --base-url <url> --auth-type apiKey --api-key "$OUTLINE_API_KEY" --set-default
   outline-cli profile test <id>
   ```

   `profile test` prints `{ "ok": true, "profile": "<id>", "user": {...}, "team": {...} }`.
5. Credentials are stored in the OS keychain. `OUTLINE_CLI_KEYCHAIN_MODE=optional` falls back to the config file when the keychain fails, and `disabled` always uses the config file. The default `required` makes `profile add` fail when there is no keychain.

Other auth types are `basic` and `password`. [Profiles](profiles.md) lists their flags.

## Calling tools

```sh
outline-cli invoke <tool> --args '<json object>'
outline-cli invoke <tool> --args-file args.json
outline-cli batch --ops '[{"tool":"<tool>","args":{},"profile":"<id>"}]'
outline-cli tools list
outline-cli tools contract <tool>
```

- Tool names use dots (`documents.search`). Underscores and common shorthands (`documents_search`, `docs.answer`) are corrected automatically, and the output then carries `requestedTool` and `toolResolution`.
- Pass `--profile <id>` to choose a profile. Without it the default profile is used.
- Quote the JSON for your shell. For long Markdown bodies, write the arguments to a file and use `--args-file`.
- Run `outline-cli tools contract <tool>` only after a validation failure or when you need a signature. The [tools](tools.md) page lists all 137 tools.

## Operating rules

1. Start with the most specific tool you know: `search.research`, `documents.search`, `documents.info` or `batch`.
2. Ask for `"view":"ids"` or `"view":"summary"` first. Use `"view":"full"` only for the documents you chose.
3. Put independent reads in one `batch` call.
4. Use `memory.recent` or `memory.lookup` (no network) for titles you saw earlier. Use `memory.resolve` when you need fresh metadata too.
5. Refer to documents by `id`, `url`, `query` (a title), `refs` (a mixed list), `documentQuery`, `collectionQuery` or `userQuery`, as the tool's signature allows.
6. Read a document before you change it. Preview with `documents.diff`.
7. For automated edits, use the revision-checked tools (`documents.safe_update`, `documents.apply_patch_safe`) with `"expectedRevision":"latest"`, or with a revision number from an earlier read when someone reviewed the change.
8. Set `"performAction":true` only on the final call, and only for changes the user asked for.
9. If output was moved to a file, read only the fields you need: `outline-cli tmp cat <file> | jq '<path>'`.
10. Fetch embedded images and files with `documents.attachments`, `attachments.download` or `documents.download_attachments`. Do not call `attachments.redirect` through `api.call`, because it returns binary data.

## Output shapes

Tool call (`invoke`):

```json
{ "tool": "documents.info", "profile": "work", "result": { } }
```

Optional fields: `profileRouting` (the CLI chose the profile), `requestedTool` and `toolResolution` (the tool name was corrected).

Batch (`batch`), items in input order:

```json
{ "ok": true, "total": 2, "failed": 0, "succeeded": 2,
  "items": [ { "index": 0, "tool": "documents.search", "profile": "work", "ok": true, "result": { } } ] }
```

A failed item is `{ "index", "tool", "profile", "ok": false, "error": {...} }`. `--item-envelope full` replaces each `result` with the full tool envelope.

Large result (over `--inline-max-bytes`, default 12000, in `--result-mode auto`):

```json
{ "ok": true, "stored": true, "file": "/abs/path.json", "bytes": 48213, "preview": { }, "hint": "..." }
```

Error (standard error, exit code 1):

```json
{ "ok": false, "error": { "type": "CliError", "message": "...", "code": "ACTION_GATED" } }
```

`type` is `CliError`, `ApiError` or a runtime error name. Extra fields depend on the code. `ApiError` carries fields such as `status` and `retryAfter`.

`--output ndjson` prints one object per line. Lists become `{"type":"meta",...}` followed by `{"type":"item","item":...}` lines, and tool results with `result.data[]` become a `meta` line followed by `{"type":"data","row":...}` lines. A stored result prints a `meta` line with `stored:true` and a `{"type":"file","file":...}` line.

`documents.info` with `view` other than `full` returns metadata and an excerpt, plus a `hint`. A multi-document read (`ids`) returns `result.total` and a per-item `ok`. Hydrated document rows include `sourceUrl` when it can be built, so you can cite sources.

## Safety gates

### performAction

Tools whose signature contains `performAction` need `"performAction":true` in `args`. Without it they fail with `ACTION_GATED` and the error shows `required` and `provided`. `documents.create` and `collections.create` have no gate. `api.call` is gated when the method name looks like a write.

### Delete

```sh
outline-cli invoke documents.info  --args '{"id":"<id>","armDelete":true,"view":"summary"}'
outline-cli invoke documents.delete --args '{"id":"<id>","readToken":"<deleteReadReceipt.token>","performAction":true}'
```

`deleteReadReceipt` has `token`, `documentId`, `revision`, `title`, `issuedAt`, `expiresAt` and `ttlSeconds`. The token expires after 900 seconds by default (`readTokenTtlSeconds`, 60 to 86400), belongs to one profile and one document, and works once. The delete fails when the document's revision changed after the read.

| Code | Cause |
| --- | --- |
| `DELETE_READ_TOKEN_REQUIRED` | `readToken` missing. |
| `DELETE_READ_TOKEN_INVALID` | Unknown or expired token. |
| `DELETE_READ_TOKEN_PROFILE_MISMATCH` | Token made by another profile. |
| `DELETE_READ_TOKEN_DOCUMENT_MISMATCH` | Token made for another document. |
| `DELETE_READ_TOKEN_STALE` | Revision changed since the read. Read again with `armDelete:true`. |
| `DELETE_TARGET_REQUIRED` | `api.call` delete without `body.id`. |

`documents.permanent_delete` is gated by `performAction` only, so confirm the target yourself.

### Revision checks

`documents.safe_update` and `documents.apply_patch_safe` return `result` with `"ok":false`, `"code":"revision_conflict"`, `"updated":false`, `expectedRevision` and `actualRevision` when the revision moved, and exit with code 0. Read again and rebuild the change. A patch that no longer applies returns `patch_apply_failed`. Do not retry blindly.

### Bulk plans

`documents.plan_batch_update` and `documents.plan_terminology_refactor` write nothing. They return `result.planHash`, `impacts[]`, `plan` and `next.args`. Show the impact to the user, then call `documents.apply_batch_plan` with `plan`, `confirmHash` equal to `planHash` and `performAction:true`. A changed plan fails with `PLAN_HASH_MISMATCH`. `dryRun:true` skips the write and the gate.

## Profile selection

Order: `--profile`, then the default profile, then the only saved profile. With several profiles and no default, a read-only call may auto-select when one profile matches clearly, and the output carries `profileRouting`. Otherwise the call fails with `PROFILE_SELECTION_REQUIRED` and `availableProfiles`. Calls that look like writes, or that set `performAction:true`, never auto-select. `PROFILE_NOT_FOUND` lists `availableProfiles`.

## Other error codes

| Code | Meaning |
| --- | --- |
| `ARG_VALIDATION_FAILED` | Arguments do not match the tool. The error holds `toolSignature` and `usageExample`. |
| `UNKNOWN_TOOL` | No such tool. `suggestions` lists close names. |
| `PROFILE_SELECTION_REQUIRED` | See above. |
| `PROFILE_NOT_FOUND` | The named profile does not exist. |
| `PLAN_HASH_MISMATCH` | The plan changed after the hash was made. |

## Limits

- Comment text: 1000 characters, checked before the call. `mentions` match names on the first name.
- `batch`: `--parallel` defaults to 4. `concurrency` arguments on several tools must be 8 or less.
- Inline output: 12000 bytes by default, then a file pointer.
- Request timeout: 30000 ms per profile. Retries on HTTP 429 and 5xx happen only when `maxAttempts` is above 1, with a wait of the `Retry-After` value or 400 ms times the attempt number.
- Exit codes: 0 success, 1 any error, 2 `batch --strict-exit` with a failed item. A batch with failed items exits 0 without `--strict-exit`, so check `failed`.
- Files: config `~/.config/outline-cli/config.json` (`OUTLINE_CLI_CONFIG`), results and delete receipts under `~/.cache/outline-cli/tmp` (`OUTLINE_CLI_TMP_DIR`), memory index `~/.cache/outline-cli/memory/observations.json` (`OUTLINE_CLI_MEMORY_FILE`).

More detail: [Commands](commands.md) for every flag, [Tools](tools.md) for every tool, and the built-in playbooks from `outline-cli tools help ai-skills --view full`.
