#!/usr/bin/env node
// docs-readme: keeps a repo's README in step with its docs/ pages, and checks docs/ against the
// docs.khangle.dev contract. Vendored into each library repo as scripts/docs-readme.mjs; the master
// copy lives in khanglvm/docs (tools/docs-readme.mjs). No dependencies, Node 18 or later.
//
//   node scripts/docs-readme.mjs          rewrite the README blocks from docs/
//   node scripts/docs-readme.mjs --check  fail when docs/ breaks the contract or the README is stale
//
// A README block copies one page's body (without its title) between two markers:
//   <!-- docs:begin install.md -->
//   ...generated, do not edit by hand...
//   <!-- docs:end -->

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DOCS = join(ROOT, 'docs');
const README = join(ROOT, 'README.md');
const BLOCK = /<!-- docs:begin ([^\s]+) -->\n[\s\S]*?<!-- docs:end -->/g;
const SEPARATOR = /^---.*---$/;
const LINK_ENTRY = /^(external:)?\[.*\]\(.*\)$/;

const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

// Lists the pages docs/meta.json publishes, following nested folders that have their own meta.json.
function publishedPages(dir = '', problems = []) {
  const metaPath = join(DOCS, dir, 'meta.json');
  if (!existsSync(metaPath)) return problems.push(`docs/${dir}meta.json is missing`), [];
  let meta;
  try {
    meta = JSON.parse(read(metaPath));
  } catch (err) {
    return problems.push(`docs/${dir}meta.json is not valid JSON: ${err.message}`), [];
  }
  const pages = [];
  for (const entry of meta.pages ?? []) {
    if (typeof entry !== 'string' || SEPARATOR.test(entry) || LINK_ENTRY.test(entry)) continue;
    if (entry.includes('...')) problems.push(`docs/${dir}meta.json: list pages by name instead of "${entry}"`);
    const name = entry.replace(/^!/, '');
    const page = [`${dir}${name}.md`, `${dir}${name}.mdx`].find((p) => existsSync(join(DOCS, p)));
    if (page) pages.push(page);
    else if (existsSync(join(DOCS, dir, name, 'meta.json'))) pages.push(...publishedPages(`${dir}${name}/`, problems));
    else problems.push(`docs/${dir}meta.json lists "${name}", but docs/${dir}${name}.md does not exist`);
  }
  return pages;
}

// Page body for the README: frontmatter and H1 removed, headings one level deeper so they sit
// under the README section, and relative links rebased from docs/ to the repo root.
function readmeBody(page) {
  const text = read(join(DOCS, page)).replace(/^---\n[\s\S]*?\n---\n?/, '');
  const body = text.replace(/^\s*#\s+.+\n/, '').trim();
  const dir = page.split('/').slice(0, -1);
  return body
    .split(/(```[\s\S]*?```)/)
    .map((piece, i) =>
      i % 2
        ? piece
        : piece
            .replace(/^(#{1,5})(\s)/gm, '#$1$2')
            .replace(/(\]\()([^)\s]+)/g, (_, open, target) => open + rebase(target, dir)),
    )
    .join('');
}

function rebase(target, dir) {
  if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target;
  const parts = ['docs', ...dir];
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

function main() {
  const check = process.argv.includes('--check');
  const problems = [];
  const pages = new Set(publishedPages('', problems));
  for (const page of pages) {
    const text = read(join(DOCS, page));
    if (!/^(---\n[\s\S]*?title:|\s*#\s)/.test(text)) problems.push(`docs/${page} needs an H1 title or a title in frontmatter`);
  }
  if (!pages.has('index.md') && !pages.has('index.mdx')) problems.push('docs/meta.json must list "index" (the overview page)');

  const readme = existsSync(README) ? read(README) : '';
  const fresh = readme.replace(BLOCK, (_, page) => {
    if (!pages.has(page)) return problems.push(`README.md includes ${page}, which docs/meta.json does not publish`), _;
    return `<!-- docs:begin ${page} -->\n${readmeBody(page)}\n<!-- docs:end -->`;
  });
  if (check && fresh !== readme) problems.push('README.md is out of date with docs/. Run: node scripts/docs-readme.mjs');
  if (!check && fresh !== readme) writeFileSync(README, fresh), console.log('README.md updated from docs/');

  if (problems.length) {
    console.error(problems.map((p) => `docs-readme: ${p}`).join('\n'));
    process.exit(1);
  }
  if (check) console.log(`docs-readme: ok (${pages.size} pages)`);
}

main();
