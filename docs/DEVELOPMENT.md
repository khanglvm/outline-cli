# Development

[Back to the README](../README.md)

## Live tests

Set test credentials in a local env file:

```bash
cp .env.test.example .env.test.local
# set OUTLINE_TEST_BASE_URL and OUTLINE_TEST_API_KEY
```

Run checks:

```bash
npm run check
npm test
```

Test rules in this repository:

- Mutation tests create and clean up their own test documents.
- Read-only tests may use site-wide data.

## Releases

Standard release flow:

```bash
npm run release -- --bump patch
```

This flow performs:

- Version bump
- `CHANGELOG.md` update
- Integrity refresh (`npm run integrity:refresh`)
- Verification (`npm run check`, `npm test`)
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
workflow filename; an npm token is not required. CI runs the CLI check and unit
tests. The live integration suite still requires a real Outline test account.

Commit valid entry-integrity manifests with each source release. Refresh them
locally with `OUTLINE_ENTRY_BUILD_KEY` before pushing a new version. CI checks
the committed manifests and never regenerates them with a development key.
