# Commands

Look up any outline-cli command, flag, environment variable, file location or exit code here. Tools that run through `invoke` are listed on the [tools](tools.md) page.

## Command overview

| Command | What it does |
| --- | --- |
| `outline-cli profile add <id>` | Add or update a profile. |
| `outline-cli profile list` | List saved profiles. |
| `outline-cli profile suggest <query>` | Rank profiles against a text query. |
| `outline-cli profile show [id]` | Show one profile with secrets redacted. |
| `outline-cli profile annotate <id>` | Set a profile's description and keywords. |
| `outline-cli profile enrich <id>` | Update description and keywords from usage hints. |
| `outline-cli profile use <id>` | Set the default profile. |
| `outline-cli profile remove <id>` | Remove a profile and its keychain entry. |
| `outline-cli profile test [id]` | Check the login by calling `auth.info`. |
| `outline-cli invoke <tool>` | Run one tool. |
| `outline-cli batch` | Run several tools in one call. |
| `outline-cli tools list` | List tool names, signatures and descriptions. |
| `outline-cli tools contract [name]` | Show a tool's signature, example and best practices. |
| `outline-cli tools help [section]` | Show agent playbooks. |
| `outline-cli tmp list`, `cat <file>`, `rm <file>`, `gc` | Manage stored large results. |
| `outline-cli --version`, `outline-cli --help` | Print the version or the help text. |

`outline-agent` is an alias for `outline-cli`, and it takes the same commands.

## Shared options

These work on `invoke`, `batch`, `tools`, `tmp`, `profile test` and, except where noted, the read-only `profile` commands.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--config <path>` | `~/.config/outline-cli/config.json` | Config file. |
| `--profile <id>` | the default profile | Profile to use. Not available on `profile` subcommands other than `test`. |
| `--output <format>` | `json` | `json` or `ndjson`. |
| `--result-mode <mode>` | `auto` | `auto`, `inline` or `file`. |
| `--inline-max-bytes <n>` | `12000` | In `auto` mode, the size above which a result goes to a file. |
| `--tmp-dir <path>` | `~/.cache/outline-cli/tmp` | Folder for result files. |
| `--pretty` | off | Indent JSON output. |

## invoke

```sh
outline-cli invoke <tool> [--args <json> | --args-file <path>] [shared options]
```

`--args` takes a JSON object and `--args-file` reads one from a file. With neither, the arguments are empty. The result is `{ "tool", "profile", "result" }`, plus `profileRouting` when the CLI chose the profile and `requestedTool` and `toolResolution` when it corrected the tool name.

Invalid arguments fail with `ARG_VALIDATION_FAILED`. The error carries the tool's `toolSignature`, a `usageExample` and a `contractHint`. An unknown tool name fails with `UNKNOWN_TOOL` and `suggestions`.

## batch

```sh
outline-cli batch (--ops <json> | --ops-file <path>) [--parallel <n>] [--item-envelope compact|full] [--strict-exit]
```

`--ops` is a JSON array of `{ "tool", "args", "profile" }` objects. See [Output and batch calls](output-and-batch.md) for the output shape. Defaults are `--parallel 4` and `--item-envelope compact`.

## profile add

```sh
outline-cli profile add <id> --base-url <url> [options]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--base-url <url>` | required | Outline address, such as `https://docs.example.com`. |
| `--auth-type <type>` | inferred | `apiKey`, `basic` or `password`. |
| `--api-key <key>` | none | API key for `apiKey`. |
| `--username <name>`, `--password <value>` | none | Login for `basic` or `password`. |
| `--token-endpoint <url>` | none | Token exchange endpoint for `password`. |
| `--token-field <field>` | `access_token` | Field that holds the token in the response. |
| `--token-body <json>`, `--token-body-file <path>` | none | Extra JSON body for the token request. |
| `--name <name>` | the id | Friendly name. |
| `--description <text>` | generated | Description used for profile routing. |
| `--keywords <csv>` | generated | Keywords used for profile routing. |
| `--metadata-hints <csv>` | none | Hints for generating the description and keywords. |
| `--no-auto-metadata` | off | Skip generating the description and keywords. |
| `--timeout-ms <n>` | `30000` | Request timeout. |
| `--headers <csv>` | none | Extra headers as `key:value` pairs. |
| `--set-default` | off | Make this the default profile. |

The output includes `profile` (redacted), `endpoint` (the normalized URL and any corrections), `metadata` and `security` (whether the keychain was used).

## Other profile commands

| Command | Flags |
| --- | --- |
| `profile list` | Shared output flags. Output: `configPath`, `defaultProfile` and `profiles[]` with `isDefault`. |
| `profile suggest <query>` | `--limit <n>` (default 5), shared output flags. |
| `profile show [id]` | Shared output flags. |
| `profile annotate <id>` | `--description`, `--clear-description`, `--keywords`, `--append-keywords`, `--clear-keywords`. |
| `profile enrich <id>` | `--query`, `--queries <csv>`, `--hints <csv>`, `--titles <csv>`, `--urls <csv>`, `--max-keywords <n>` (default 20), `--refresh-description`, `--discover`, `--dry-run`. |
| `profile use <id>` | None. |
| `profile remove <id>` | `--force` allows removing the default profile. |
| `profile test [id]` | Shared options. Output: `{ "ok", "profile", "user", "team" }`. |

`profile enrich --discover` calls `auth.info` to add workspace and user hints. All `profile` subcommands accept `--config <path>`.

## tools and tmp

| Command | Flags |
| --- | --- |
| `tools list` | Shared options. |
| `tools contract [name]` | `--pretty`. A missing name, or `all`, returns every contract. |
| `tools help [section]` | `--view summary\|full` (default `summary`), `--scenario <id>`, `--skill <id>`, `--query <text>`. |
| `tmp list` | Lists stored result files. |
| `tmp cat <file>` | Prints a stored file. |
| `tmp rm <file>` | Removes a stored file. |
| `tmp gc` | `--max-age-hours <n>` (default 24) deletes older files. |

`tools help` sections are `quick-start-agent` (first-time setup, also reachable as `setup`, `onboarding` and similar names) and `ai-skills` (scenario playbooks, also `ai` or `skills`). With no section, it lists them. The `--scenario`, `--skill` and `--query` filters apply to `ai-skills`.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `OUTLINE_CLI_CONFIG` | Config file path. Overrides the default location. |
| `OUTLINE_CLI_TMP_DIR` | Folder for result files and delete receipts. Default `~/.cache/outline-cli/tmp`. |
| `OUTLINE_CLI_MEMORY_FILE` | Local memory index. Default `~/.cache/outline-cli/memory/observations.json`. |
| `OUTLINE_CLI_KEYCHAIN_MODE` | `required` (default), `optional` or `disabled`. |
| `OUTLINE_CLI_KEYCHAIN_SERVICE` | Keychain service name. Default `com.khanglvm.outline-cli`. |

The older `OUTLINE_AGENT_CONFIG`, `OUTLINE_AGENT_TMP_DIR`, `OUTLINE_AGENT_MEMORY_FILE` and `OUTLINE_AGENT_KEYCHAIN_MODE` names still work when the `OUTLINE_CLI_` one is not set. When only `~/.config/outline-agent/config.json` exists, the CLI uses it.

## Files

| Path | Contents |
| --- | --- |
| `~/.config/outline-cli/config.json` | Profiles and the default profile. Credentials are here only when the keychain isn't used. |
| `~/.cache/outline-cli/tmp/` | Large results, named with a timestamp and a label. |
| `~/.cache/outline-cli/tmp/action-gates/delete-read-receipts.json` | Delete read tokens (mode 0600). |
| `~/.cache/outline-cli/memory/observations.json` | Local memory index. |

## Exit codes and limits

| Code | Meaning |
| --- | --- |
| `0` | Success. A `batch` with failed items also exits 0 unless you pass `--strict-exit`. |
| `1` | Any error. The error JSON goes to standard error. |
| `2` | `batch --strict-exit` and at least one operation failed. |

The request timeout is 30000 ms per profile unless you set `--timeout-ms`. Requests that fail with HTTP 429 or a 5xx status are retried when the call's `maxAttempts` is above 1, waiting for the server's `Retry-After` header, or `400 ms` times the attempt number when there isn't one. Many tools accept `maxAttempts`, and write tools default to one attempt.
