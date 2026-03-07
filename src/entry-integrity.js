import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";
import { ENTRY_INTEGRITY_BINDING } from "./entry-integrity-binding.generated.js";
import { ENTRY_INTEGRITY_MANIFEST } from "./entry-integrity-manifest.generated.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function digestHex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalManifestInput(files) {
  return files
    .map((item) => ({
      path: item.path.replace(/\\/g, "/"),
      sha256: String(item.sha256),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((item) => `${item.path}:${item.sha256}`)
    .join("\n");
}

function signatureFor(files, keySalt) {
  const canonical = canonicalManifestInput(files);
  return digestHex(`${keySalt}\n${canonical}`);
}

async function hashFile(absPath) {
  const raw = await fs.readFile(absPath);
  return digestHex(raw);
}

function shouldSkipIntegrityCheck() {
  const value = String(process.env.OUTLINE_CLI_SKIP_INTEGRITY_CHECK || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export async function assertEntryIntegrity(rootDir = REPO_ROOT) {
  if (shouldSkipIntegrityCheck()) {
    return {
      ok: true,
      skipped: true,
      reason: "env-skip",
    };
  }

  const manifest = ENTRY_INTEGRITY_MANIFEST || {};
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length === 0) {
    throw new CliError("Entry integrity manifest is empty", {
      code: "ENTRY_INTEGRITY_MANIFEST_EMPTY",
      hint: "Run `npm run integrity:refresh` to regenerate local integrity metadata.",
    });
  }

  const computedSignature = signatureFor(files, ENTRY_INTEGRITY_BINDING.keySalt);
  if (computedSignature !== manifest.signature) {
    throw new CliError("Entry integrity signature mismatch", {
      code: "ENTRY_INTEGRITY_SIGNATURE_MISMATCH",
      expected: manifest.signature,
      actual: computedSignature,
      keyId: ENTRY_INTEGRITY_BINDING.keyId,
      hint: "Run `npm run integrity:refresh` after local source edits, or set `OUTLINE_CLI_SKIP_INTEGRITY_CHECK=1` for local smoke runs.",
    });
  }

  const mismatches = [];
  for (const item of files) {
    const relPath = item.path.replace(/\\/g, "/");
    const absPath = path.resolve(rootDir, relPath);
    try {
      const actual = await hashFile(absPath);
      if (actual !== item.sha256) {
        mismatches.push({
          path: relPath,
          expected: item.sha256,
          actual,
        });
      }
    } catch (err) {
      mismatches.push({
        path: relPath,
        expected: item.sha256,
        actual: null,
        error: err?.message || String(err),
      });
    }
  }

  if (mismatches.length > 0) {
    throw new CliError("Entry integrity check failed; one or more sub-modules do not match build-time state", {
      code: "ENTRY_SUBMODULE_INTEGRITY_FAILED",
      mismatchCount: mismatches.length,
      mismatches,
      hint: "Run `npm run integrity:refresh` after local source edits, or set `OUTLINE_CLI_SKIP_INTEGRITY_CHECK=1` for local smoke runs.",
    });
  }

  return {
    ok: true,
    checkedFiles: files.length,
    keyId: ENTRY_INTEGRITY_BINDING.keyId,
  };
}

export function signManifestFiles(files, keySalt) {
  return signatureFor(files, keySalt);
}

export function normalizeManifestFiles(files) {
  return canonicalManifestInput(files);
}
