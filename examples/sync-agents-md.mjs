#!/usr/bin/env node
/**
 * OpenAgentMemory — Zero-Dependency AGENTS.md Sync Script
 *
 * Reads oam.record.v1 memories from a local JSON file (e.g. memories.json,
 * memories/index.json, or examples/sample-memories.json) or fetches them from
 * a remote URL (Cloudflare Worker /records or /export/json, raw JSON URL),
 * filters to active, bitemporally valid, non-expired heads, and writes or
 * updates a marked summary block in AGENTS.md for coding agents.
 *
 * Zero external dependencies. Requires Node.js 18+ (native fetch & ESM).
 *
 * Usage examples:
 *   node examples/sync-agents-md.mjs --input examples/sample-memories.json --stdout
 *   node examples/sync-agents-md.mjs --input memories/index.json --output AGENTS.md
 *   node examples/sync-agents-md.mjs --url https://oam.example.workers.dev/records --token "$OAM_API_TOKEN"
 *   node examples/sync-agents-md.mjs --input examples/sample-memories.json --namespace public --as-of 2026-02-20T00:00:00Z --stdout
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER_START = "<!-- OAM:START -->";
const MARKER_END = "<!-- OAM:END -->";
const RECORD_SCHEMA = "oam.record.v1";

export function routeNamespace(namespace) {
  if (
    namespace === "public" ||
    namespace.startsWith("public/") ||
    namespace === "shared" ||
    namespace.startsWith("shared/")
  ) {
    return "gist";
  }
  return "repo";
}

export function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.records)) return payload.records;
    if (payload.schema === RECORD_SCHEMA) return [payload];
  }
  throw new Error("Input JSON must be an oam.bundle.v1/oam.index.v1 object, an array of oam.record.v1, or a single record.");
}

export function filterActiveRecords(records, opts = {}) {
  const asOfMs = opts.asOf ? Date.parse(opts.asOf) : Date.now();
  if (!Number.isFinite(asOfMs)) {
    throw new Error(`Invalid --as-of timestamp: ${opts.asOf}`);
  }
  const nsFilter = (opts.namespace || "all").trim();
  const isHistoricalQuery = Boolean(opts.asOf);

  return records
    .filter((rec) => {
      if (!rec || rec.schema !== RECORD_SCHEMA) return false;
      if (nsFilter !== "all" && !(rec.namespace === nsFilter || rec.namespace.startsWith(`${nsFilter}/`))) {
        return false;
      }

      const validFromMs = Date.parse(rec.valid_from);
      const validToMs = rec.valid_to ? Date.parse(rec.valid_to) : Infinity;
      const inValidWindow = asOfMs >= validFromMs && asOfMs < validToMs;
      if (!inValidWindow) return false;

      if (rec.expires_at && Date.parse(rec.expires_at) <= asOfMs) {
        return false;
      }

      // At current time, only active heads (superseded_by === null) are surfaced.
      // For explicit --as-of historical queries, allow records valid during that window.
      if (!isHistoricalQuery && rec.superseded_by !== null) {
        return false;
      }

      return true;
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key));
}

export function renderAgentsSummary(records, opts = {}) {
  const asOfIso = opts.asOf ? new Date(opts.asOf).toISOString() : new Date().toISOString();
  const includeCitations = opts.citations !== false;
  const sourceLabel = opts.sourceLabel || "local";

  const lines = [
    MARKER_START,
    "## OpenAgentMemory Summary (`oam.record.v1`)",
    "",
    `> Synced from \`${sourceLabel}\` · As-of: \`${asOfIso}\` · Active records: **${records.length}**`,
    "",
  ];

  if (records.length === 0) {
    lines.push("_No active, valid, non-expired memories matched the current filter._", "", MARKER_END);
    return lines.join("\n");
  }

  const grouped = new Map();
  for (const r of records) {
    if (!grouped.has(r.namespace)) grouped.set(r.namespace, []);
    grouped.get(r.namespace).push(r);
  }

  for (const ns of Array.from(grouped.keys()).sort()) {
    const scope = routeNamespace(ns) === "gist" ? "public/shared" : "private";
    lines.push(`### \`${ns}\` (${scope})`, "");
    for (const r of grouped.get(ns)) {
      const meta = [
        `\`oam://${r.namespace}/${r.key}\``,
        `kind: \`${r.kind || "fact"}\``,
        `v${r.version || 1}`,
        `valid from: ${String(r.valid_from).slice(0, 10)}`,
      ];
      if (r.expires_at) meta.push(`expires: ${String(r.expires_at).slice(0, 10)}`);

      lines.push(`- **${r.title}** _(${meta.join(" · ")})_`, `  ${r.content.replace(/\n+/g, "\n  ")}`);
      if (includeCitations && Array.isArray(r.citations) && r.citations.length > 0) {
        const citLinks = r.citations
          .map((c) => (c.label ? `[${c.label}](${c.uri})` : `\`${c.uri}\``))
          .join(", ");
        lines.push(`  _Citations:_ ${citLinks}`);
      }
    }
    lines.push("");
  }

  lines.push(MARKER_END);
  return lines.join("\n");
}

export function mergeSummaryBlock(existingContent, summaryBlock, overwrite = false) {
  if (overwrite || !existingContent || !existingContent.trim()) {
    return `# AGENTS.md\n\n${summaryBlock}\n`;
  }

  const startIdx = existingContent.indexOf(MARKER_START);
  const endIdx = existingContent.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existingContent.slice(0, startIdx).trimEnd();
    const after = existingContent.slice(endIdx + MARKER_END.length).trimStart();
    const prefix = before ? `${before}\n\n` : "";
    const suffix = after ? `\n\n${after}` : "\n";
    return `${prefix}${summaryBlock}${suffix}`;
  }

  return `${existingContent.trimEnd()}\n\n${summaryBlock}\n`;
}

function parseArgs(argv) {
  const args = {
    input: null,
    url: null,
    token: process.env.OAM_API_TOKEN || "",
    output: "AGENTS.md",
    namespace: "all",
    asOf: null,
    citations: true,
    stdout: false,
    overwrite: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--stdout" || a === "--dry-run") args.stdout = true;
    else if (a === "--overwrite") args.overwrite = true;
    else if (a === "--no-citations") args.citations = false;
    else if (a === "--input" || a === "-i") args.input = argv[++i];
    else if (a === "--url" || a === "-u") args.url = argv[++i];
    else if (a === "--token" || a === "-t") args.token = argv[++i];
    else if (a === "--output" || a === "-o") args.output = argv[++i];
    else if (a === "--namespace" || a === "-n") args.namespace = argv[++i];
    else if (a === "--as-of") args.asOf = argv[++i];
    else if (!a.startsWith("-") && !args.input) args.input = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function printHelp() {
  console.log(`OpenAgentMemory — Sync memories.json to AGENTS.md

Usage:
  node examples/sync-agents-md.mjs [options]

Options:
  -i, --input <file>       Local JSON file (default: memories.json or examples/sample-memories.json)
  -u, --url <url>          Remote JSON URL (e.g. Cloudflare Worker /records or /export/json)
  -t, --token <token>      Optional Bearer token for --url (defaults to $OAM_API_TOKEN)
  -o, --output <file>      Target Markdown file (default: AGENTS.md; updates <!-- OAM:START --> block)
  -n, --namespace <ns>     Filter by namespace prefix (e.g. public, shared, private, all)
      --as-of <iso-8601>   Bitemporal Valid-At timestamp (default: now)
      --no-citations       Omit citations from generated summary
      --overwrite          Replace entire output file instead of updating the OAM marker block
      --stdout, --dry-run  Print Markdown to stdout without writing to disk
  -h, --help               Show this help message`);
}

async function loadPayload(args) {
  if (args.url) {
    const headers = { Accept: "application/json" };
    if (args.token) headers.Authorization = `Bearer ${args.token}`;
    let res;
    try {
      res = await fetch(args.url, { headers });
    } catch (err) {
      throw new Error(`Network error fetching ${args.url}: ${err.message}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const hint =
        res.status === 401
          ? " (pass --token or set OAM_API_TOKEN)"
          : res.status === 403
          ? " (check token permissions or rate limit)"
          : "";
      throw new Error(
        `Failed to fetch ${args.url}: HTTP ${res.status} ${res.statusText}${hint}${detail ? ` — ${detail.slice(0, 160)}` : ""}`
      );
    }
    try {
      return { payload: await res.json(), sourceLabel: args.url };
    } catch {
      throw new Error(`Response from ${args.url} was not valid JSON.`);
    }
  }

  let inputPath = args.input;
  if (!inputPath) {
    const candidates = ["memories.json", "memories/index.json", "examples/sample-memories.json"];
    inputPath = candidates.find((p) => fs.existsSync(p));
    if (!inputPath) {
      throw new Error("No input file found. Pass --input <path> or --url <endpoint>.");
    }
  }

  const resolved = path.resolve(inputPath);
  const raw = fs.readFileSync(resolved, "utf8");
  return { payload: JSON.parse(raw), sourceLabel: inputPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const { payload, sourceLabel } = await loadPayload(args);
  const allRecords = extractRecords(payload);
  const activeRecords = filterActiveRecords(allRecords, {
    namespace: args.namespace,
    asOf: args.asOf,
  });

  const summaryBlock = renderAgentsSummary(activeRecords, {
    asOf: args.asOf,
    citations: args.citations,
    sourceLabel,
  });

  if (args.stdout) {
    process.stdout.write(summaryBlock + "\n");
    return;
  }

  const outPath = path.resolve(args.output);
  const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
  const merged = mergeSummaryBlock(existing, summaryBlock, args.overwrite);
  fs.writeFileSync(outPath, merged, "utf8");
  console.log(`Synced ${activeRecords.length} active OAM record(s) from ${sourceLabel} -> ${args.output}`);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
