# outline-cli

Search and manage your [Outline](https://www.getoutline.com/) knowledge base
from the terminal. Find a runbook, read a document, download its attachments,
or update a page without opening the web app.

Start with a document title or pasted URL. The CLI resolves it to a page and
can return a short summary or just IDs, so a script or agent can read only
what it needs. For edits, you can preview a diff and use patch tools that
check the expected revision before writing.

Results are JSON, and profiles let you switch between workspaces. This is an
independent project, not an official Outline tool.

## Install and connect

Requires Node.js 18.17 or newer and access to an Outline workspace.

```sh
npm i -g @khanglvm/outline-cli
```

Create an API key in your workspace under **Settings → API & Apps**. Set
`OUTLINE_API_KEY` in your local environment, then replace the example URL
with the address you use to open Outline:

```sh
outline-cli profile add work \
  --base-url https://docs.example.com \
  --auth-type apiKey \
  --api-key "$OUTLINE_API_KEY" \
  --set-default
outline-cli profile test work
```

Credentials go into your OS keychain by default. Keep API keys out of source
files and chat messages.

## Find your first document

```sh
outline-cli invoke documents.search \
  --args '{"query":"onboarding","limit":5,"view":"summary"}'
```

Copy a document ID from the result to read its contents:

```sh
outline-cli invoke documents.info \
  --args '{"id":"<document-id>","view":"full"}'
```

You can also create drafts, edit pages, manage comments, and inspect revision
history. Writes require `performAction:true`. Deleting a document also requires
a token from a prior read. See the [usage guide](https://github.com/khanglvm/outline-cli/blob/main/docs/USAGE.md) for examples.

## For AI agents

Paste this into your coding assistant:

```text
Use outline-cli for my Outline task. If missing, install it with
`npm i -g @khanglvm/outline-cli`. Check `outline-cli profile list` first.
If setup is missing, read `outline-cli tools help quick-start-agent --view full`.
Start with search or document reads using view:"summary". Read a document before
editing it, and use performAction:true only for changes I have asked for.
```

An optional [agent skill](https://github.com/khanglvm/skills/tree/main/outline-cli)
is available with setup and workflow guidance:

```sh
npx skills add https://github.com/khanglvm/skills --skill outline-cli -y
```

## More help

- [Usage guide](https://github.com/khanglvm/outline-cli/blob/main/docs/USAGE.md): profiles, editing, attachments, batch calls, and safe deletion.
- `outline-cli tools list` lists tools; `outline-cli tools contract <name>` shows an individual tool's arguments.
- [Development](https://github.com/khanglvm/outline-cli/blob/main/docs/DEVELOPMENT.md) · [Changelog](CHANGELOG.md)

The older `outline-agent` command is an alias for `outline-cli`.
