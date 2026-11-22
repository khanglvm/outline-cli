# AGENTS.md

This repository contains `outline-cli` (`outline-agent` alias), a Node.js CLI
for Outline API calls. Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) before
changing tools, running live tests, or preparing a release.

## Development

- Run `npm run check` and `npm test` for offline validation. Live account tests
  require explicit opt-in with `npm run test:integration` and an authorized test workspace.
- Preserve response envelopes, deterministic JSON, stream-friendly NDJSON, and
  temp-file offload for large results in `auto|file` modes.
- Prefer `summary/ids` reads before hydration and batch operations for fewer round trips.
- `batch` defaults to token-efficient item payloads; full envelopes remain opt-in.
- Every new tool argument needs a schema in `src/tool-arg-schemas.js`.
- Update the docs page that covers a change (see Docs) and `docs/TOOL_CONTRACTS.md` when behavior or signatures change.
- Keep source PR checks separate from the existing npm publishing workflow.

## Docs

`docs/` is the source of truth for this tool's documentation. docs.khangle.dev publishes the pages `docs/meta.json` lists, and llms.txt is built from the same pages for coding agents. The contract is in https://github.com/khanglvm/docs/blob/main/docs/CONTRACT.md. `docs/DEVELOPMENT.md` is for contributors and stays unlisted.

- When a change adds, removes or changes a command, flag, option, environment variable, tool, output format or default, update the docs page that covers it in the same commit. Add a page and list it in `docs/meta.json` when none covers it.
- Keep `docs/agents.md` exact: commands, flags, output shapes, error codes and limits, written for a coding agent. `docs/commands.md` and `docs/tools.md` must match `outline-cli --help`, `outline-cli tools list` and `src/tool-arg-schemas.js`.
- README sections between `<!-- docs:begin PAGE -->` and `<!-- docs:end -->` are generated. Edit the page in `docs/`, then run `node scripts/docs-readme.mjs`.
- Run `node scripts/docs-readme.mjs --check` before committing. CI runs the same check.
- Do not move or rename a published page without updating `docs/meta.json` and links to it.
- A change is finished when GitHub, docs.khangle.dev and the npm page all show it (the `doc-sync` workflow). npm shows the README of the latest published version only, so a change to README.md ships with a patch release: bump the version with `npm run release:prepare -- --bump patch` (or bump `package.json` and add the CHANGELOG entry by hand), merge it to `main`, and the publish workflow ships it. Then run `node scripts/docs-surfaces.mjs` until it exits 0.
- Each page opens with an H1 and a one or two sentence summary, which the site uses as its description. Use plain ASCII punctuation (no em dashes).

## Workspace safety

- Mutations require `performAction: true`.
- Delete only after reading the target with `documents.info` and `armDelete: true`.
  Pass its `deleteReadReceipt.token` as `readToken`, with `performAction: true`.
  Missing, stale, mismatched, or expired tokens must fail.
- Live mutation tests create dedicated test documents, edit only those documents,
  and delete them in cleanup. Existing workspace content is read-only during tests.
- Keep live secrets and `.env.test.local` out of tracked files. The secret guard
  must pass. Rotate exposed keys and update local configuration.

## Releases

Follow the release prerequisites and commands in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
When the user authorizes a release without specifying a version strategy, use
`npm run release -- --bump patch`. Source PR validation does not authorize a release.
