import fs from "node:fs";
import { spawnSync } from "node:child_process";

const registry = "https://registry.npmjs.org/";
const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const packageSpec = `${pkg.name}@${pkg.version}`;
const publish = spawnSync("npm", ["publish", ...process.argv.slice(2)], {
  encoding: "utf8",
  stdio: ["inherit", "pipe", "pipe"],
});

process.stdout.write(publish.stdout || "");
process.stderr.write(publish.stderr || "");

if (publish.status === 0) {
  process.exit(0);
}

const publishOutput = `${publish.stdout || ""}\n${publish.stderr || ""}`;
if (!/E409[\s\S]*previously staged version/i.test(publishOutput)) {
  process.exit(publish.status || 1);
}

for (let attempt = 1; attempt <= 18; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const lookup = spawnSync(
    "npm",
    ["view", packageSpec, "version", "--json", `--registry=${registry}`],
    { encoding: "utf8" }
  );

  if (lookup.status === 0) {
    const publishedVersion = JSON.parse(lookup.stdout);
    if (publishedVersion !== pkg.version) {
      throw new Error(`Registry returned ${publishedVersion} for ${packageSpec}`);
    }
    process.stdout.write(`${packageSpec} became available after staged publication.\n`);
    process.exit(0);
  }

  let errorCode = "";
  try {
    errorCode = JSON.parse(lookup.stdout)?.error?.code || "";
  } catch {
    errorCode = "";
  }
  if (errorCode !== "E404") {
    process.stderr.write(lookup.stderr || lookup.stdout || "Registry lookup failed.\n");
    process.exit(lookup.status || 1);
  }
}

throw new Error(`${packageSpec} remained staged for more than three minutes`);
