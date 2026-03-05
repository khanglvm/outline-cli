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
