import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CONFIG_VERSION = 1;

export function defaultConfigPath() {
  if (process.env.OUTLINE_AGENT_CONFIG) {
    return path.resolve(process.env.OUTLINE_AGENT_CONFIG);
  }
  return path.join(os.homedir(), ".config", "outline-agent", "config.json");
}

export function defaultTmpDir() {
  if (process.env.OUTLINE_AGENT_TMP_DIR) {
    return path.resolve(process.env.OUTLINE_AGENT_TMP_DIR);
  }
  return path.join(os.homedir(), ".cache", "outline-agent", "tmp");
}

function blankConfig() {
  return {
    version: CONFIG_VERSION,
    defaultProfile: null,
    profiles: {},
  };
}

export async function loadConfig(configPath) {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return blankConfig();
    }
    if (!parsed.profiles || typeof parsed.profiles !== "object") {
      parsed.profiles = {};
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, "defaultProfile")) {
      parsed.defaultProfile = null;
    }
    if (!parsed.version) {
      parsed.version = CONFIG_VERSION;
    }
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return blankConfig();
    }
    throw new Error(`Failed to read config ${configPath}: ${err.message}`);
  }
}

export async function saveConfig(configPath, config) {
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });
  const payload = JSON.stringify(config, null, 2) + "\n";
  await fs.writeFile(configPath, payload, { mode: 0o600 });
}

export function normalizeBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") {
    throw new Error("baseUrl is required");
  }
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("baseUrl must start with http:// or https://");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  const result = parsed.toString().replace(/\/+$/, "");
  return result.endsWith("/api") ? result.slice(0, -4) : result;
}

export function listProfiles(config) {
  return Object.entries(config.profiles || {}).map(([id, profile]) => ({
    id,
    ...profile,
  }));
}

export function getProfile(config, explicitId) {
  const profileId = explicitId || config.defaultProfile;
  if (!profileId) {
    throw new Error("No profile selected. Use `outline-agent profile add` then `profile use`.");
  }
  const profile = config.profiles?.[profileId];
  if (!profile) {
    throw new Error(`Profile not found: ${profileId}`);
  }
  return {
    id: profileId,
    ...profile,
  };
}

export function redactProfile(profile) {
  if (!profile) {
    return profile;
  }
  const clone = structuredClone(profile);
  if (clone.auth) {
    if (clone.auth.apiKey) {
      clone.auth.apiKey = redactSecret(clone.auth.apiKey);
    }
    if (clone.auth.password) {
      clone.auth.password = "***";
    }
    if (clone.auth.clientSecret) {
      clone.auth.clientSecret = "***";
    }
    if (clone.auth.tokenRequestBody && typeof clone.auth.tokenRequestBody === "object") {
      for (const key of Object.keys(clone.auth.tokenRequestBody)) {
        if (/secret|password|token|key/i.test(key)) {
          clone.auth.tokenRequestBody[key] = "***";
        }
      }
    }
  }
  return clone;
}

export function redactSecret(secret) {
  if (!secret) {
    return secret;
  }
  if (secret.length <= 8) {
    return "***";
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export function buildProfile({
  id,
  name,
  baseUrl,
  authType,
  apiKey,
  username,
  password,
  tokenEndpoint,
  tokenField,
  tokenRequestBody,
  timeoutMs,
  headers,
}) {
  const profile = {
    name: name || id,
    baseUrl: normalizeBaseUrl(baseUrl),
    timeoutMs: timeoutMs || 30000,
    headers: headers || {},
    auth: {},
  };

  const mode = authType || (apiKey ? "apiKey" : username && password ? "password" : null);
  if (!mode) {
    throw new Error("Provide either --api-key or --username + --password");
  }

  if (mode === "apiKey") {
    if (!apiKey) {
      throw new Error("--api-key is required for auth type apiKey");
    }
    profile.auth = {
      type: "apiKey",
      apiKey,
    };
    return profile;
  }

  if (mode === "basic") {
    if (!username || !password) {
      throw new Error("--username and --password are required for auth type basic");
    }
    profile.auth = {
      type: "basic",
      username,
      password,
    };
    return profile;
  }

  if (mode === "password") {
    if (!username || !password) {
      throw new Error("--username and --password are required for auth type password");
    }
    profile.auth = {
      type: "password",
      username,
      password,
      tokenEndpoint: tokenEndpoint || null,
      tokenField: tokenField || "access_token",
      tokenRequestBody: tokenRequestBody || null,
    };
    return profile;
  }

  throw new Error(`Unsupported auth type: ${mode}`);
}
