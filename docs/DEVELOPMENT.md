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

Optional GitHub automation:

- `.github/workflows/npm-auto-publish.yml` auto-publishes on pushes to `main` when `README.md` or `package.json` changes.
- If `package.json` version changes, the workflow publishes that exact version.
- If only docs metadata changes (for example `README.md`), the workflow cuts and publishes a patch release automatically.
- Required repository secrets: `NPM_TOKEN` and `OUTLINE_ENTRY_BUILD_KEY`.
- Ensure GitHub Actions can push to `main` and create tags in this repository.
