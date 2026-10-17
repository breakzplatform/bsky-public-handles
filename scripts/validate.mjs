#!/usr/bin/env node
// Validates data/handles.json against data/handles.schema.json and checks
// rules a JSON Schema cannot express (unique domains).
//
// Usage: node scripts/validate.mjs [path/to/handles.json]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = process.argv[2] ?? join(root, "data/handles.json");
const schemaPath = join(root, "data/handles.schema.json");

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`Could not read ${path}: ${err.message}`);
    process.exit(1);
  }
};

const schema = readJson(schemaPath);
const data = readJson(dataPath);

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const errors = [];
if (!validate(data)) {
  for (const e of validate.errors) {
    errors.push(`${e.instancePath || "/"} ${e.message}`);
  }
}

const seen = new Map();
(data.handles ?? []).forEach((h, i) => {
  const key = String(h.domain).toLowerCase();
  if (seen.has(key)) {
    errors.push(`/handles/${i}/domain duplicates /handles/${seen.get(key)} (${key})`);
  } else {
    seen.set(key, i);
  }
});

if (errors.length) {
  console.error(`${dataPath} is invalid:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`${dataPath} is valid (${data.handles.length} domains).`);
