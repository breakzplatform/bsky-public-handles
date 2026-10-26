#!/usr/bin/env node
// Checks every domain in data/handles.json and updates status, last_checked
// and check details in place.
//
// For each domain it:
//   1. resolves DNS (NS, A/AAAA, a random subdomain for wildcards) over
//      DNS-over-HTTPS, so results do not depend on the local resolver;
//   2. fetches the domain's website and looks for parked / for-sale signs;
//   3. looks for a real handle under the domain (the maintainer's handle, the
//      Bluesky search API, the domain's own pages) and resolves it the atproto
//      way: _atproto TXT record and https://<handle>/.well-known/atproto-did,
//      then confirms the DID document claims the handle.
//
// A domain is marked Deprecated only after failing two consecutive runs and
// goes back to Active as soon as it passes again. A check that could not be
// completed (resolver down, network error on our side) is recorded as
// "error" and leaves the status untouched.
//
// Usage:
//   node scripts/check-handles.mjs [--dry-run] [--only a.com,b.net]
//                                  [--concurrency 6] [--summary file.md]
//
// No dependencies: Node 20+ (global fetch). Behind an HTTP proxy, run with
// NODE_USE_ENV_PROXY=1 (Node 22.21+) so fetch honours HTTPS_PROXY.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_PATH = join(root, "data/handles.json");

const USER_AGENT =
  "bsky-public-handles-checker/1.0 (+https://github.com/breakzplatform/bsky-public-handles)";
const TIMEOUT_MS = 12_000;
const MAX_BODY = 512 * 1024;
const MAX_SAMPLES = 5;
const FAILURES_TO_DEPRECATE = 2;

// Nameservers and hosts that belong to parking services and domain
// marketplaces. Matching any of them means the domain is parked or for sale.
const PARKING_NAMESERVERS = [
  "afternic.com",
  "atom.com",
  "bodis.com",
  "dan.com",
  "domainmarket.com",
  "hugedomains.com",
  "parity.domains",
  "parkingcrew.net",
  "parklogic.com",
  "above.com",
  "sedoparking.com",
  "uniregistrymarket.link",
  "undeveloped.com",
  "cashparking.com",
  "dsredirection.com",
];
const PARKING_HOSTS = [
  "afternic.com",
  "atom.com",
  "bodis.com",
  "brandbucket.com",
  "buydomains.com",
  "dan.com",
  "domainmarket.com",
  "efty.com",
  "hugedomains.com",
  "parkingcrew.net",
  "sedo.com",
  "spaceship.com",
  "squadhelp.com",
  "undeveloped.com",
  "sav.com",
];
const PARKING_PATTERNS = [
  /this domain (name )?(is|may be) for sale/i,
  /the domain [^<]{0,80} (is|may be) for sale/i,
  /buy this domain/i,
  /domain (name )?is parked/i,
  /parked (free|domain)/i,
  /courtesy of (godaddy|namecheap|porkbun)/i,
  /inquire about this domain/i,
  /this domain has expired/i,
  /domain (has been )?registered at namecheap/i,
  /sedoparking|parkingcrew|window\.park\b|parking-lander/i,
];

// ---------------------------------------------------------------------------
// Helpers

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { dryRun: false, only: null, concurrency: 6, summary: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--only") out.only = new Set(argv[++i].split(",").map((s) => s.trim()));
    else if (a === "--concurrency") out.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--summary") out.summary = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/check-handles.mjs [--dry-run] [--only a.com,b.net] [--concurrency N] [--summary file.md]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

class CheckerError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errorText(err) {
  const cause = err?.cause;
  return String(cause?.code || cause?.message || err?.message || err);
}

async function fetchText(url, { timeout = TIMEOUT_MS, accept } = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
    headers: { "user-agent": USER_AGENT, ...(accept ? { accept } : {}) },
  });
  let text = "";
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    while (size < MAX_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      text += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
  }
  return { status: res.status, url: res.url, text };
}

async function withRetry(fn, attempts = 2) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await sleep(500 * (i + 1));
    }
  }
  throw last;
}

// DNS over HTTPS (JSON API). Throws CheckerError when no resolver answers.
const DOH_RESOLVERS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];
const DNS_TYPES = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28 };

async function dns(name, type) {
  let lastErr;
  for (const resolver of DOH_RESOLVERS) {
    try {
      const url = `${resolver}?name=${encodeURIComponent(name)}&type=${type}`;
      const res = await withRetry(() => fetchText(url, { accept: "application/dns-json" }));
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const body = JSON.parse(res.text);
      // 0 = NOERROR, 3 = NXDOMAIN; anything else (SERVFAIL...) try the next resolver.
      if (body.Status !== 0 && body.Status !== 3) throw new Error(`DNS status ${body.Status}`);
      const answers = (body.Answer ?? [])
        .filter((a) => a.type === DNS_TYPES[type])
        .map((a) => String(a.data).replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
      return { nxdomain: body.Status === 3, answers };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new CheckerError(`DNS lookup failed for ${name} ${type}: ${errorText(lastErr)}`);
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};
const matchesHost = (host, list) => list.find((d) => host === d || host.endsWith(`.${d}`));

// ---------------------------------------------------------------------------
// Checks

async function checkDns(domain) {
  const [ns, a, aaaa] = await Promise.all([dns(domain, "NS"), dns(domain, "A"), dns(domain, "AAAA")]);
  const random = `zz-${randomBytes(6).toString("hex")}.${domain}`;
  const wild = await dns(random, "A");
  const nameservers = ns.answers.map((s) => s.replace(/\.$/, "").toLowerCase()).sort();
  const addresses = [...a.answers, ...aaaa.answers].sort();
  return {
    nxdomain: ns.nxdomain,
    resolves: addresses.length > 0,
    addresses,
    nameservers,
    wildcard: wild.answers.length > 0,
  };
}

async function checkWebsite(domain) {
  const site = { url: `https://${domain}/`, http_status: null, final_url: null, error: null, text: "" };
  for (const url of [`https://${domain}/`, `http://${domain}/`]) {
    try {
      const res = await withRetry(() => fetchText(url));
      Object.assign(site, { url, http_status: res.status, final_url: res.url, error: null, text: res.text });
      return site;
    } catch (err) {
      site.error = errorText(err);
    }
  }
  return site;
}

function detectParking(dnsInfo, site) {
  const ns = dnsInfo.nameservers.find((n) => matchesHost(n, PARKING_NAMESERVERS));
  if (ns) return `nameserver ${ns} belongs to a parking or domain marketplace service`;
  const finalHost = hostOf(site.final_url ?? "");
  const host = matchesHost(finalHost, PARKING_HOSTS);
  if (host) return `website redirects to ${finalHost} (domain marketplace)`;
  const pattern = PARKING_PATTERNS.find((p) => p.test(site.text));
  if (pattern) return `website matches a parked/for-sale page (${pattern.source})`;
  return null;
}

// Candidate handles under the domain, best sources first.
async function findSamples(entry, pages) {
  const domain = entry.domain;
  const suffix = `.${domain}`;
  const found = new Map();
  const add = (handle, source) => {
    const h = handle.toLowerCase().replace(/^@/, "").replace(/\.$/, "");
    if (!h.endsWith(suffix) || h === `www${suffix}`) return;
    if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(h)) return;
    if (!found.has(h)) found.set(h, source);
  };

  const maintainer = entry.maintainer?.url?.match(/bsky\.app\/profile\/([^/?#]+)/)?.[1];
  if (maintainer) add(maintainer, "maintainer");

  // Full-text search does not always match the whole domain, so fall back to
  // typeahead and to the domain's first label.
  const searches = [
    ["searchActors", domain],
    ["searchActorsTypeahead", domain],
    ["searchActors", domain.split(".")[0]],
  ];
  for (const [endpoint, q] of searches) {
    if (found.size >= MAX_SAMPLES) break;
    try {
      const url = `https://public.api.bsky.app/xrpc/app.bsky.actor.${endpoint}?q=${encodeURIComponent(q)}&limit=100`;
      const res = await withRetry(() => fetchText(url, { accept: "application/json" }), 3);
      if (res.status === 200) {
        for (const actor of JSON.parse(res.text).actors ?? []) add(actor.handle, "bluesky-search");
      }
    } catch {
      // Search is a best-effort source; the other sources still apply.
    }
  }

  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@?((?:[a-z0-9-]+\\.)+${escaped})(?![a-z0-9.-])`, "gi");
  for (const page of pages) {
    for (const m of page.text.matchAll(re)) add(m[1], `website:${hostOf(page.url)}`);
  }

  return [...found].slice(0, MAX_SAMPLES).map(([handle, source]) => ({ handle, source }));
}

async function didClaimsHandle(did, handle) {
  let url;
  if (did.startsWith("did:plc:")) url = `https://plc.directory/${did}`;
  else if (did.startsWith("did:web:")) {
    // The host comes from a stranger's DNS record; without this check it could
    // be an IP literal, a port or a path, and the runner would fetch it.
    const host = decodeURIComponent(did.slice(8));
    if (!/^(?=.*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return { ok: false, error: "unsupported did:web host" };
    url = `https://${host}/.well-known/did.json`;
  } else return { ok: false, error: `unsupported DID method (${did})` };
  try {
    const res = await withRetry(() => fetchText(url, { accept: "application/json" }));
    if (res.status === 404 || res.status === 410) return { ok: false, error: "DID not found" };
    if (res.status !== 200) return { ok: false, inconclusive: true, error: `DID document HTTP ${res.status}` };
    const doc = JSON.parse(res.text);
    const aka = (doc.alsoKnownAs ?? []).map((s) => String(s).toLowerCase());
    return aka.includes(`at://${handle}`)
      ? { ok: true }
      : { ok: false, error: "DID document does not claim this handle" };
  } catch (err) {
    return { ok: false, inconclusive: true, error: `DID document: ${errorText(err)}` };
  }
}

async function verifyHandle({ handle, source }) {
  const result = { handle, source, ok: false, did: null, via: null, error: null };
  let inconclusive = false;
  const dids = [];

  try {
    const txt = await dns(`_atproto.${handle}`, "TXT");
    const did = txt.answers.map((t) => t.match(/^did=(did:[a-z]+:[a-zA-Z0-9._:%-]+)$/)?.[1]).find(Boolean);
    if (did) dids.push({ did, via: "dns" });
  } catch {
    inconclusive = true;
  }
  let httpsError = null;
  try {
    const url = `https://${handle}/.well-known/atproto-did`;
    const res = await withRetry(() => fetchText(url, { timeout: 8_000 }), 3);
    const did = res.text.trim();
    if (res.status === 200 && /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/.test(did)) dids.push({ did, via: "https" });
    else httpsError = `well-known HTTP ${res.status}`;
  } catch (err) {
    // Most handles are DNS-only; an unreachable well-known endpoint is normal.
    httpsError = `well-known ${errorText(err)}`;
  }

  if (!dids.length) {
    result.error = inconclusive
      ? "DNS lookup failed"
      : `handle does not resolve (no _atproto TXT record; ${httpsError})`;
    return { ...result, inconclusive };
  }

  const { did, via } = dids[0];
  if (dids.length > 1 && dids[1].did !== did) {
    result.error = `DNS and HTTPS disagree (${did} vs ${dids[1].did})`;
    return { ...result, did };
  }
  const claim = await didClaimsHandle(did, handle);
  Object.assign(result, { ok: claim.ok, did, via: dids.length > 1 ? "dns+https" : via, error: claim.error ?? null });
  return { ...result, inconclusive: Boolean(claim.inconclusive) };
}

async function checkDomain(entry) {
  const domain = entry.domain;
  const check = {
    result: "error",
    consecutive_failures: entry.check?.consecutive_failures ?? 0,
    method: "domain_only",
    summary: "",
  };

  let dnsInfo;
  try {
    dnsInfo = await checkDns(domain);
  } catch (err) {
    check.summary = `check could not complete: ${err.message}`;
    return check;
  }
  check.dns = {
    resolves: dnsInfo.resolves,
    addresses: dnsInfo.addresses,
    nameservers: dnsInfo.nameservers,
    wildcard: dnsInfo.wildcard,
  };

  if (dnsInfo.nxdomain) {
    check.parked = null;
    check.sample_handle = null;
    check.sample_did = null;
    check.sample_source = null;
    check.samples_tried = [];
    check.result = "fail";
    check.summary = "domain does not exist in DNS (NXDOMAIN): registration lapsed or the domain was removed";
    return check;
  }

  const site = dnsInfo.resolves ? await checkWebsite(domain) : { url: `https://${domain}/`, http_status: null, final_url: null, error: "no A/AAAA record", text: "" };
  check.website = { url: site.url, http_status: site.http_status, final_url: site.final_url, error: site.error };
  check.parked = detectParking(dnsInfo, site);

  // The page that explains how to get a handle often lists member handles.
  const pages = [site];
  if (hostOf(entry.get_handle_url) !== hostOf(site.final_url ?? site.url)) {
    try {
      pages.push(await fetchText(entry.get_handle_url));
    } catch {
      // Optional source of sample handles only.
    }
  }

  const candidates = await findSamples(entry, pages);
  const tried = [];
  let verified = null;
  for (const candidate of candidates) {
    const r = await verifyHandle(candidate);
    tried.push(r);
    if (r.ok) {
      verified = r;
      break;
    }
  }
  check.samples_tried = tried.map(({ inconclusive, ...r }) => r);
  check.sample_handle = verified?.handle ?? null;
  check.sample_did = verified?.did ?? null;
  check.sample_source = verified?.source ?? null;
  if (tried.length) check.method = "sample_handle";

  if (check.parked) {
    check.result = "fail";
    check.summary = `parked or for sale: ${check.parked}`;
  } else if (verified) {
    check.result = "pass";
    check.summary = `${verified.handle} resolves to ${verified.did} via ${verified.via} (found via ${verified.source})`;
  } else if (tried.length && tried.every((r) => r.inconclusive)) {
    check.result = "error";
    check.summary = `check could not complete: ${tried[0].error}`;
  } else if (tried.length) {
    check.result = "fail";
    check.summary = `none of the ${tried.length} handle(s) found under the domain resolve (${tried.map((r) => r.handle).join(", ")})`;
  } else if (dnsInfo.nameservers.length) {
    check.result = "pass";
    check.summary =
      "no sample handle found; only domain-level signals checked (domain is delegated in DNS and not parked)" +
      (site.error ? `; website unreachable: ${site.error}` : "");
  } else {
    check.result = "fail";
    check.summary = "domain has no nameservers and no sample handle was found";
  }
  return check;
}

// ---------------------------------------------------------------------------
// State update and reporting

function applyResult(entry, check, today) {
  const before = { status: entry.status, failures: entry.check?.consecutive_failures ?? 0 };
  if (check.result === "pass") {
    check.consecutive_failures = 0;
    entry.status = "Active";
  } else if (check.result === "fail") {
    check.consecutive_failures = before.failures + 1;
    if (check.consecutive_failures >= FAILURES_TO_DEPRECATE) entry.status = "Deprecated";
  } else {
    check.consecutive_failures = before.failures;
  }
  if (check.result !== "error") entry.last_checked = today;
  entry.check = check;
  return before;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function buildSummary(rows, data, today) {
  const count = (s) => data.handles.filter((h) => h.status === s).length;
  const changed = rows.filter((r) => r.before.status !== r.entry.status);
  const firstFailures = rows.filter((r) => r.check.result === "fail" && r.entry.status === "Active");
  const errors = rows.filter((r) => r.check.result === "error");
  const lines = [];
  lines.push(`## Handle check ${today}`);
  lines.push("");
  lines.push(`Checked ${rows.length} of ${data.handles.length} domains.`);
  lines.push("");
  lines.push(`- Active: ${count("Active")}`);
  lines.push(`- Deprecated: ${count("Deprecated")}`);
  lines.push(`- Passed this run: ${rows.filter((r) => r.check.result === "pass").length}`);
  lines.push(`- Failed this run: ${rows.filter((r) => r.check.result === "fail").length}`);
  lines.push(`- Could not be checked: ${errors.length}`);
  lines.push("");
  const section = (title, list, fmt) => {
    lines.push(`### ${title}`);
    lines.push("");
    if (!list.length) lines.push("None.");
    for (const r of list) lines.push(`- ${fmt(r)}`);
    lines.push("");
  };
  section("Status changes", changed, (r) => `\`${r.entry.domain}\`: ${r.before.status} → ${r.entry.status} (${r.check.summary})`);
  section(
    `Failing, still Active (deprecated after ${FAILURES_TO_DEPRECATE} consecutive failures)`,
    firstFailures,
    (r) => `\`${r.entry.domain}\` (${r.check.consecutive_failures}/${FAILURES_TO_DEPRECATE}): ${r.check.summary}`,
  );
  section("Could not be checked", errors, (r) => `\`${r.entry.domain}\`: ${r.check.summary}`);
  lines.push("<details><summary>All results</summary>");
  lines.push("");
  lines.push("| Domain | Status | Result | Method | Details |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of rows) {
    const details = r.check.summary.replace(/\|/g, "\\|");
    lines.push(`| ${r.entry.domain} | ${r.entry.status} | ${r.check.result} | ${r.check.method} | ${details} |`);
  }
  lines.push("");
  lines.push("</details>");
  return lines.join("\n") + "\n";
}

async function main() {
  const data = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const targets = data.handles.filter((h) => !args.only || args.only.has(h.domain));
  if (!targets.length) {
    console.error("No domains to check.");
    process.exit(1);
  }

  const rows = await mapLimit(targets, args.concurrency, async (entry) => {
    let check;
    try {
      check = await checkDomain(entry);
    } catch (err) {
      check = {
        result: "error",
        consecutive_failures: entry.check?.consecutive_failures ?? 0,
        method: "domain_only",
        summary: `check could not complete: ${errorText(err)}`,
      };
    }
    const before = applyResult(entry, check, today);
    console.error(`${check.result.padEnd(5)} ${entry.domain}: ${check.summary}`);
    return { entry, check, before };
  });

  const summary = buildSummary(rows, data, today);
  if (!args.dryRun) writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  if (args.summary) writeFileSync(args.summary, summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);

  // Fail loudly if the checker could not check most domains (resolver outage,
  // no network): such a run should not be turned into a pull request.
  const errors = rows.filter((r) => r.check.result === "error").length;
  if (errors > rows.length / 2) {
    console.error(`${errors} of ${rows.length} checks could not complete; treating the run as failed.`);
    process.exit(1);
  }
}

main();
