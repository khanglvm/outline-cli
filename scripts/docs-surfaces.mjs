#!/usr/bin/env node
// docs-surfaces: checks that a library's docs read the same in the three places people see them:
// the GitHub repo, docs.khangle.dev and the npm package page. Vendored into each library repo as
// scripts/docs-surfaces.mjs; the master copy lives in khanglvm/docs (tools/docs-surfaces.mjs).
// No dependencies, Node 18 or later. Run it from the repo root after pushing a change:
//
//   node scripts/docs-surfaces.mjs
//
// It exits 0 when all three match and 1 with the fix for each surface that is behind:
// - GitHub: README.md and docs/ on the default branch match this checkout.
// - docs.khangle.dev: the library page was synced from a commit that includes the latest docs change.
// - npm: the README of the latest published version equals README.md on the default branch.
//   npm only takes a README from a published version, so a README change needs a release.

import { execFileSync } from "node:child_process";

const LIBRARIES =
  "https://raw.githubusercontent.com/khanglvm/docs/main/libraries.json";

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
const ok = (cmd, args) => {
  try {
    run(cmd, args);
    return true;
  } catch {
    return false;
  }
};
const normalize = (text) => text.replace(/\r\n/g, "\n").trim();

const origin = run("git", ["remote", "get-url", "origin"]);
const repo = origin.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");

const res = await fetch(LIBRARIES, { signal: AbortSignal.timeout(20000) });
if (!res.ok) throw new Error(`could not read ${LIBRARIES}: HTTP ${res.status}`);
const site = await res.json();
const lib = site.libraries.find((l) => l.repo === repo);
if (!lib) {
  console.error(
    `${repo} is not listed in khanglvm/docs libraries.json, so docs.khangle.dev does not publish it.`,
  );
  process.exit(1);
}
const branch = lib.branch;
const problems = [];

// GitHub
run("git", ["fetch", "--quiet", "origin", branch]);
const remote = `origin/${branch}`;
if (!ok("git", ["diff", "--quiet", remote, "--", "README.md", "docs"])) {
  problems.push(
    `GitHub: README.md or docs/ here differs from ${remote}. Commit and push the docs change.`,
  );
}
const lastDocs = run("git", [
  "log",
  "-1",
  "--format=%H",
  remote,
  "--",
  "README.md",
  "docs",
]);
console.log(
  `github   ${repo}@${branch}: last docs change ${lastDocs.slice(0, 7)}`,
);

// docs.khangle.dev
const pageUrl = `${site.site.url}/${lib.slug}`;
const page = await fetch(`${pageUrl}?fresh=${Date.now()}`, {
  signal: AbortSignal.timeout(20000),
});
const synced = page.ok
  ? (await page.text()).match(/commit\/([0-9a-f]{7,40})/)?.[1]
  : undefined;
if (!synced) {
  problems.push(
    `docs.khangle.dev: ${pageUrl} shows no synced commit (HTTP ${page.status}). Run: gh workflow run sync.yml --repo khanglvm/docs --ref main`,
  );
} else {
  const fresh = ok("git", ["merge-base", "--is-ancestor", lastDocs, synced]);
  console.log(
    `site     ${pageUrl}: synced from ${synced.slice(0, 7)}${fresh ? "" : " (behind)"}`,
  );
  if (!fresh) {
    problems.push(
      `docs.khangle.dev: synced from ${synced.slice(0, 7)}, before the docs change ${lastDocs.slice(0, 7)}. Run: gh workflow run sync.yml --repo khanglvm/docs --ref main, wait for it, then run this check again.`,
    );
  }
}

// npm
if (lib.package) {
  let published = "";
  let readme = "";
  try {
    published = run("npm", [
      "view",
      lib.package,
      "version",
      "--registry=https://registry.npmjs.org/",
    ]);
    readme = run(
      "npm",
      ["view", lib.package, "readme", "--registry=https://registry.npmjs.org/"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  } catch {
    problems.push(
      `npm: ${lib.package} is not on npm yet. Publish the first version.`,
    );
  }
  if (published) {
    const current = normalize(
      run("git", ["show", `${remote}:README.md`], {
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
    const same = normalize(readme) === current;
    console.log(
      `npm      ${lib.package}@${published}: README ${same ? "matches" : "is older than"} ${remote}`,
    );
    if (!same) {
      problems.push(
        `npm: the README of ${lib.package}@${published} is not the one on ${remote}. npm shows a README only from a published version, so release a new version (see AGENTS.md, Docs), then run this check again.`,
      );
    }
  }
}

if (problems.length) {
  console.error(`\n${problems.length} surface(s) behind:`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log("\nAll three surfaces match.");
