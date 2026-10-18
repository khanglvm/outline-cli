# Development

[Back to the README](../README.md)

## Offline checks

Run the CLI smoke check and unit tests from the repository root:

```bash
npm run check
npm test
```

`npm test` selects the eleven existing `test/*.unit.test.js` files. These checks
need no Outline account, saved profile, or `.env.test.local`. The CLI smoke check
runs `--help` and verifies the committed entry-integrity metadata.

## Live integration tests

Use an authorized Outline test workspace. Provide `OUTLINE_TEST_BASE_URL` and
`OUTLINE_TEST_API_KEY` in the environment or a local env file:

```bash
cp .env.test.example .env.test.local
# set OUTLINE_TEST_BASE_URL and OUTLINE_TEST_API_KEY
```

Run the live suite explicitly:

```bash
npm run test:integration
```

This command selects `test/live.integration.test.js`, which loads real account
configuration and can mutate the workspace. Keep it out of offline validation;
filtering by test name still loads the module and its setup.

Live test rules:

- Mutation tests create dedicated test documents, edit only those documents,
  and delete them in cleanup. Never mutate existing workspace content in tests.
- Read-only tests may use site-wide data.
- Exercise real endpoints in integration tests instead of mocking them when
  they can be tested live. Keep steps isolated with subtests and clear assertions.

## Source pull request checks

`.github/workflows/source-checks.yml` runs on `pull_request` with Node 24 on
Ubuntu 24.04. It installs locked dependencies with `npm ci --ignore-scripts`,
runs `npm run check` and `npm test`, and scans tracked source for Outline API
keys and local environment files without loading the live suite. The lockfile
supplies platform-specific keyring binaries as optional dependencies without
install lifecycle scripts.

The job disables keychain access and uses `OUTLINE_CLI_SKIP_INTEGRITY_CHECK=1`
for unsigned source validation. Source edits can invalidate committed integrity
hashes, so these checks use the existing bypass without a signing key. Normal
CLI use retains integrity checks, and publishing still refreshes and verifies
integrity with the production signing key.

The source workflow pins checkout and setup-node to immutable commits, requests
only `contents: read`, and disables persisted checkout credentials. It needs no
Outline account or configured secrets and has no publication step. Releases use
the separate `.github/workflows/npm-auto-publish.yml` workflow described below.

## Tool changes

Before implementation, inspect the current tool contracts:

```bash
node ./bin/outline-cli.js tools contract all --result-mode inline
```

For API additions, compare wrapped `client.call` methods with the raw API method
inventory from prior sessions or wrappers. Record missing high-value endpoints
in `/tmp/knowledges/outline-raw-api-gap.md`. Keep scratch notes under
`/tmp/knowledges/*.md` outside version control.

Preserve response envelopes and output modes. Add argument schemas in
`src/tool-arg-schemas.js`, cover live endpoint changes in
`test/live.integration.test.js`, and update `README.md` and
`docs/TOOL_CONTRACTS.md` when behavior or signatures change. Run offline checks
first; run integration tests only with an authorized test workspace.

## Releases

Standard release flow:

```bash
npm run release -- --bump patch
```

Run release commands only for an authorized release. Use the patch bump by
default unless the user specifies another version or tag strategy. An explicit
version can be passed with `npm run release -- --version X.Y.Z`.

This flow performs:

- Version bump
- `CHANGELOG.md` update
- Integrity refresh (`npm run integrity:refresh`)
- Verification (`npm run check`, `npm test`)
- Packaging validation (`npm pack --dry-run`)
- `npm publish --access public`
- Git commit, tag, and push to `origin`

Prepare without publishing/pushing:

```bash
npm run release:prepare -- --bump patch
```

Release prerequisites:

- Clean working tree (unless you intentionally pass `--allow-dirty`)
- `OUTLINE_ENTRY_BUILD_KEY` available in environment or `.env.local`
- npm auth ready (`npm login`)

GitHub publishing uses `.github/workflows/npm-auto-publish.yml` and npm trusted
publishing. A changed version on `main`, or a matching `v<version>` tag, publishes
that exact version if it is missing from npm. Stable versions use `latest`;
prereleases use `next`. README changes do not create releases.

Manual runs default to a dry run. Configure npm to trust this repository and
workflow filename; an npm token is not required. Publishing CI runs the CLI check
and unit tests. The live integration suite requires separate operator opt-in
and a real Outline test account.

CI refreshes entry-integrity manifests with the production
`OUTLINE_ENTRY_BUILD_KEY` GitHub Actions secret before checking and packing the
release. A missing or invalid key fails the run; CI never uses the development
fallback. Local releases use the same key. This signing key is separate from
npm authentication, which uses trusted publishing.
