import crypto from "node:crypto";
import path from "node:path";
import { Entry } from "@napi-rs/keyring";
import { CliError } from "./errors.js";

const KEYCHAIN_SECRET_VERSION = 1;
const KEYCHAIN_SECRET_KIND = "outline-cli.profile-auth";
const DEFAULT_KEYCHAIN_SERVICE = "com.khanglvm.outline-cli";
const MODE_REQUIRED = "required";
const MODE_OPTIONAL = "optional";
const MODE_DISABLED = "disabled";

function normalizeMode(mode) {
  const value = String(mode || "").trim().toLowerCase();
  if (value === MODE_DISABLED || value === MODE_OPTIONAL || value === MODE_REQUIRED) {
    return value;
  }
  return MODE_REQUIRED;
}

export function getKeychainMode() {
  return normalizeMode(process.env.OUTLINE_CLI_KEYCHAIN_MODE || process.env.OUTLINE_AGENT_KEYCHAIN_MODE);
}

export function getKeychainServiceName() {
  const value = String(process.env.OUTLINE_CLI_KEYCHAIN_SERVICE || "").trim();
  return value || DEFAULT_KEYCHAIN_SERVICE;
}

function digestHex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function accountScope(configPath) {
  return digestHex(path.resolve(configPath)).slice(0, 16);
}

function hasKeychainRef(auth) {
  return !!(auth && auth.credentialRef && auth.credentialRef.service && auth.credentialRef.account);
}

function isNotFoundError(err) {
  const message = String(err?.message || "");
  return /not found|no matching|could not be found|item/i.test(message);
}

function toCredentialRef(configPath, profileId, auth) {
  if (hasKeychainRef(auth)) {
    return {
      service: String(auth.credentialRef.service),
      account: String(auth.credentialRef.account),
      schemaVersion: Number(auth.credentialRef.schemaVersion || KEYCHAIN_SECRET_VERSION),
    };
  }
  return {
    service: getKeychainServiceName(),
    account: `profile-auth:${accountScope(configPath)}:${String(profileId)}`,
    schemaVersion: KEYCHAIN_SECRET_VERSION,
  };
}

function sanitizeAuth(auth, ref) {
  const clone = structuredClone(auth || {});
  delete clone.apiKey;
  delete clone.password;
  clone.credentialStore = "os-keychain";
  clone.credentialRef = ref;
  return clone;
}

function encodeSecret(payload) {
  return JSON.stringify({
    version: KEYCHAIN_SECRET_VERSION,
    kind: KEYCHAIN_SECRET_KIND,
    payload,
  });
}

function decodeSecret(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid keychain payload");
  }
  if (parsed.kind !== KEYCHAIN_SECRET_KIND) {
    throw new Error("Unsupported keychain payload kind");
  }
  return parsed.payload || {};
}

function secretPayloadFromAuth(auth) {
  if (!auth || typeof auth !== "object") {
    return null;
  }
  if (auth.type === "apiKey" && auth.apiKey) {
    return { apiKey: String(auth.apiKey) };
  }
  if ((auth.type === "basic" || auth.type === "password") && auth.password) {
    return { password: String(auth.password) };
  }
  return null;
}

function createEntry(ref) {
  return new Entry(ref.service, ref.account);
}

function buildKeychainError(message, context, err) {
  return new CliError(message, {
    ...context,
    code: "KEYCHAIN_ERROR",
    keychainMessage: err?.message || String(err),
  });
}

export function secureProfileForStorage({ configPath, profileId, profile }) {
  const mode = getKeychainMode();
  const clone = structuredClone(profile);
  const payload = secretPayloadFromAuth(clone.auth);
  if (!payload) {
    return {
      profile: clone,
      keychain: {
        used: false,
        mode,
        reason: "no-sensitive-fields",
      },
    };
  }

  if (mode === MODE_DISABLED) {
    clone.auth = {
      ...(clone.auth || {}),
      credentialStore: "config-inline",
    };
    return {
      profile: clone,
      keychain: {
        used: false,
        mode,
        reason: "disabled",
      },
    };
  }

  const ref = toCredentialRef(configPath, profileId, clone.auth);
  try {
    const entry = createEntry(ref);
    entry.setPassword(encodeSecret(payload));
    clone.auth = sanitizeAuth(clone.auth, ref);
    return {
      profile: clone,
      keychain: {
        used: true,
        mode,
        ref,
      },
    };
  } catch (err) {
    if (mode === MODE_OPTIONAL) {
      clone.auth = {
        ...(clone.auth || {}),
        credentialStore: "config-inline",
      };
      return {
        profile: clone,
        keychain: {
          used: false,
          mode,
          reason: "store-failed-optional",
          keychainMessage: err?.message || String(err),
        },
      };
    }
    throw buildKeychainError("Failed to write credentials to OS keychain", {
      profileId,
      mode,
      service: ref.service,
      account: ref.account,
    }, err);
  }
}

function mergeSecretIntoAuth(auth, payload) {
  const next = {
    ...(auth || {}),
  };
  if (payload.apiKey) {
    next.apiKey = payload.apiKey;
  }
  if (payload.password) {
    next.password = payload.password;
  }
  return next;
}

function authRequiresSecret(auth) {
  if (!auth || typeof auth !== "object") {
    return false;
  }
  if (auth.type === "apiKey") {
    return true;
  }
  return auth.type === "basic" || auth.type === "password";
}

export function hydrateProfileFromKeychain({ configPath, profile }) {
  const mode = getKeychainMode();
  const clone = structuredClone(profile);
  const auth = clone.auth || {};
  if (!authRequiresSecret(auth)) {
    return clone;
  }

  if (auth.apiKey || auth.password) {
    return clone;
  }

  if (mode === MODE_DISABLED) {
    throw new CliError("Profile requires OS keychain credentials but keychain mode is disabled", {
      code: "KEYCHAIN_DISABLED",
      profileId: clone.id,
      mode,
    });
  }

  const ref = toCredentialRef(configPath, clone.id, auth);
  try {
    const entry = createEntry(ref);
    const raw = entry.getPassword();
    const payload = decodeSecret(raw);
    clone.auth = mergeSecretIntoAuth(auth, payload);
    return clone;
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new CliError("Profile credentials are missing in OS keychain", {
        code: "KEYCHAIN_SECRET_NOT_FOUND",
        profileId: clone.id,
        service: ref.service,
        account: ref.account,
      });
    }
    throw buildKeychainError("Failed to read credentials from OS keychain", {
      profileId: clone.id,
      service: ref.service,
      account: ref.account,
      mode,
    }, err);
  }
}

export function removeProfileFromKeychain({ configPath, profileId, profile }) {
  const auth = profile?.auth || {};
  if (!authRequiresSecret(auth)) {
    return {
      removed: false,
      reason: "no-sensitive-fields",
    };
  }
  if (!hasKeychainRef(auth) && auth.credentialStore === "config-inline") {
    return {
      removed: false,
      reason: "inline-storage",
    };
  }

  const ref = toCredentialRef(configPath, profileId, auth);
  try {
    const entry = createEntry(ref);
    entry.deletePassword();
    return {
      removed: true,
      service: ref.service,
      account: ref.account,
    };
  } catch (err) {
    if (isNotFoundError(err)) {
      return {
        removed: false,
        reason: "not-found",
        service: ref.service,
        account: ref.account,
      };
    }
    throw buildKeychainError("Failed to delete credentials from OS keychain", {
      profileId,
      service: ref.service,
      account: ref.account,
    }, err);
  }
}
