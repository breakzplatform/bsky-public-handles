#!/usr/bin/env node
// Regenerates the handle table in README.md from data/handles.json.
// Only the text between the marker comments is replaced, so the rest of the
// README stays hand-written.
//
// Usage:
//   node scripts/build-readme.mjs          rewrite README.md
//   node scripts/build-readme.mjs --check  exit 1 if README.md is out of date

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = join(root, "README.md");
const DATA_PATH = join(root, "data/handles.json");
const START = "<!-- handles:start -->";
const END = "<!-- handles:end -->";

const check = process.argv.includes("--check");

const escapeCell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const width = (s) => [...s].length;
const pad = (s, n) => s + " ".repeat(Math.max(0, n - width(s)));

function renderTable(handles) {
  const header = ["URL", "Description", "Status", "Responsible", "Country", "Last checked"];
  const rows = handles.map((h) => [
    `[${h.domain}](${h.get_handle_url})`,
    escapeCell(h.description),
    h.status,
    h.maintainer ? `[${escapeCell(h.maintainer.name)}](${h.maintainer.url})` : "?",
    h.country,
    h.last_checked ?? "never",
  ]);
  const widths = header.map((_, i) => Math.max(width(header[i]), ...rows.map((r) => width(r[i]))));
  const line = (cells) => `| ${cells.map((c, i) => pad(c, widths[i])).join(" | ")} |`;
  return [line(header), `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`, ...rows.map(line)].join("\n");
}

const data = JSON.parse(readFileSync(DATA_PATH, "utf8"));
const readme = readFileSync(README_PATH, "utf8");
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end === -1 || end < start) {
  console.error(`README.md must contain ${START} and ${END} markers.`);
  process.exit(1);
}

const block = [
  START,
  "<!-- Generated from data/handles.json by scripts/build-readme.mjs. Do not edit by hand. -->",
  "",
  renderTable(data.handles),
  "",
  END,
].join("\n");
const updated = readme.slice(0, start) + block + readme.slice(end + END.length);

if (check) {
  if (updated !== readme) {
    console.error("README.md is out of date. Run: node scripts/build-readme.mjs");
    process.exit(1);
  }
  console.log("README.md table matches data/handles.json.");
} else {
  writeFileSync(README_PATH, updated);
  console.log(`README.md table updated (${data.handles.length} domains).`);
}
