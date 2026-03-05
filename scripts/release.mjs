#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function usage() {
  process.stdout.write(
    [
      "Usage:",
      "  node ./scripts/release.mjs [--bump <patch|minor|major|prepatch|preminor|premajor|prerelease> | --version <x.y.z>]",
      "                             [--tag <dist-tag>] [--otp <code>] [--access <public|restricted>]",
      "                             [--no-publish] [--no-push] [--skip-check] [--skip-test] [--allow-dirty]",
      "",
      "Examples:",
      "  npm run release -- --bump patch",
      "  npm run release -- --version 0.2.0",
      "  npm run release -- --bump minor --tag next --no-publish --no-push",
      "",
    ].join("\n")
  );
}

function parseArgs(argv) {
  let sawBump = false;
  let sawVersion = false;
  function requireValue(flag, index) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  }
  const opts = {
    bump: "patch",
    version: null,
    tag: "latest",
    otp: null,
    access: "public",
    publish: true,
    push: true,
    skipCheck: false,
    skipTest: false,
    allowDirty: false,
    changelogPath: path.join(repoRoot, "CHANGELOG.md"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--bump") {
      opts.bump = requireValue("--bump", i);
      sawBump = true;
      i += 1;
      continue;
    }
    if (arg === "--version") {
      opts.version = requireValue("--version", i);
      sawVersion = true;
      i += 1;
      continue;
    }
    if (arg === "--tag") {
      opts.tag = requireValue("--tag", i);
      i += 1;
      continue;
    }
    if (arg === "--otp") {
      opts.otp = requireValue("--otp", i);
      i += 1;
      continue;
    }
    if (arg === "--access") {
      opts.access = requireValue("--access", i);
      i += 1;
      continue;
    }
    if (arg === "--changelog") {
      opts.changelogPath = path.resolve(repoRoot, requireValue("--changelog", i));
      i += 1;
      continue;
    }
    if (arg === "--no-publish") {
      opts.publish = false;
      continue;
    }
    if (arg === "--no-push") {
      opts.push = false;
      continue;
    }
    if (arg === "--skip-check") {
      opts.skipCheck = true;
      continue;
    }
    if (arg === "--skip-test") {
      opts.skipTest = true;
      continue;
    }
    if (arg === "--allow-dirty") {
      opts.allowDirty = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (sawVersion && sawBump) {
    throw new Error("Use either --version or --bump, not both.");
  }

  if (!opts.version && !opts.bump) {
    throw new Error("Missing version strategy. Provide --version <x.y.z> or --bump <type>.");
  }

  const validBumps = new Set(["patch", "minor", "major", "prepatch", "preminor", "premajor", "prerelease"]);
  if (!opts.version && !validBumps.has(opts.bump)) {
    throw new Error(`Invalid --bump value: ${opts.bump}`);
  }

  return opts;
}

function loadDotEnvFileIfPresent(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const i = trimmed.indexOf("=");
    if (i <= 0) {
      continue;
    }
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

function run(cmd, args, options = {}) {
  const capture = options.capture === true;
  const display = `$ ${cmd} ${args.join(" ")}`;
  process.stdout.write(`${display}\n`);
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...(options.env || {}) },
  });
  if (res.status !== 0) {
    const extra = capture ? `\n${(res.stdout || "").trim()}\n${(res.stderr || "").trim()}` : "";
    throw new Error(`Command failed (${res.status}): ${display}${extra}`);
  }
  return capture ? (res.stdout || "").trim() : "";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function currentDateIso() {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getLatestSemverTag() {
  const tags = run("git", ["tag", "--list", "v*.*.*", "--sort=-version:refname"], { capture: true })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return tags[0] || null;
}

function listCommitSubjectsSince(tag) {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const out = run("git", ["log", range, "--pretty=format:%s (%h)"], { capture: true });
  const rows = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return rows.length > 0 ? rows : ["Maintenance release."];
}

async function updateChangelog({ changelogPath, nextVersion, previousTag }) {
  let content = "";
  if (fs.existsSync(changelogPath)) {
    content = await fsp.readFile(changelogPath, "utf8");
  } else {
    content = "# Changelog\n\n";
  }

  if (!content.startsWith("# Changelog")) {
    content = `# Changelog\n\n${content.trimStart()}`;
  }

  const existingHeading = new RegExp(`^##\\s+${nextVersion}\\s+-\\s+`, "m");
  if (existingHeading.test(content)) {
    throw new Error(`CHANGELOG already has an entry for ${nextVersion}`);
  }

  const commits = listCommitSubjectsSince(previousTag);
  const scopeLine = previousTag ? `- Changes since \`${previousTag}\`.` : "- Initial tagged release notes.";
  const commitLines = commits.map((line) => `- ${line}`).join("\n");
  const entry = `## ${nextVersion} - ${currentDateIso()}\n\n${scopeLine}\n${commitLines}\n`;

  const header = "# Changelog";
  const body = content.slice(header.length).trimStart();
  const next = `${header}\n\n${entry}\n${body}`.replace(/\n{3,}/g, "\n\n");
  await fsp.writeFile(changelogPath, `${next.trimEnd()}\n`, "utf8");
}

function ensureBuildKey() {
  loadDotEnvFileIfPresent(path.join(repoRoot, ".env.local"));
  const key = process.env.OUTLINE_ENTRY_BUILD_KEY;
  if (!key || String(key).trim().length < 24) {
    throw new Error(
      "OUTLINE_ENTRY_BUILD_KEY is required for release integrity binding. Set it in environment or .env.local."
    );
  }
}

function ensureGitClean(allowDirty) {
  if (allowDirty) {
    return;
  }
  const dirty = run("git", ["status", "--porcelain"], { capture: true });
  if (dirty.trim()) {
    throw new Error("Git working tree is not clean. Commit/stash changes or pass --allow-dirty.");
  }
}

function ensureTagDoesNotExist(tagName) {
  const out = run("git", ["tag", "--list", tagName], { capture: true });
  if (out.trim() === tagName) {
    throw new Error(`Git tag already exists: ${tagName}`);
  }
}

function bumpVersion(opts) {
  const arg = opts.version || opts.bump;
  const out = run("npm", ["version", arg, "--no-git-tag-version"], { capture: true });
  const newVersion = out.trim().replace(/^v/, "");
  if (!newVersion) {
    throw new Error("Unable to resolve next version from npm version output.");
  }
  return newVersion;
}

function publishPackage(opts) {
  const args = ["publish", "--access", opts.access];
  if (opts.tag && opts.tag !== "latest") {
    args.push("--tag", opts.tag);
  }
  if (opts.otp) {
    args.push("--otp", opts.otp);
  }
  run("npm", args);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  ensureBuildKey();
  ensureGitClean(opts.allowDirty);

  const packageJsonPath = path.join(repoRoot, "package.json");
  const beforePkg = readJson(packageJsonPath);
  const previousTag = getLatestSemverTag();

  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { capture: true });
  if (!branch || branch === "HEAD") {
    throw new Error("Detached HEAD is not supported for release. Check out a branch.");
  }

  const nextVersion = bumpVersion(opts);
  const releaseTag = `v${nextVersion}`;
  ensureTagDoesNotExist(releaseTag);
  await updateChangelog({
    changelogPath: opts.changelogPath,
    nextVersion,
    previousTag,
  });

  run("npm", ["run", "integrity:refresh"]);
  if (!opts.skipCheck) {
    run("npm", ["run", "check"]);
  }
  if (!opts.skipTest) {
    run("npm", ["test"]);
  }
  run("npm", ["pack", "--dry-run"]);

  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", `chore(release): v${nextVersion}`]);
  run("git", ["tag", "-a", releaseTag, "-m", releaseTag]);

  if (opts.publish) {
    publishPackage(opts);
  }

  if (opts.push) {
    run("git", ["push", "origin", branch]);
    run("git", ["push", "origin", releaseTag]);
  }

  const afterPkg = readJson(packageJsonPath);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        package: beforePkg.name,
        previousVersion: beforePkg.version,
        nextVersion: afterPkg.version,
        releaseTag,
        published: opts.publish,
        pushed: opts.push,
        branch,
      },
      null,
      2
    )}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
