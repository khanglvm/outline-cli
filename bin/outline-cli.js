#!/usr/bin/env node
import { assertEntryIntegrity } from "../src/entry-integrity.js";

async function main() {
  await assertEntryIntegrity();
  const { run } = await import("../src/cli.js");
  await run(process.argv);
}

main().catch((err) => {
  if (err?.name === "CliError") {
    const payload = {
      ok: false,
      error: {
        type: err.name,
        message: err.message,
        ...(err.details || {}),
      },
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(1);
    return;
  }

  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
