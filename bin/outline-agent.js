#!/usr/bin/env node
import("../src/cli.js").then(({ run }) => run(process.argv)).catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
