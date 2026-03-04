import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultTmpDir } from "./config-store.js";
import { CliError } from "./errors.js";

const STORE_VERSION = 1;

function gateStorePath() {
  return path.join(defaultTmpDir(), "action-gates", "delete-read-receipts.json");
}

function blankStore() {
  return {
    version: STORE_VERSION,
    receipts: {},
  };
}

function normalizeTtlSeconds(ttlSeconds) {
  const parsed = Number(ttlSeconds);
  if (!Number.isFinite(parsed)) {
    return 900;
  }
  return Math.max(60, Math.min(86_400, Math.trunc(parsed)));
}

function pruneExpired(store) {
  const receipts = store.receipts && typeof store.receipts === "object" ? store.receipts : {};
  const now = Date.now();
  let changed = false;

  for (const [token, receipt] of Object.entries(receipts)) {
    const expiresAt = Date.parse(receipt?.expiresAt || "");
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      delete receipts[token];
      changed = true;
    }
  }

  store.receipts = receipts;
  return changed;
}

async function loadStore() {
  const file = gateStorePath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return blankStore();
    }
    if (parsed.version !== STORE_VERSION) {
      return blankStore();
    }
    if (!parsed.receipts || typeof parsed.receipts !== "object") {
      parsed.receipts = {};
    }
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return blankStore();
    }
    throw err;
  }
}

async function saveStore(store) {
  const file = gateStorePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export function assertPerformAction(args, { tool, action }) {
  if (args?.performAction === true) {
    return;
  }

  throw new CliError(`${tool} is action-gated. Set args.performAction=true to continue.`, {
    code: "ACTION_GATED",
    tool,
    action,
    required: {
      performAction: true,
    },
    provided: {
      performAction: args?.performAction ?? false,
    },
  });
}

export function isLikelyMutatingMethod(method) {
  const normalized = String(method || "").toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(create|update|delete|restore|archive|unarchive|move|rename|patch|apply|publish|unpublish|batch)/.test(
    normalized
  );
}

export function isLikelyDeleteMethod(method) {
  const normalized = String(method || "").toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(^|\.)(delete|permanentdelete)$/.test(normalized) || normalized.includes(".delete");
}

export async function issueDocumentDeleteReadReceipt({
  profileId,
  documentId,
  revision,
  title,
  ttlSeconds,
}) {
  const id = String(documentId || "");
  if (!id) {
    throw new CliError("Cannot issue delete-read receipt without document id", {
      code: "DELETE_READ_RECEIPT_INVALID",
    });
  }
  if (!profileId) {
    throw new CliError("Cannot issue delete-read receipt without profile id", {
      code: "DELETE_READ_RECEIPT_INVALID",
    });
  }

  const ttl = normalizeTtlSeconds(ttlSeconds);
  const now = Date.now();
  const token = randomUUID();
  const receipt = {
    kind: "document.delete.read",
    profileId: String(profileId),
    documentId: id,
    revision: Number.isFinite(Number(revision)) ? Number(revision) : null,
    title: title ? String(title) : null,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
  };

  const store = await loadStore();
  pruneExpired(store);
  store.receipts[token] = receipt;
  await saveStore(store);

  return {
    token,
    documentId: receipt.documentId,
    revision: receipt.revision,
    title: receipt.title,
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
    ttlSeconds: ttl,
  };
}

export async function getDocumentDeleteReadReceipt({
  token,
  profileId,
  documentId,
}) {
  if (!token || typeof token !== "string") {
    throw new CliError("Delete is gated by read confirmation. Provide args.readToken from documents.info armDelete=true", {
      code: "DELETE_READ_TOKEN_REQUIRED",
      required: ["readToken"],
    });
  }

  const store = await loadStore();
  const pruned = pruneExpired(store);
  const receipt = store.receipts[token];
  if (pruned) {
    await saveStore(store);
  }

  if (!receipt) {
    throw new CliError("Delete read token is invalid or expired", {
      code: "DELETE_READ_TOKEN_INVALID",
      token,
    });
  }
  if (receipt.kind !== "document.delete.read") {
    throw new CliError("Delete read token has unsupported type", {
      code: "DELETE_READ_TOKEN_INVALID",
      token,
    });
  }
  if (String(receipt.profileId) !== String(profileId)) {
    throw new CliError("Delete read token was created by a different profile", {
      code: "DELETE_READ_TOKEN_PROFILE_MISMATCH",
      token,
      profileId,
    });
  }
  if (String(receipt.documentId) !== String(documentId)) {
    throw new CliError("Delete read token was not issued for this document", {
      code: "DELETE_READ_TOKEN_DOCUMENT_MISMATCH",
      token,
      documentId,
      expectedDocumentId: receipt.documentId,
    });
  }

  return {
    token,
    ...receipt,
  };
}

export async function consumeDocumentDeleteReadReceipt(token) {
  if (!token || typeof token !== "string") {
    return false;
  }

  const store = await loadStore();
  if (!store.receipts[token]) {
    return false;
  }
  delete store.receipts[token];
  await saveStore(store);
  return true;
}

export function getActionGateStorePath() {
  return gateStorePath();
}
