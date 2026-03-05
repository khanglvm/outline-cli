import test from "node:test";
import assert from "node:assert/strict";
import {
  getKeychainMode,
  hydrateProfileFromKeychain,
  removeProfileFromKeychain,
  secureProfileForStorage,
} from "../src/secure-keyring.js";
import { CliError } from "../src/errors.js";

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("keychain mode normalization supports required/optional/disabled", () => {
  withEnv("OUTLINE_CLI_KEYCHAIN_MODE", "disabled", () => {
    assert.equal(getKeychainMode(), "disabled");
  });
  withEnv("OUTLINE_CLI_KEYCHAIN_MODE", "optional", () => {
    assert.equal(getKeychainMode(), "optional");
  });
  withEnv("OUTLINE_CLI_KEYCHAIN_MODE", "required", () => {
    assert.equal(getKeychainMode(), "required");
  });
  withEnv("OUTLINE_CLI_KEYCHAIN_MODE", "invalid", () => {
    assert.equal(getKeychainMode(), "required");
  });
});

test("secureProfileForStorage keeps inline secret when keychain mode is disabled", () => {
  withEnv("OUTLINE_CLI_KEYCHAIN_MODE", "disabled", () => {
    const profile = {
      name: "Local",
      baseUrl: "https://example.com",
      timeoutMs: 30000,
      headers: {},
      auth: {
        type: "apiKey",
        apiKey: "ol_api_123456789",
      },
    };
    const secured = secureProfileForStorage({
      configPath: "/tmp/config.json",
      profileId: "local",
      profile,
    });

    assert.equal(secured.keychain.used, false);
    assert.equal(secured.profile.auth.apiKey, "ol_api_123456789");
    assert.equal(secured.profile.auth.credentialStore, "config-inline");
  });
});

test("hydrateProfileFromKeychain fails fast when keychain mode disabled and secret is external", () => {
  withEnv("OUTLINE_CLI_KEYCHAIN_MODE", "disabled", () => {
    assert.throws(
      () =>
        hydrateProfileFromKeychain({
          configPath: "/tmp/config.json",
          profile: {
            id: "local",
            auth: {
              type: "apiKey",
              credentialStore: "os-keychain",
              credentialRef: {
                service: "com.khanglvm.outline-cli",
                account: "profile-auth:deadbeef:local",
              },
            },
          },
        }),
      (err) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.details?.code, "KEYCHAIN_DISABLED");
        return true;
      }
    );
  });
});

test("removeProfileFromKeychain is a no-op for inline credential storage", () => {
  const result = withEnv("OUTLINE_CLI_KEYCHAIN_MODE", "disabled", () =>
    removeProfileFromKeychain({
      configPath: "/tmp/config.json",
      profileId: "local",
      profile: {
        auth: {
          type: "password",
          credentialStore: "config-inline",
          username: "user@example.com",
          password: "secret",
        },
      },
    })
  );

  assert.equal(result.removed, false);
  assert.equal(result.reason, "inline-storage");
});
