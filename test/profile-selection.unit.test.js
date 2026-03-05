import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = process.cwd();
const CLI_BIN = path.join(REPO_ROOT, "bin", "outline-cli.js");

function tryParseJson(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      OUTLINE_CLI_KEYCHAIN_MODE: "disabled",
      OUTLINE_CLI_SKIP_INTEGRITY_CHECK: "true",
    },
  });

  const stdout = (res.stdout || "").trim();
  const stderr = (res.stderr || "").trim();
  const expectCode = opts.expectCode ?? 0;

  if (res.status !== expectCode) {
    throw new Error(
      [
        `Command failed: node ${CLI_BIN} ${args.join(" ")}`,
        `Exit code: ${res.status} (expected ${expectCode})`,
        stdout ? `STDOUT:\n${stdout}` : "",
        stderr ? `STDERR:\n${stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }

  return {
    status: res.status,
    stdout,
    stderr,
    stdoutJson: tryParseJson(stdout),
    stderrJson: tryParseJson(stderr),
  };
}

test("profile selection supports explicit, default, and single-profile fallback rules", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outline-cli-profile-selection-"));
  const configPath = path.join(tmpDir, "config.json");

  try {
    const addAlpha = runCli([
      "profile",
      "add",
      "alpha",
      "--config",
      configPath,
      "--base-url",
      "https://alpha.example.com",
      "--api-key",
      "ol_api_alpha123",
    ]);
    assert.equal(addAlpha.stdoutJson?.defaultProfile, null, "first add should not auto-set default");

    const singleFallback = runCli([
      "invoke",
      "no.such.tool",
      "--config",
      configPath,
      "--args",
      "{}",
    ], { expectCode: 1 });
    assert.match(singleFallback.stderrJson?.error?.message || "", /Unknown tool: no\.such\.tool/);

    const addBeta = runCli([
      "profile",
      "add",
      "beta",
      "--config",
      configPath,
      "--base-url",
      "https://beta.example.com",
      "--api-key",
      "ol_api_beta123",
    ]);
    assert.equal(addBeta.stdoutJson?.defaultProfile, null, "adding a second profile should keep default unset");

    const ambiguous = runCli([
      "invoke",
      "no.such.tool",
      "--config",
      configPath,
      "--args",
      "{}",
    ], { expectCode: 1 });
    assert.match(
      ambiguous.stderrJson?.error?.message || "",
      /Profile selection required: multiple profiles are saved and no default profile is set/
    );

    const explicitProfile = runCli([
      "invoke",
      "no.such.tool",
      "--config",
      configPath,
      "--profile",
      "beta",
      "--args",
      "{}",
    ], { expectCode: 1 });
    assert.match(explicitProfile.stderrJson?.error?.message || "", /Unknown tool: no\.such\.tool/);

    const useBeta = runCli(["profile", "use", "beta", "--config", configPath]);
    assert.equal(useBeta.stdoutJson?.defaultProfile, "beta");

    const withDefault = runCli([
      "invoke",
      "no.such.tool",
      "--config",
      configPath,
      "--args",
      "{}",
    ], { expectCode: 1 });
    assert.match(withDefault.stderrJson?.error?.message || "", /Unknown tool: no\.such\.tool/);

    const removeDefault = runCli([
      "profile",
      "remove",
      "beta",
      "--config",
      configPath,
      "--force",
    ]);
    assert.equal(removeDefault.stdoutJson?.defaultProfile, null, "forced default removal should clear default");

    const fallbackAfterRemove = runCli([
      "invoke",
      "no.such.tool",
      "--config",
      configPath,
      "--args",
      "{}",
    ], { expectCode: 1 });
    assert.match(fallbackAfterRemove.stderrJson?.error?.message || "", /Unknown tool: no\.such\.tool/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("profile metadata annotate/suggest supports AI-oriented source routing", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outline-cli-profile-metadata-"));
  const configPath = path.join(tmpDir, "config.json");

  try {
    const addEngineering = runCli([
      "profile",
      "add",
      "engineering",
      "--config",
      configPath,
      "--base-url",
      "wiki.example.com/outline/doc/incident-runbook-abc123",
      "--api-key",
      "ol_api_alpha123",
      "--description",
      "Incident and runbook knowledge base",
      "--keywords",
      "incident,runbook,sre",
    ]);
    assert.equal(addEngineering.stdoutJson?.profile?.description, "Incident and runbook knowledge base");
    assert.deepEqual(addEngineering.stdoutJson?.profile?.keywords, ["incident", "runbook", "sre"]);
    assert.equal(addEngineering.stdoutJson?.profile?.baseUrl, "https://wiki.example.com/outline");
    assert.equal(addEngineering.stdoutJson?.endpoint?.autoCorrected, true);

    runCli([
      "profile",
      "add",
      "marketing",
      "--config",
      configPath,
      "--base-url",
      "https://handbook.acme.example",
      "--api-key",
      "ol_api_beta123",
      "--description",
      "Campaign and event tracking handbook",
      "--keywords",
      "tracking,campaign,analytics",
      "--set-default",
    ]);

    const annotate = runCli([
      "profile",
      "annotate",
      "marketing",
      "--config",
      configPath,
      "--append-keywords",
      "landing page,utm",
    ]);
    assert.deepEqual(annotate.stdoutJson?.profile?.keywords, [
      "tracking",
      "campaign",
      "analytics",
      "landing page",
      "utm",
    ]);

    const suggested = runCli([
      "profile",
      "suggest",
      "landing page tracking events",
      "--config",
      configPath,
      "--limit",
      "2",
    ]);
    assert.equal(suggested.stdoutJson?.bestMatch?.id, "marketing");
    assert.ok(Array.isArray(suggested.stdoutJson?.matches));
    assert.equal(suggested.stdoutJson?.matches?.length, 2);
    assert.ok(Number(suggested.stdoutJson?.matches?.[0]?.score || 0) >= Number(suggested.stdoutJson?.matches?.[1]?.score || 0));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("profile add auto metadata + enrich can learn from query/title/url hints", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outline-cli-profile-enrich-"));
  const configPath = path.join(tmpDir, "config.json");

  try {
    const addProfile = runCli([
      "profile",
      "add",
      "marketing-handbook",
      "--config",
      configPath,
      "--base-url",
      "https://handbook.acme.example/doc/event-tracking-data-A7hLXuHZJl",
      "--api-key",
      "ol_api_marketing123",
    ]);
    assert.equal(addProfile.stdoutJson?.profile?.baseUrl, "https://handbook.acme.example");
    assert.ok(typeof addProfile.stdoutJson?.profile?.description === "string");
    assert.ok((addProfile.stdoutJson?.profile?.keywords || []).includes("marketing"));
    assert.equal(addProfile.stdoutJson?.metadata?.autoGenerated, true);

    const enrich = runCli([
      "profile",
      "enrich",
      "marketing-handbook",
      "--config",
      configPath,
      "--query",
      "implement tracking collection for landing page",
      "--titles",
      "event tracking data,campaign detail page",
      "--urls",
      "https://handbook.acme.example/doc/campaign-detail-page-GWK1uA8w35",
    ]);
    assert.equal(enrich.stdoutJson?.changed, true);
    assert.ok((enrich.stdoutJson?.delta?.addedKeywords || []).includes("landing page"));
    assert.ok((enrich.stdoutJson?.delta?.addedKeywords || []).includes("event tracking"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
