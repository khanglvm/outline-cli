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
- Update `README.md` and `docs/TOOL_CONTRACTS.md` when behavior or signatures change.
- Keep source PR checks separate from the existing npm publishing workflow.

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
