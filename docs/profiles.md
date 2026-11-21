# Profiles

A profile stores the address and login for one Outline workspace. Keep one profile per workspace and switch between them with a flag or a default.

## Add a profile

API keys are the recommended login. Create one under Settings, then API & Apps in Outline.

```sh
outline-cli profile add work \
  --base-url https://docs.example.com \
  --auth-type apiKey \
  --api-key "$OUTLINE_API_KEY" \
  --set-default
```

Other login modes:

| `--auth-type` | Required flags | What it does |
| --- | --- | --- |
| `apiKey` | `--api-key` | Sends the key as a bearer token. |
| `basic` | `--username`, `--password` | Sends HTTP Basic credentials. |
| `password` | `--username`, `--password` | With `--token-endpoint`, exchanges the login for a token. The token is read from `--token-field` (default `access_token`), and extra request fields go in `--token-body` or `--token-body-file`. Without an endpoint it sends Basic credentials. |

```sh
outline-cli profile add internal \
  --base-url https://outline.company.com \
  --auth-type password \
  --username agent@company.com \
  --password "$OUTLINE_PASSWORD"
```

You can leave out `--auth-type` when you pass `--api-key`, or both `--username` and `--password`. Other optional flags are `--name`, `--timeout-ms` (default 30000) and `--headers` (comma-separated `key:value` pairs sent on every request). Credentials go to your OS keychain unless you changed `OUTLINE_CLI_KEYCHAIN_MODE`, as described in [Install and connect](install.md).

## List, test, select and remove

```sh
outline-cli profile list              # all profiles, with isDefault set on the default
outline-cli profile show work         # one profile, with secrets redacted
outline-cli profile test work         # calls auth.info with that profile
outline-cli profile use work          # make it the default
outline-cli profile remove old        # add --force to remove the default one
```

## Pick a profile for a command

Add `--profile <id>` to `invoke`, `batch` or `profile test`:

```sh
outline-cli invoke documents.search --profile work --args '{"query":"handbook"}'
```

The CLI picks the profile in this order:

1. The `--profile` flag.
2. The default profile set with `profile use` or `--set-default`.
3. The only profile, when you saved exactly one.
4. With several profiles and no default, a read-only call may choose a profile by matching your query against the profile descriptions and keywords, but only when one match is clearly better. Otherwise the command stops with a `PROFILE_SELECTION_REQUIRED` error that lists the available profiles. A call that looks like a write (its tool name contains create, update, delete and similar words, or it sets `performAction:true`) never auto-selects.

When the CLI chose the profile for you, the result includes a `profileRouting` field that says so.

## Help the CLI route between workspaces

Descriptions and keywords feed the automatic choice in step 4:

```sh
outline-cli profile annotate prod \
  --description "Production knowledge base" \
  --append-keywords "prod,runbook,incident"

outline-cli profile enrich prod \
  --query "incident escalation process" \
  --titles "Incident Playbook,Escalation Matrix"

outline-cli profile suggest "incident runbook"   # which profile matches this text?
```

`profile add` generates a description and keywords from the name and URL unless you pass `--no-auto-metadata`. `profile enrich --dry-run` shows what would change without saving.

## Where the config lives

The config file is `~/.config/outline-cli/config.json`, or the older `~/.config/outline-agent/config.json` when only that one exists. Point to another file with the `--config` flag or the `OUTLINE_CLI_CONFIG` environment variable.
