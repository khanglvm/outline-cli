# Install and connect

Install outline-cli from npm, then save a profile that points at your Outline workspace. It needs Node.js 18.17 or newer and an Outline API key.

```sh
npm i -g @khanglvm/outline-cli
outline-cli --version
```

The package installs the `outline-cli` command. The older `outline-agent` command is an alias for it. To update later, run `npm i -g @khanglvm/outline-cli@latest`.

## Connect to your workspace

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

## Where credentials are stored

By default the CLI saves the API key (or password) in your operating system's keychain and keeps only a reference in the config file at `~/.config/outline-cli/config.json`. Set `OUTLINE_CLI_KEYCHAIN_MODE` to change that:

| Value | Behavior |
| --- | --- |
| `required` (default) | Store credentials in the keychain. `profile add` fails if the keychain is unavailable. |
| `optional` | Try the keychain, and fall back to storing credentials in the config file when it fails. |
| `disabled` | Never use the keychain. Credentials stay in the config file. |

Use `optional` or `disabled` on machines without a keychain, such as a bare CI runner. `OUTLINE_CLI_CONFIG` moves the config file. See [Profiles](profiles.md) for all profile commands and [Commands](commands.md) for every environment variable.

Next, follow the [quickstart](quickstart.md) to run your first search.
