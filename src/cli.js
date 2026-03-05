import { Command } from "commander";
import path from "node:path";
import { getAgentSkillHelp, listHelpSections } from "./agent-skills.js";
import {
  buildProfile,
  defaultConfigPath,
  getProfile,
  listProfiles,
  loadConfig,
  redactProfile,
  saveConfig,
} from "./config-store.js";
import { CliError, ApiError } from "./errors.js";
import { OutlineClient } from "./outline-client.js";
import { ResultStore } from "./result-store.js";
import {
  hydrateProfileFromKeychain,
  removeProfileFromKeychain,
  secureProfileForStorage,
} from "./secure-keyring.js";
import { getToolContract, invokeTool, listTools } from "./tools.js";
import { mapLimit, parseJsonArg, parseCsv, toInteger } from "./utils.js";

function configureSharedOutputOptions(command) {
  return command
    .option("--config <path>", "Config file path", defaultConfigPath())
    .option("--profile <id>", "Profile ID (required when multiple profiles exist and no default is set)")
    .option("--output <format>", "Output format: json|ndjson", "json")
    .option("--result-mode <mode>", "Result mode: auto|inline|file", "auto")
    .option("--inline-max-bytes <n>", "Max inline JSON payload size", "12000")
    .option("--tmp-dir <path>", "Directory for large result files")
    .option("--pretty", "Pretty-print JSON output", false);
}

function buildStoreFromOptions(opts) {
  return new ResultStore({
    mode: opts.resultMode,
    inlineMaxBytes: toInteger(opts.inlineMaxBytes, 12000),
    tmpDir: opts.tmpDir,
    pretty: !!opts.pretty,
  });
}

async function getRuntime(opts, overrideProfileId) {
  const configPath = path.resolve(opts.config || defaultConfigPath());
  const config = await loadConfig(configPath);
  const selectedProfile = getProfile(config, overrideProfileId || opts.profile);
  const profile = hydrateProfileFromKeychain({
    configPath,
    profile: selectedProfile,
  });
  const client = new OutlineClient(profile);
  return {
    configPath,
    config,
    profile,
    client,
  };
}

function parseHeaders(input) {
  if (!input) {
    return {};
  }
  const pairs = parseCsv(input);
  const headers = {};
  for (const pair of pairs) {
    const i = pair.indexOf(":");
    if (i <= 0) {
      throw new CliError(`Invalid header pair: ${pair}. Expected key:value`);
    }
    const key = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    headers[key] = value;
  }
  return headers;
}

function formatError(err) {
  if (err instanceof ApiError) {
    return {
      ok: false,
      error: {
        type: "ApiError",
        message: err.message,
        ...err.details,
      },
    };
  }

  if (err instanceof CliError) {
    return {
      ok: false,
      error: {
        type: "CliError",
        message: err.message,
        ...err.details,
      },
    };
  }

  return {
    ok: false,
    error: {
      type: err?.name || "Error",
      message: err?.message || String(err),
      stack: err?.stack,
    },
  };
}

function writeNdjsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitNdjson(payload) {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      writeNdjsonLine({ type: "item", item });
    }
    return;
  }

  if (payload && typeof payload === "object" && Array.isArray(payload.items)) {
    const { items, ...meta } = payload;
    writeNdjsonLine({ type: "meta", ...meta });
    for (const item of items) {
      writeNdjsonLine({ type: "item", item });
    }
    return;
  }

  const listKeys = ["tools", "files", "contract", "profiles"];
  for (const key of listKeys) {
    if (payload && typeof payload === "object" && Array.isArray(payload[key])) {
      const { [key]: rows, ...meta } = payload;
      writeNdjsonLine({ type: "meta", list: key, ...meta });
      for (const row of rows) {
        writeNdjsonLine({ type: key.slice(0, -1), [key.slice(0, -1)]: row });
      }
      return;
    }
  }

  if (payload?.result && Array.isArray(payload.result.data)) {
    const meta = {
      type: "meta",
      tool: payload.tool,
      profile: payload.profile,
      count: payload.result.data.length,
      pagination: payload.result.pagination,
    };
    writeNdjsonLine(meta);
    for (const row of payload.result.data) {
      writeNdjsonLine({ type: "data", row });
    }
    return;
  }

  writeNdjsonLine(payload);
}

async function emitOutput(store, payload, opts, emitOptions = {}) {
  if ((opts.output || "json") === "ndjson") {
    const mode = emitOptions.mode || opts.resultMode || store.mode || "auto";
    const serialized = JSON.stringify(payload);
    const bytes = Buffer.byteLength(serialized);
    const shouldStore = mode === "file" || (mode === "auto" && bytes > store.inlineMaxBytes);

    if (shouldStore) {
      const file = await store.write(payload, {
        label: emitOptions.label,
        ext: emitOptions.ext,
        pretty: false,
      });
      writeNdjsonLine({
        type: "meta",
        ok: true,
        stored: true,
        bytes,
        label: emitOptions.label || null,
      });
      writeNdjsonLine({
        type: "file",
        file,
        bytes,
        hint: `Use shell tools to inspect file, e.g. jq '.' ${JSON.stringify(file)} | head`,
      });
      return;
    }

    emitNdjson(payload);
    return;
  }

  await store.emit(payload, emitOptions);
}

export async function run(argv = process.argv) {
  const program = new Command();
  program
    .name("outline-cli")
    .description("Agent-optimized CLI for Outline API")
    .version("0.1.0")
    .showHelpAfterError(true);

  const profile = program.command("profile").description("Manage Outline profiles");

  profile
    .command("add <id>")
    .description("Add or update a profile")
    .option("--config <path>", "Config file path", defaultConfigPath())
    .requiredOption("--base-url <url>", "Outline instance URL, e.g. https://app.getoutline.com")
    .option("--name <name>", "Friendly profile name")
    .option("--auth-type <type>", "apiKey|basic|password")
    .option("--api-key <key>", "Outline API key (ol_api_...)")
    .option("--username <username>", "Username/email for basic or password mode")
    .option("--password <password>", "Password for basic or password mode")
    .option("--token-endpoint <url>", "Optional token exchange endpoint for password mode")
    .option("--token-field <field>", "Token field in token response", "access_token")
    .option("--token-body <json>", "Extra token request JSON body")
    .option("--token-body-file <path>", "Extra token request JSON body file")
    .option("--timeout-ms <n>", "Request timeout in milliseconds", "30000")
    .option("--headers <csv>", "Extra headers as csv key:value pairs")
    .option("--set-default", "Set as default profile", false)
    .action(async (id, opts) => {
      const configPath = path.resolve(opts.config || defaultConfigPath());
      const config = await loadConfig(configPath);
      const tokenBody = await parseJsonArg({
        json: opts.tokenBody,
        file: opts.tokenBodyFile,
        name: "token-body",
      });
      const nextProfile = buildProfile({
        id,
        name: opts.name,
        baseUrl: opts.baseUrl,
        authType: opts.authType,
        apiKey: opts.apiKey,
        username: opts.username,
        password: opts.password,
        tokenEndpoint: opts.tokenEndpoint,
        tokenField: opts.tokenField,
        tokenRequestBody: tokenBody,
        timeoutMs: toInteger(opts.timeoutMs, 30000),
        headers: parseHeaders(opts.headers),
      });

      const secured = secureProfileForStorage({
        configPath,
        profileId: id,
        profile: nextProfile,
      });

      config.profiles[id] = secured.profile;
      if (opts.setDefault) {
        config.defaultProfile = id;
      }
      await saveConfig(configPath, config);

      const store = new ResultStore({ pretty: true });
      await store.emit({
        ok: true,
        configPath,
        defaultProfile: config.defaultProfile,
        profile: redactProfile({ id, ...secured.profile }),
        security: secured.keychain,
      }, { mode: "inline", pretty: true, label: "profile-add" });
    });

  profile
    .command("list")
    .description("List configured profiles")
    .option("--config <path>", "Config file path", defaultConfigPath())
    .action(async (opts) => {
      const configPath = path.resolve(opts.config || defaultConfigPath());
      const config = await loadConfig(configPath);
      const profiles = listProfiles(config).map((item) => ({
        ...redactProfile(item),
        isDefault: config.defaultProfile === item.id,
      }));
      const store = new ResultStore({ pretty: true });
      await store.emit(
        {
          ok: true,
          configPath,
          defaultProfile: config.defaultProfile,
          profiles,
        },
        { mode: "inline", pretty: true, label: "profile-list" }
      );
    });

  profile
    .command("show [id]")
    .description("Show one profile (redacted)")
    .option("--config <path>", "Config file path", defaultConfigPath())
    .action(async (id, opts) => {
      const configPath = path.resolve(opts.config || defaultConfigPath());
      const config = await loadConfig(configPath);
      const profileData = getProfile(config, id);
      const store = new ResultStore({ pretty: true });
      await store.emit(
        {
          ok: true,
          configPath,
          profile: redactProfile(profileData),
        },
        { mode: "inline", pretty: true, label: "profile-show" }
      );
    });

  profile
    .command("use <id>")
    .description("Set default profile")
    .option("--config <path>", "Config file path", defaultConfigPath())
    .action(async (id, opts) => {
      const configPath = path.resolve(opts.config || defaultConfigPath());
      const config = await loadConfig(configPath);
      if (!config.profiles?.[id]) {
        throw new CliError(`Profile not found: ${id}`);
      }
      config.defaultProfile = id;
      await saveConfig(configPath, config);
      const store = new ResultStore({ pretty: true });
      await store.emit(
        {
          ok: true,
          defaultProfile: id,
          configPath,
        },
        { mode: "inline", pretty: true, label: "profile-use" }
      );
    });

  profile
    .command("remove <id>")
    .description("Remove a profile")
    .option("--config <path>", "Config file path", defaultConfigPath())
    .option("--force", "Allow removing default profile without replacement", false)
    .action(async (id, opts) => {
      const configPath = path.resolve(opts.config || defaultConfigPath());
      const config = await loadConfig(configPath);
      if (!config.profiles?.[id]) {
        throw new CliError(`Profile not found: ${id}`);
      }
      if (config.defaultProfile === id && !opts.force) {
        throw new CliError(
          "Cannot remove default profile without --force. Set another default with `profile use <id>` first."
        );
      }

      const profileRecord = {
        id,
        ...config.profiles[id],
      };
      const security = removeProfileFromKeychain({
        configPath,
        profileId: id,
        profile: profileRecord,
      });

      delete config.profiles[id];
      if (config.defaultProfile === id) {
        config.defaultProfile = null;
      }
      await saveConfig(configPath, config);

      const store = new ResultStore({ pretty: true });
      await store.emit(
        {
          ok: true,
          removed: id,
          defaultProfile: config.defaultProfile,
          security,
        },
        { mode: "inline", pretty: true, label: "profile-remove" }
      );
    });

  configureSharedOutputOptions(
    profile
      .command("test [id]")
      .description("Test profile authentication via auth.info")
  ).action(async (id, opts) => {
    const runtime = await getRuntime(opts, id);
    const store = buildStoreFromOptions(opts);
    const response = await runtime.client.call("auth.info", {}, { maxAttempts: 1 });
    const result = {
      ok: true,
      profile: runtime.profile.id,
      user: response.body?.data?.user,
      team: response.body?.data?.team,
    };
    await emitOutput(store, result, opts, { label: "profile-test", mode: opts.resultMode });
  });

  const tools = configureSharedOutputOptions(
    program.command("tools").description("Inspect tool contracts and metadata")
  );

  tools
    .command("list")
    .description("List available agent tools")
    .action(async (opts, cmd) => {
      const merged = { ...cmd.parent.opts(), ...opts };
      const store = buildStoreFromOptions(merged);
      await emitOutput(store, { ok: true, tools: listTools() }, merged, {
        label: "tools-list",
        mode: merged.resultMode,
      });
    });

  tools
    .command("contract [name]")
    .description("Show tool contract (signature, usage, best practices)")
    .action(async (name, opts, cmd) => {
      const merged = { ...cmd.parent.opts(), ...opts };
      const store = buildStoreFromOptions(merged);
      const contract = getToolContract(name || "all");
      await emitOutput(store, { ok: true, contract }, merged, {
        label: "tool-contract",
        mode: merged.resultMode,
      });
    });

  tools
    .command("help [section]")
    .description("Show structured help sections for AI-oriented CLI usage")
    .option("--view <mode>", "View mode: summary|full", "summary")
    .option("--scenario <id>", "Filter ai-skills by scenario id, e.g. UC-12")
    .option("--skill <id>", "Filter ai-skills by skill id")
    .option("--query <text>", "Search ai-skills by tool/scenario/topic keyword")
    .action(async (section, opts, cmd) => {
      const merged = { ...cmd.parent.opts(), ...opts };
      const store = buildStoreFromOptions(merged);
      const sectionName = String(section || "index").trim().toLowerCase();

      if (sectionName === "index" || sectionName === "all") {
        await emitOutput(
          store,
          {
            ok: true,
            section: "index",
            sections: listHelpSections(),
          },
          merged,
          {
            label: "tools-help-index",
            mode: merged.resultMode,
          }
        );
        return;
      }

      if (sectionName === "ai" || sectionName === "skill" || sectionName === "skills" || sectionName === "ai-skills") {
        await emitOutput(
          store,
          {
            ok: true,
            ...getAgentSkillHelp({
              view: merged.view,
              scenario: merged.scenario,
              skill: merged.skill,
              query: merged.query,
            }),
          },
          merged,
          {
            label: "tools-help-ai-skills",
            mode: merged.resultMode,
          }
        );
        return;
      }

      throw new CliError(
        `Unknown tools help section: ${section}. Supported: ${listHelpSections().map((row) => row.id).join(", ")}`
      );
    });

  const invoke = configureSharedOutputOptions(
    program
      .command("invoke <tool>")
      .description("Invoke a high-level Outline tool")
      .option("--args <json>", "Tool args JSON")
      .option("--args-file <path>", "Tool args JSON file")
  );

  invoke.action(async (tool, opts) => {
    const runtime = await getRuntime(opts);
    const store = buildStoreFromOptions(opts);
    const args = (await parseJsonArg({ json: opts.args, file: opts.argsFile, name: "args" })) || {};
    const result = await invokeTool(runtime, tool, args);
    await emitOutput(store, result, opts, {
      label: `tool-${tool.replace(/\./g, "-")}`,
      mode: opts.resultMode,
    });
  });

  const batch = configureSharedOutputOptions(
    program
      .command("batch")
      .description("Invoke multiple tools in one call")
      .option("--ops <json>", "Array of operations: [{ tool, args, profile? }]")
      .option("--ops-file <path>", "JSON file containing operations array")
      .option("--parallel <n>", "Max parallel operations", "4")
      .option("--item-envelope <mode>", "Batch item payload mode: compact|full", "compact")
      .option("--strict-exit", "Exit non-zero if any operation fails", false)
  );

  batch.action(async (opts) => {
    const configPath = path.resolve(opts.config || defaultConfigPath());
    const config = await loadConfig(configPath);
    const operations = await parseJsonArg({ json: opts.ops, file: opts.opsFile, name: "ops" });
    if (!Array.isArray(operations)) {
      throw new CliError("batch expects an array of operations in --ops or --ops-file");
    }

    const store = buildStoreFromOptions(opts);
    const clientCache = new Map();

    async function runtimeForProfile(profileId) {
      const selected = getProfile(config, profileId || opts.profile);
      if (!clientCache.has(selected.id)) {
        const hydrated = hydrateProfileFromKeychain({
          configPath,
          profile: selected,
        });
        clientCache.set(selected.id, {
          profile: hydrated,
          client: new OutlineClient(hydrated),
        });
      }
      return clientCache.get(selected.id);
    }

    const parallel = toInteger(opts.parallel, 4);
    const items = await mapLimit(operations, parallel, async (operation, index) => {
      try {
        if (!operation || typeof operation !== "object") {
          throw new CliError(`Operation at index ${index} must be an object`);
        }
        if (!operation.tool) {
          throw new CliError(`Operation at index ${index} is missing tool`);
        }
        const runtime = await runtimeForProfile(operation.profile);
        const payload = await invokeTool(runtime, operation.tool, operation.args || {});
        const mode = (opts.itemEnvelope || "compact").toLowerCase();
        const compactResult =
          payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "result")
            ? payload.result
            : payload;
        const compactMeta = {};
        for (const key of ["query", "queryCount", "mode", "collectionId"]) {
          if (payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, key)) {
            compactMeta[key] = payload[key];
          }
        }
        return {
          index,
          tool: operation.tool,
          profile: runtime.profile.id,
          ok: true,
          result: mode === "full" ? payload : compactResult,
          ...(mode === "full" || Object.keys(compactMeta).length === 0 ? {} : { meta: compactMeta }),
        };
      } catch (err) {
        return {
          index,
          tool: operation?.tool,
          profile: operation?.profile || opts.profile || config.defaultProfile,
          ok: false,
          error: formatError(err).error,
        };
      }
    });

    const failed = items.filter((item) => !item.ok).length;
    const output = {
      ok: failed === 0,
      total: items.length,
      failed,
      succeeded: items.length - failed,
      items,
    };
    await emitOutput(store, output, opts, { label: "batch", mode: opts.resultMode });

    if (failed > 0 && opts.strictExit) {
      process.exitCode = 2;
    }
  });

  const tmp = configureSharedOutputOptions(program.command("tmp").description("Manage temporary result files"));

  tmp
    .command("list")
    .description("List stored result files")
    .action(async (opts, cmd) => {
      const merged = { ...cmd.parent.opts(), ...opts };
      const store = buildStoreFromOptions(merged);
      const files = await store.list();
      await emitOutput(store, { ok: true, files }, merged, { label: "tmp-list", mode: "inline" });
    });

  tmp
    .command("cat <file>")
    .description("Print a temporary file")
    .action(async (file, opts, cmd) => {
      const merged = { ...cmd.parent.opts(), ...opts };
      const store = buildStoreFromOptions(merged);
      const content = await store.read(file);
      process.stdout.write(content.content);
    });

  tmp
    .command("rm <file>")
    .description("Remove a temporary file")
    .action(async (file, opts, cmd) => {
      const merged = { ...cmd.parent.opts(), ...opts };
      const store = buildStoreFromOptions(merged);
      const result = await store.remove(file);
      await emitOutput(store, { ok: true, ...result }, merged, { label: "tmp-rm", mode: "inline" });
    });

  tmp
    .command("gc")
    .description("Delete old temporary files")
    .option("--max-age-hours <n>", "Delete files older than this age", "24")
    .action(async (opts, cmd) => {
      const merged = { ...cmd.parent.opts(), ...opts };
      const store = buildStoreFromOptions(merged);
      const result = await store.gc(toInteger(merged.maxAgeHours, 24));
      await emitOutput(store, { ok: true, ...result }, merged, { label: "tmp-gc", mode: "inline" });
    });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    const output = formatError(err);
    process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exitCode = process.exitCode || 1;
  }
}
