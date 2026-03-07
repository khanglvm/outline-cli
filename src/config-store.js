import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";

export const CONFIG_VERSION = 1;

const OFFICIAL_OUTLINE_HOST_ALIASES = new Set([
  "getoutline.com",
  "www.getoutline.com",
  "docs.getoutline.com",
]);

const BASE_URL_UI_PATH_MARKERS = new Set([
  "account",
  "auth",
  "collection",
  "collections",
  "d",
  "dashboard",
  "doc",
  "home",
  "s",
  "search",
  "settings",
  "share",
  "templates",
]);

const PROFILE_KEYWORD_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "api",
  "app",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "via",
  "with",
  "www",
  "http",
  "https",
  "outline",
  "workspace",
  "knowledge",
  "base",
  "implement",
  "collection",
  "doc",
  "site",
  "data",
]);

const PROFILE_HOST_TOKEN_BLACKLIST = new Set([
  "com",
  "net",
  "org",
  "io",
  "site",
  "app",
  "www",
  "localhost",
  "local",
  "internal",
  "corp",
  "company",
  "outline",
]);

export function defaultConfigPath() {
  if (process.env.OUTLINE_CLI_CONFIG) {
    return path.resolve(process.env.OUTLINE_CLI_CONFIG);
  }
  if (process.env.OUTLINE_AGENT_CONFIG) {
    return path.resolve(process.env.OUTLINE_AGENT_CONFIG);
  }
  const modern = path.join(os.homedir(), ".config", "outline-cli", "config.json");
  const legacy = path.join(os.homedir(), ".config", "outline-agent", "config.json");
  if (!fsSync.existsSync(modern) && fsSync.existsSync(legacy)) {
    return legacy;
  }
  return modern;
}

export function defaultTmpDir() {
  if (process.env.OUTLINE_CLI_TMP_DIR) {
    return path.resolve(process.env.OUTLINE_CLI_TMP_DIR);
  }
  if (process.env.OUTLINE_AGENT_TMP_DIR) {
    return path.resolve(process.env.OUTLINE_AGENT_TMP_DIR);
  }
  return path.join(os.homedir(), ".cache", "outline-cli", "tmp");
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
  return normalizeBaseUrlWithHints(baseUrl).baseUrl;
}

function looksLikeHostnameCandidate(value) {
  return /^[A-Za-z0-9.-]+(?::\d+)?(\/.*)?$/.test(String(value || ""));
}

function normalizePathForBaseUrl(pathname, corrections) {
  const path = String(pathname || "");
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "/";
  }

  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const apiIndex = lowerSegments.indexOf("api");
  if (apiIndex >= 0) {
    const kept = segments.slice(0, apiIndex);
    corrections.push(apiIndex === 0 ? "trimmed_api_prefix" : "trimmed_path_after_api");
    return kept.length > 0 ? `/${kept.join("/")}` : "/";
  }

  const markerIndex = lowerSegments.findIndex((segment) => BASE_URL_UI_PATH_MARKERS.has(segment));
  if (markerIndex >= 0) {
    const kept = segments.slice(0, markerIndex);
    corrections.push("trimmed_ui_path");
    return kept.length > 0 ? `/${kept.join("/")}` : "/";
  }

  return `/${segments.join("/")}`;
}

function normalizeKeywords(keywords) {
  if (keywords == null) {
    return [];
  }
  const items = Array.isArray(keywords)
    ? keywords
    : String(keywords)
      .split(",")
      .map((item) => item.trim());
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function profileKeywordTokens(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !/\d/.test(token))
    .filter((token) => !PROFILE_KEYWORD_STOPWORDS.has(token));
}

function profileKeywordBigrams(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const left = tokens[i];
    const right = tokens[i + 1];
    if (!left || !right) {
      continue;
    }
    if (left.length < 3 || right.length < 3) {
      continue;
    }
    out.push(`${left} ${right}`);
  }
  return out;
}

function profileHostKeywords(baseUrl) {
  try {
    const host = new URL(String(baseUrl || "")).hostname.toLowerCase();
    return host
      .split(".")
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => !/\d/.test(token))
      .filter((token) => !PROFILE_HOST_TOKEN_BLACKLIST.has(token))
      .filter((token) => token.length >= 2);
  } catch {
    return [];
  }
}

function rankProfileKeywordCandidates(sources) {
  const weighted = new Map();
  let index = 0;
  for (const source of sources) {
    const weight = Number(source?.weight) || 0;
    if (weight <= 0) {
      continue;
    }
    for (const item of source.items || []) {
      const normalized = String(item || "").trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      const previous = weighted.get(normalized);
      if (previous) {
        previous.score += weight;
      } else {
        weighted.set(normalized, { score: weight, order: index });
        index += 1;
      }
    }
  }
  return [...weighted.entries()]
    .sort((a, b) => {
      if (b[1].score !== a[1].score) {
        return b[1].score - a[1].score;
      }
      if (a[1].order !== b[1].order) {
        return a[1].order - b[1].order;
      }
      return a[0].localeCompare(b[0]);
    })
    .map(([keyword]) => keyword);
}

function toProfileDescriptionCandidate(value) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed : undefined;
}

function tokenizeProfileQuery(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function safeHostFromUrl(value) {
  try {
    return new URL(String(value || "")).host.toLowerCase();
  } catch {
    return "";
  }
}

function scoreProfileForQuery(profile, id, rawQuery, queryTokens) {
  const name = String(profile?.name || "").toLowerCase();
  const description = String(profile?.description || "").toLowerCase();
  const keywords = normalizeKeywords(profile?.keywords).map((item) => item.toLowerCase());
  const baseUrl = String(profile?.baseUrl || "");
  const baseHost = safeHostFromUrl(baseUrl);
  const queryText = String(rawQuery || "").trim().toLowerCase();
  const matchedOn = [];
  let score = 0;

  if (queryText) {
    if (String(id).toLowerCase() === queryText) {
      score += 1.4;
      matchedOn.push("id_exact");
    } else if (String(id).toLowerCase().includes(queryText)) {
      score += 1.1;
      matchedOn.push("id_partial");
    }

    if (name === queryText) {
      score += 1.2;
      matchedOn.push("name_exact");
    } else if (name.includes(queryText)) {
      score += 0.8;
      matchedOn.push("name_partial");
    }

    if (description.includes(queryText)) {
      score += 0.55;
      matchedOn.push("description_partial");
    }

    if (keywords.includes(queryText)) {
      score += 1.1;
      matchedOn.push("keyword_exact");
    }

    if (baseHost && (queryText.includes(baseHost) || baseHost.includes(queryText))) {
      score += 0.9;
      matchedOn.push("host");
    }
  }

  if (queryTokens.length > 0) {
    const idTokens = new Set(tokenizeProfileQuery(id));
    const nameTokens = new Set(tokenizeProfileQuery(name));
    const descTokens = new Set(tokenizeProfileQuery(description));
    const keywordTokens = new Set(keywords.flatMap((item) => tokenizeProfileQuery(item)));
    const hostTokens = new Set(tokenizeProfileQuery(baseHost));

    const overlaps = {
      id: 0,
      name: 0,
      description: 0,
      keywords: 0,
      host: 0,
    };

    for (const token of queryTokens) {
      if (idTokens.has(token)) {
        overlaps.id += 1;
      }
      if (nameTokens.has(token)) {
        overlaps.name += 1;
      }
      if (descTokens.has(token)) {
        overlaps.description += 1;
      }
      if (keywordTokens.has(token)) {
        overlaps.keywords += 1;
      }
      if (hostTokens.has(token)) {
        overlaps.host += 1;
      }
    }

    if (overlaps.id > 0) {
      score += overlaps.id * 0.5;
      matchedOn.push("id_tokens");
    }
    if (overlaps.name > 0) {
      score += overlaps.name * 0.4;
      matchedOn.push("name_tokens");
    }
    if (overlaps.description > 0) {
      score += Math.min(0.45, overlaps.description * 0.12);
      matchedOn.push("description_tokens");
    }
    if (overlaps.keywords > 0) {
      score += overlaps.keywords * 0.55;
      matchedOn.push("keyword_tokens");
    }
    if (overlaps.host > 0) {
      score += overlaps.host * 0.35;
      matchedOn.push("host_tokens");
    }
  }

  return {
    score: Number(score.toFixed(4)),
    matchedOn: [...new Set(matchedOn)],
  };
}

export function normalizeBaseUrlWithHints(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") {
    throw new Error("baseUrl is required");
  }

  const rawInput = baseUrl.trim();
  if (!rawInput) {
    throw new Error("baseUrl is required");
  }

  const corrections = [];
  let parseInput = rawInput;
  if (!/^[a-z]+:\/\//i.test(parseInput)) {
    if (!looksLikeHostnameCandidate(parseInput)) {
      throw new Error("baseUrl must be a valid URL or hostname");
    }
    parseInput = `https://${parseInput}`;
    corrections.push("added_https_scheme");
  }

  const parsed = new URL(parseInput);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("baseUrl must start with http:// or https://");
  }

  if (OFFICIAL_OUTLINE_HOST_ALIASES.has(parsed.hostname.toLowerCase())) {
    parsed.protocol = "https:";
    parsed.hostname = "app.getoutline.com";
    parsed.port = "";
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    corrections.push("mapped_official_outline_host");
  }

  if (parsed.search) {
    parsed.search = "";
    corrections.push("removed_query");
  }
  if (parsed.hash) {
    parsed.hash = "";
    corrections.push("removed_hash");
  }

  const normalizedPath = normalizePathForBaseUrl(parsed.pathname, corrections);
  parsed.pathname = normalizedPath;

  const serialized = parsed.toString().replace(/\/+$/, "");
  const normalized = serialized.endsWith("/api") ? serialized.slice(0, -4) : serialized;
  if (serialized !== normalized) {
    corrections.push("trimmed_api_suffix");
  }

  return {
    input: rawInput,
    baseUrl: normalized,
    corrected: normalized !== rawInput || corrections.length > 0,
    corrections: [...new Set(corrections)],
  };
}

export function suggestProfiles(config, query, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 5;
  const queryText = String(query || "").trim();
  const queryTokens = tokenizeProfileQuery(queryText);
  const rows = listProfiles(config).map((profile) => {
    const { score, matchedOn } = scoreProfileForQuery(profile, profile.id, queryText, queryTokens);
    return {
      ...redactProfile(profile),
      isDefault: config?.defaultProfile === profile.id,
      score,
      matchedOn,
    };
  });

  rows.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.isDefault !== b.isDefault) {
      return a.isDefault ? -1 : 1;
    }
    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  return {
    query: queryText,
    profileCount: rows.length,
    matches: rows.slice(0, limit),
  };
}

function isHighConfidenceProfileMatch(top, second, options = {}) {
  if (!top) {
    return false;
  }

  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 1.7;
  const minGap = Number.isFinite(Number(options.minGap)) ? Number(options.minGap) : 0.55;
  const exactSignals = new Set(["id_exact", "name_exact", "keyword_exact", "host"]);
  const hasExactSignal = Array.isArray(top.matchedOn) && top.matchedOn.some((item) => exactSignals.has(item));
  const gap = top.score - Number(second?.score || 0);

  if (top.score >= 3.2) {
    return true;
  }
  if (top.score >= minScore && gap >= minGap) {
    return true;
  }
  if (hasExactSignal && top.score >= 1.2 && gap >= 0.35) {
    return true;
  }

  return false;
}

function formatProfileSelectionError(config, message, options = {}) {
  const availableProfiles = Object.keys(config?.profiles || {});
  const query = String(options.query || "").trim();
  const suggestionLimit = Number.isFinite(Number(options.suggestionLimit))
    ? Math.max(1, Number(options.suggestionLimit))
    : 3;
  const suggestions = query ? suggestProfiles(config, query, { limit: suggestionLimit }).matches : [];

  return new CliError(message, {
    code: "PROFILE_SELECTION_REQUIRED",
    availableProfiles,
    ...(query ? { query, suggestions } : {}),
  });
}

export function suggestProfileMetadata(input = {}, options = {}) {
  const id = String(input.id || "").trim();
  const name = String(input.name || id || "").trim();
  const baseUrl = String(input.baseUrl || "").trim();
  const currentDescription = toProfileDescriptionCandidate(input.description);
  const currentKeywords = normalizeKeywords(input.keywords);
  const hints = Array.isArray(input.hints)
    ? input.hints.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const maxKeywordsRaw = Number(options.maxKeywords);
  const maxKeywords = Number.isFinite(maxKeywordsRaw)
    ? Math.max(1, Math.trunc(maxKeywordsRaw))
    : 20;
  const refreshDescription = !!options.refreshDescription;
  const preserveKeywords = !!options.preserveKeywords;

  const idTokens = profileKeywordTokens(id);
  const nameTokens = profileKeywordTokens(name);
  const hostTokens = profileHostKeywords(baseUrl);
  const currentKeywordTokens = currentKeywords.flatMap((item) => profileKeywordTokens(item));
  const hintTokens = hints.flatMap((hint) => profileKeywordTokens(hint));
  const hintBigrams = hints.flatMap((hint) => profileKeywordBigrams(profileKeywordTokens(hint)));

  const rankedCandidates = rankProfileKeywordCandidates([
    { weight: 4.0, items: currentKeywords },
    { weight: 3.0, items: hintBigrams },
    { weight: 2.5, items: hintTokens },
    { weight: 2.2, items: currentKeywordTokens },
    { weight: 1.8, items: nameTokens },
    { weight: 1.5, items: idTokens },
    { weight: 1.1, items: hostTokens },
  ]);

  const nextKeywords = [];
  const keywordSeed = preserveKeywords && currentKeywords.length > 0
    ? [...currentKeywords]
    : [...currentKeywords, ...rankedCandidates];
  for (const item of keywordSeed) {
    const normalized = String(item || "").trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (!nextKeywords.includes(normalized)) {
      nextKeywords.push(normalized);
    }
    if (nextKeywords.length >= maxKeywords) {
      break;
    }
  }

  let nextDescription = currentDescription;
  if (!nextDescription || refreshDescription) {
    const host = safeHostFromUrl(baseUrl);
    const topicHints = nextKeywords
      .filter((item) => !hostTokens.includes(item))
      .slice(0, 4);
    if (topicHints.length > 0) {
      nextDescription = `${name || id || "Outline"} knowledge base for ${topicHints.join(", ")}`;
    } else if (host) {
      nextDescription = `${name || id || "Outline"} workspace (${host})`;
    } else {
      nextDescription = `${name || id || "Outline"} workspace`;
    }
  }

  const previousKeywordSet = new Set(currentKeywords.map((item) => item.toLowerCase()));
  const addedKeywords = nextKeywords.filter((item) => !previousKeywordSet.has(item));

  return {
    description: nextDescription,
    keywords: nextKeywords,
    generated: {
      descriptionGenerated: !currentDescription || (refreshDescription && nextDescription !== currentDescription),
      keywordsAdded: addedKeywords.length,
      hintsUsed: hints.length,
      maxKeywords,
    },
  };
}

export function listProfiles(config) {
  return Object.entries(config.profiles || {}).map(([id, profile]) => ({
    id,
    ...profile,
  }));
}

export function getProfile(config, explicitId, options = {}) {
  const profiles = config?.profiles || {};

  if (explicitId) {
    const profile = profiles[explicitId];
    if (!profile) {
      throw new CliError(`Profile not found: ${explicitId}`, {
        code: "PROFILE_NOT_FOUND",
        profileId: explicitId,
        availableProfiles: Object.keys(profiles),
      });
    }
    return {
      id: explicitId,
      ...profile,
    };
  }

  if (config.defaultProfile) {
    const profile = profiles[config.defaultProfile];
    if (!profile) {
      throw new CliError(`Profile not found: ${config.defaultProfile}`, {
        code: "PROFILE_NOT_FOUND",
        profileId: config.defaultProfile,
        availableProfiles: Object.keys(profiles),
      });
    }
    return {
      id: config.defaultProfile,
      ...profile,
    };
  }

  const profileIds = Object.keys(profiles);
  if (profileIds.length === 1) {
    const id = profileIds[0];
    return {
      id,
      ...profiles[id],
    };
  }

  if (profileIds.length > 1) {
    const query = String(options.query || "").trim();
    const allowAutoSelect = options.allowAutoSelect !== false;
    const suggestionLimit = Number.isFinite(Number(options.suggestionLimit))
      ? Math.max(1, Number(options.suggestionLimit))
      : 3;

    if (allowAutoSelect && query) {
      const suggestions = suggestProfiles(config, query, { limit: suggestionLimit }).matches;
      const top = suggestions[0];
      const second = suggestions[1];

      if (isHighConfidenceProfileMatch(top, second, options)) {
        return {
          id: top.id,
          ...profiles[top.id],
          selection: {
            autoSelected: true,
            query,
            score: top.score,
            matchedOn: top.matchedOn,
          },
        };
      }
    }

    throw formatProfileSelectionError(
      config,
      "Profile selection required: multiple profiles are saved and no default profile is set. Use --profile <id> or `outline-cli profile use <id>`.",
      {
        query,
        suggestionLimit,
      }
    );
  }

  throw new CliError("No profiles configured. Use `outline-cli profile add <id> ...` first.", {
    code: "PROFILE_NOT_CONFIGURED",
  });
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
  description,
  keywords,
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
  const normalizedBaseUrl = normalizeBaseUrlWithHints(baseUrl).baseUrl;
  const normalizedKeywords = normalizeKeywords(keywords);
  const profile = {
    name: name || id,
    description: typeof description === "string" && description.trim() ? description.trim() : undefined,
    keywords: normalizedKeywords.length > 0 ? normalizedKeywords : undefined,
    baseUrl: normalizedBaseUrl,
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
