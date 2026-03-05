#!/usr/bin/env node
import("./outline-cli.js").catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
