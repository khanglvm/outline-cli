#!/usr/bin/env node
import { assertEntryIntegrity } from "../src/entry-integrity.js";

async function main() {
  await assertEntryIntegrity();
  const { run } = await import("../src/cli.js");
  await run(process.argv);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
