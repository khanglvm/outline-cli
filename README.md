# outline-cli

<!-- docs:begin index.md -->
outline-cli searches and manages an Outline knowledge base from the terminal. You can find a runbook, read a document, download its attachments or update a page without opening the web app.

Start with a document title or a pasted URL. The CLI resolves it to a page and can return a short summary or just IDs, so a script or an agent reads only what it needs. For edits, you can preview a diff first and use patch tools that check the expected revision before writing.

Results are JSON, and profiles let you switch between workspaces. This is an independent project, not an official Outline tool.

### Where to go next

- [Install and connect](docs/install.md): install the CLI and save your first workspace profile.
- [Quickstart](docs/quickstart.md): search, read and edit a document in five minutes.
- [Profiles](docs/profiles.md), [search and read](docs/search-and-read.md), [edit](docs/edit-documents.md), [delete](docs/delete-documents.md), [comments, shares and attachments](docs/comments-shares-attachments.md) and [output and batch calls](docs/output-and-batch.md) cover each task.
- [Commands](docs/commands.md) and [tools](docs/tools.md) list every command, flag and tool.
- [Use with coding agents](docs/agents.md) is the exact, literal version for AI assistants.
<!-- docs:end -->

## Install and connect

<!-- docs:begin install.md -->
Install outline-cli from npm, then save a profile that points at your Outline workspace. It needs Node.js 18.17 or newer and an Outline API key.

```sh
npm i -g @khanglvm/outline-cli
outline-cli --version
```

The package installs the `outline-cli` command. The older `outline-agent` command is an alias for it. To update later, run `npm i -g @khanglvm/outline-cli@latest`.

### Connect to your workspace

1. In Outline, create an API key under Settings, then API & Apps. The page lives at `<your-outline-address>/settings/api-and-apps`.
2. Put the key in an environment variable in your shell, so it stays out of files and chat messages:

   ```sh
   export OUTLINE_API_KEY=ol_api_...
   ```

3. Save a profile. Replace the URL with the address you use to open Outline, and pick any profile name (`work` here):

   ```sh
   outline-cli profile add work \
     --base-url https://docs.example.com \
     --auth-type apiKey \
     --api-key "$OUTLINE_API_KEY" \
     --set-default
   ```

4. Check that it works:

   ```sh
   outline-cli profile test work
   ```

   A working profile prints `"ok": true` with your `user` and `team`.

The CLI cleans up the base URL for you. It adds `https://` when the scheme is missing and drops a trailing `/api`, a query string and a hash. The `endpoint` field in the `profile add` output lists each correction it made.

### Where credentials are stored

By default the CLI saves the API key (or password) in your operating system's keychain and keeps only a reference in the config file at `~/.config/outline-cli/config.json`. Set `OUTLINE_CLI_KEYCHAIN_MODE` to change that:

| Value | Behavior |
| --- | --- |
| `required` (default) | Store credentials in the keychain. `profile add` fails if the keychain is unavailable. |
| `optional` | Try the keychain, and fall back to storing credentials in the config file when it fails. |
| `disabled` | Never use the keychain. Credentials stay in the config file. |

Use `optional` or `disabled` on machines without a keychain, such as a bare CI runner. `OUTLINE_CLI_CONFIG` moves the config file. See [Profiles](docs/profiles.md) for all profile commands and [Commands](docs/commands.md) for every environment variable.

Next, follow the [quickstart](docs/quickstart.md) to run your first search.
<!-- docs:end -->

## Quickstart

<!-- docs:begin quickstart.md -->
Go from a saved profile to a search, a document read and a safe edit in a few commands. This assumes you finished [Install and connect](docs/install.md).

Every command has the same shape: `outline-cli invoke <tool> --args '<json>'`. The tool name says what to do and the JSON holds its arguments.

### 1. Find a document

```sh
outline-cli invoke documents.search \
  --args '{"query":"onboarding","limit":5,"view":"summary"}'
```

`view` controls how much comes back. `ids` returns identifiers only, `summary` adds titles and short excerpts, and `full` returns everything. Start small and ask for more only when you need it.

### 2. Read it

Use the document's UUID, its slug or its full URL as the `id`:

```sh
outline-cli invoke documents.info \
  --args '{"id":"<document-id-or-url>","view":"full"}'
```

Without `"view":"full"`, you get metadata and a short excerpt, plus a hint on how to get the whole text. You can also write tool names with underscores, such as `documents_search`.

### 3. Preview an edit

`documents.diff` compares the current text with the text you propose and changes nothing:

```sh
outline-cli invoke documents.diff \
  --args '{"id":"<document-id>","proposedText":"# Onboarding\n\nUpdated body"}'
```

### 4. Apply an edit

Calls that change existing content need `"performAction":true`. Without it the CLI refuses with an `ACTION_GATED` error. This example appends a section:

```sh
outline-cli invoke documents.update \
  --args '{"id":"<document-id>","text":"\n\n## Follow-up\n- Added notes","editMode":"append","performAction":true,"view":"summary"}'
```

To avoid overwriting someone else's change, use `documents.safe_update` or `documents.apply_patch_safe`, which check the revision first. See [Edit documents](docs/edit-documents.md).

### What next

- Work with several workspaces: [Profiles](docs/profiles.md).
- Find things faster, including by title: [Search and read](docs/search-and-read.md).
- Remove a document safely: [Delete documents](docs/delete-documents.md).
- Every result is JSON. [Output and batch calls](docs/output-and-batch.md) explains large results, NDJSON and running many operations in one call.
<!-- docs:end -->

## For AI agents

Point your coding assistant at the [agent guide](https://github.com/khanglvm/outline-cli/blob/main/docs/agents.md). It has the setup check, a prompt to paste, exact commands, output shapes and safety gates. An optional [agent skill](https://github.com/khanglvm/skills/tree/main/outline-cli) adds setup and workflow guidance for your tools.

## Development

Run the CLI smoke check and offline unit tests from a checkout:

```sh
npm run check
npm test
```

These checks need no Outline account. Live workspace tests require explicit
opt-in with `npm run test:integration`. See the [development guide](docs/DEVELOPMENT.md)
for account setup, test cleanup, source PR checks, and releases.

## More help

- The guides and the command and tool reference are published at [docs.khangle.dev](https://docs.khangle.dev). The same pages live in [docs/](https://github.com/khanglvm/outline-cli/tree/main/docs).
- `outline-cli tools list` lists tools; `outline-cli tools contract <name>` shows an individual tool's arguments.
- [Development](https://github.com/khanglvm/outline-cli/blob/main/docs/DEVELOPMENT.md) · [Changelog](CHANGELOG.md)
