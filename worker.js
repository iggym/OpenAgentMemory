/**
 * OpenAgentMemory (OAM) — Reference Cloudflare Worker
 * Spec: oam.record.v1 (see SPEC.md)
 *
 * Zero dependencies. Zero build step. Paste directly into Cloudflare Workers
 * or deploy via Wrangler on the Cloudflare Workers Free tier.
 *
 * Namespace Routing (Fail-Closed):
 *   - public, public/*, shared, shared/*  -> GitHub Gist (GIST_ID)
 *   - private, private/*, and ALL others  -> Private GitHub Repo (GITHUB_REPO)
 *
 * Security Note: GitHub Gists only have public and secret visibility (secret
 * Gists are unlisted, NOT private). Never route private/* data to a Gist; use
 * a Private GitHub Repository or an authenticated Cloudflare backend (D1/KV).
 *
 * Required / Optional Environment Variables (Cloudflare Secrets & Vars):
 *   GITHUB_TOKEN     : GitHub PAT (fallback for both Gist and Repo)
 *   GIST_TOKEN       : Optional PAT with `gist` scope (overrides GITHUB_TOKEN for Gist)
 *   REPO_TOKEN       : Optional fine-grained PAT with `Contents: Read & Write` (overrides GITHUB_TOKEN for Repo)
 *   GIST_ID          : Target GitHub Gist ID for public/* and shared/* namespaces
 *   GITHUB_REPO      : Target private GitHub repository in "owner/repo" format for private/*
 *   GITHUB_BRANCH    : Optional branch name in GITHUB_REPO (default: "main")
 *   OAM_API_TOKEN    : Optional bearer token protecting writes and non-public reads
 *   PUBLIC_READ_OPEN : Set to "false" to also require OAM_API_TOKEN for public/* reads (default: "true")
 *   ALLOWED_ORIGIN   : CORS Access-Control-Allow-Origin value (default: "*")
 */

const RECORD_SCHEMA = "oam.record.v1";
const CHAIN_SCHEMA = "oam.chain.v1";
const INDEX_SCHEMA = "oam.index.v1";
const BUNDLE_SCHEMA = "oam.bundle.v1";

const NAMESPACE_RE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VALID_KINDS = new Set([
  "fact",
  "preference",
  "decision",
  "procedure",
  "context",
  "constraint",
]);

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "OpenAgentMemory-Worker/1.0";

export default {
  async fetch(request, env) {
    const cors = buildCorsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method.toUpperCase();

      // Health & discovery endpoint
      if (method === "GET" && (path === "/" || path === "/health")) {
        return jsonResponse(
          {
            ok: true,
            service: "OpenAgentMemory",
            schema: RECORD_SCHEMA,
            routing: {
              gist: ["public", "public/*", "shared", "shared/*"],
              repo: ["private", "private/*", "* (fail-closed default)"],
            },
            backends: {
              gist: Boolean(env.GIST_ID && (env.GIST_TOKEN || env.GITHUB_TOKEN)),
              repo: Boolean(env.GITHUB_REPO && (env.REPO_TOKEN || env.GITHUB_TOKEN)),
            },
            auth_enabled: Boolean(env.OAM_API_TOKEN),
          },
          200,
          cors
        );
      }

      const authed = isAuthorized(request, env);
      const publicReadOpen = env.PUBLIC_READ_OPEN !== "false";

      // GET /records — query records across routed backends
      if (method === "GET" && path === "/records") {
        const result = await handleQueryRecords(url, env, authed, publicReadOpen);
        return jsonResponse(result.body, result.status, cors);
      }

      // GET /record?namespace=...&key=... — fetch full version chain for one key
      if (method === "GET" && path === "/record") {
        const namespace = (url.searchParams.get("namespace") || "").trim();
        const key = (url.searchParams.get("key") || "").trim();
        const addrErr = validateAddress(namespace, key);
        if (addrErr) return jsonResponse({ ok: false, error: addrErr }, 400, cors);

        const isPublic = isPublicNamespace(namespace);
        if (!authed && !(isPublic && publicReadOpen)) {
          return jsonResponse({ ok: false, error: "Unauthorized" }, 401, cors);
        }

        const route = routeNamespace(namespace);
        const chain =
          route === "gist"
            ? await readGistChain(env, namespace, key)
            : await readRepoChain(env, namespace, key);

        const head = chain.find((r) => r.superseded_by === null) || null;
        return jsonResponse(
          {
            ok: true,
            route,
            address: `oam://${namespace}/${key}`,
            head,
            records: chain,
          },
          200,
          cors
        );
      }

      // POST or PUT /records — create or supersede a record
      if ((method === "POST" || method === "PUT") && path === "/records") {
        if (!authed) {
          return jsonResponse({ ok: false, error: "Unauthorized" }, 401, cors);
        }

        let payload;
        try {
          payload = await request.json();
        } catch {
          return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, cors);
        }

        const closePreviousValidTo = payload.close_previous_valid_to !== false;
        const { record, errors } = normalizeAndValidateRecord(payload);
        if (errors.length > 0) {
          return jsonResponse({ ok: false, error: "Validation failed", details: errors }, 400, cors);
        }

        const route = routeNamespace(record.namespace);
        const saved =
          route === "gist"
            ? await upsertGistRecord(env, record, closePreviousValidTo)
            : await upsertRepoRecord(env, record, closePreviousValidTo);

        return jsonResponse(
          {
            ok: true,
            route,
            address: `oam://${saved.record.namespace}/${saved.record.key}`,
            record: saved.record,
            superseded: saved.superseded,
          },
          201,
          cors
        );
      }

      // DELETE /records?namespace=...&key=...&id=...&mode=expire|hard
      if (method === "DELETE" && path === "/records") {
        if (!authed) {
          return jsonResponse({ ok: false, error: "Unauthorized" }, 401, cors);
        }

        const namespace = (url.searchParams.get("namespace") || "").trim();
        const key = (url.searchParams.get("key") || "").trim();
        const id = (url.searchParams.get("id") || "").trim() || null;
        const mode = (url.searchParams.get("mode") || "expire").toLowerCase();

        const addrErr = validateAddress(namespace, key);
        if (addrErr) return jsonResponse({ ok: false, error: addrErr }, 400, cors);
        if (mode !== "expire" && mode !== "hard") {
          return jsonResponse({ ok: false, error: "mode must be 'expire' or 'hard'" }, 400, cors);
        }

        const route = routeNamespace(namespace);
        const outcome =
          route === "gist"
            ? await deleteOrExpireGistRecord(env, namespace, key, id, mode)
            : await deleteOrExpireRepoRecord(env, namespace, key, id, mode);

        return jsonResponse({ ok: true, route, mode, ...outcome }, 200, cors);
      }

      // GET /export/agents.md — deterministic Markdown projection
      if (method === "GET" && path === "/export/agents.md") {
        const result = await handleQueryRecords(url, env, authed, publicReadOpen);
        if (result.status !== 200) {
          return jsonResponse(result.body, result.status, cors);
        }
        const md = renderAgentsMarkdown(result.body.records, {
          namespaceFilter: url.searchParams.get("namespace") || "all",
          asOf: result.body.as_of,
        });
        return new Response(md, {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": 'inline; filename="AGENTS.md"',
          },
        });
      }

      // GET /export/json — portable oam.bundle.v1 export
      if (method === "GET" && path === "/export/json") {
        const result = await handleQueryRecords(url, env, authed, publicReadOpen);
        if (result.status !== 200) {
          return jsonResponse(result.body, result.status, cors);
        }
        const bundle = {
          schema: BUNDLE_SCHEMA,
          record_schema: RECORD_SCHEMA,
          exported_at: new Date().toISOString(),
          count: result.body.records.length,
          records: result.body.records,
        };
        return jsonResponse(bundle, 200, cors);
      }

      return jsonResponse({ ok: false, error: `Route not found: ${method} ${path}` }, 404, cors);
    } catch (err) {
      const status = err.status && Number.isInteger(err.status) ? err.status : 500;
      return jsonResponse(
        {
          ok: false,
          error: err.message || "Internal worker error",
        },
        status,
        cors
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Namespace Routing & Validation
// ---------------------------------------------------------------------------

/**
 * Fail-closed namespace router per SPEC.md §6.
 * Only explicit `public`, `public/*`, `shared`, and `shared/*` route to Gist.
 * `private/*` and every unrecognized namespace route to the private GitHub repo.
 */
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

function isPublicNamespace(namespace) {
  return namespace === "public" || namespace.startsWith("public/");
}

function validateAddress(namespace, key) {
  if (!namespace || namespace.length > 128 || !NAMESPACE_RE.test(namespace)) {
    return "Invalid namespace. Use lowercase slash-delimited segments (e.g. 'public/architecture' or 'private/preferences').";
  }
  if (namespace.includes("..")) {
    return "Invalid namespace: path traversal is forbidden.";
  }
  if (!key || key.length > 128 || !KEY_RE.test(key) || key.includes("..")) {
    return "Invalid key. Use lowercase alphanumeric characters with '.', '_', or '-'.";
  }
  return null;
}

function isValidIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function generateRecordId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `oam_${stamp}_${rand}`;
}

function normalizeAndValidateRecord(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { record: null, errors: ["Payload must be a JSON object."] };
  }

  const nowIso = new Date().toISOString();
  const schema = input.schema || RECORD_SCHEMA;
  if (schema !== RECORD_SCHEMA) {
    errors.push(`schema must be "${RECORD_SCHEMA}".`);
  }

  const namespace = String(input.namespace || "").trim();
  const key = String(input.key || "").trim();
  const addrErr = validateAddress(namespace, key);
  if (addrErr) errors.push(addrErr);

  const title = String(input.title || "").trim();
  if (!title) errors.push("title is required.");

  const content = String(input.content || "").trim();
  if (!content) errors.push("content is required.");

  const kind = input.kind ? String(input.kind).trim().toLowerCase() : "fact";
  if (!VALID_KINDS.has(kind)) {
    errors.push(`kind must be one of: ${Array.from(VALID_KINDS).join(", ")}.`);
  }

  const validFrom = input.valid_from ? String(input.valid_from).trim() : nowIso;
  if (!isValidIsoTimestamp(validFrom)) errors.push("valid_from must be a valid ISO-8601 timestamp.");

  const validTo =
    input.valid_to === undefined || input.valid_to === null || input.valid_to === ""
      ? null
      : String(input.valid_to).trim();
  if (validTo !== null && !isValidIsoTimestamp(validTo)) {
    errors.push("valid_to must be null or a valid ISO-8601 timestamp.");
  }
  if (validTo !== null && isValidIsoTimestamp(validFrom) && isValidIsoTimestamp(validTo)) {
    if (Date.parse(validTo) < Date.parse(validFrom)) {
      errors.push("valid_to must be greater than or equal to valid_from.");
    }
  }

  const expiresAt =
    input.expires_at === undefined || input.expires_at === null || input.expires_at === ""
      ? null
      : String(input.expires_at).trim();
  if (expiresAt !== null && !isValidIsoTimestamp(expiresAt)) {
    errors.push("expires_at must be null or a valid ISO-8601 timestamp.");
  }

  const confidence =
    input.confidence === undefined || input.confidence === null ? 1.0 : Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push("confidence must be a number between 0.0 and 1.0.");
  }

  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
    : [];

  const provIn = input.provenance && typeof input.provenance === "object" ? input.provenance : {};
  const actor = String(provIn.actor || "").trim();
  const source = String(provIn.source || "").trim();
  if (!actor) errors.push("provenance.actor is required.");
  if (!source) errors.push("provenance.source is required.");

  const provenance = {
    actor,
    source,
    method: provIn.method ? String(provIn.method).trim() : "explicit",
    trust: provIn.trust ? String(provIn.trust).trim() : "verified",
    session_id: provIn.session_id ? String(provIn.session_id).trim() : null,
  };

  const citations = [];
  if (input.citations !== undefined) {
    if (!Array.isArray(input.citations)) {
      errors.push("citations must be an array.");
    } else {
      for (let i = 0; i < input.citations.length; i++) {
        const c = input.citations[i];
        if (!c || typeof c !== "object" || !String(c.uri || "").trim()) {
          errors.push(`citations[${i}].uri is required.`);
        } else {
          citations.push({
            uri: String(c.uri).trim(),
            label: c.label ? String(c.label).trim() : undefined,
            excerpt: c.excerpt ? String(c.excerpt).trim() : undefined,
            accessed_at: c.accessed_at ? String(c.accessed_at).trim() : undefined,
          });
        }
      }
    }
  }

  const record = {
    schema: RECORD_SCHEMA,
    id: input.id && String(input.id).trim() ? String(input.id).trim() : generateRecordId(),
    namespace,
    key,
    title,
    content,
    kind,
    tags,
    confidence,
    valid_from: new Date(validFrom).toISOString(),
    valid_to: validTo ? new Date(validTo).toISOString() : null,
    recorded_at: nowIso,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    version: Number.isInteger(input.version) && input.version >= 1 ? input.version : 1,
    supersedes: input.supersedes || null,
    superseded_by: null,
    provenance,
    citations,
  };

  if (input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)) {
    record.metadata = input.metadata;
  }

  return { record, errors };
}

// ---------------------------------------------------------------------------
// Query & Bitemporal Filtering
// ---------------------------------------------------------------------------

async function handleQueryRecords(url, env, authed, publicReadOpen) {
  const nsFilter = (url.searchParams.get("namespace") || "").trim();
  const keyFilter = (url.searchParams.get("key") || "").trim();
  const backendParam = (url.searchParams.get("backend") || "all").toLowerCase();
  const includeSuperseded = url.searchParams.get("include_superseded") === "true";
  const includeExpired = url.searchParams.get("include_expired") === "true";
  const queryText = (url.searchParams.get("q") || "").trim().toLowerCase();

  const asOfParam = url.searchParams.get("as_of");
  const recordedAsOfParam = url.searchParams.get("recorded_as_of");
  const asOfMs = asOfParam ? Date.parse(asOfParam) : Date.now();
  const recordedAsOfMs = recordedAsOfParam ? Date.parse(recordedAsOfParam) : Date.now();

  if (!Number.isFinite(asOfMs)) {
    return { status: 400, body: { ok: false, error: "Invalid as_of timestamp." } };
  }
  if (!Number.isFinite(recordedAsOfMs)) {
    return { status: 400, body: { ok: false, error: "Invalid recorded_as_of timestamp." } };
  }

  const canReadGist = Boolean(env.GIST_ID && (env.GIST_TOKEN || env.GITHUB_TOKEN));
  const canReadRepo = Boolean(env.GITHUB_REPO && (env.REPO_TOKEN || env.GITHUB_TOKEN));

  // Decide which backends to query based on namespace filter and auth
  let wantGist = backendParam === "all" || backendParam === "gist";
  let wantRepo = backendParam === "all" || backendParam === "repo";

  if (nsFilter) {
    const targetRoute = routeNamespace(nsFilter);
    wantGist = targetRoute === "gist";
    wantRepo = targetRoute === "repo";
  }

  // Enforce access control: unauthenticated callers cannot read private/shared data
  if (!authed) {
    if (!publicReadOpen) {
      return { status: 401, body: { ok: false, error: "Unauthorized" } };
    }
    if (nsFilter && !isPublicNamespace(nsFilter)) {
      return { status: 401, body: { ok: false, error: "Unauthorized for non-public namespace" } };
    }
    wantRepo = false;
  }

  const allRecords = [];
  if (wantGist && canReadGist) {
    const gistRecords = await listGistRecords(env);
    for (const rec of gistRecords) {
      if (authed || isPublicNamespace(rec.namespace)) {
        allRecords.push(rec);
      }
    }
  }
  if (wantRepo && canReadRepo) {
    const repoRecords = await listRepoRecords(env);
    allRecords.push(...repoRecords);
  }

  const byId = new Map(allRecords.map((r) => [r.id, r]));

  const filtered = allRecords.filter((rec) => {
    if (nsFilter && !(rec.namespace === nsFilter || rec.namespace.startsWith(`${nsFilter}/`))) {
      return false;
    }
    if (keyFilter && rec.key !== keyFilter) {
      return false;
    }

    const recRecordedMs = Date.parse(rec.recorded_at);
    if (Number.isFinite(recRecordedMs) && recRecordedMs > recordedAsOfMs) {
      return false;
    }

    if (!includeSuperseded && rec.superseded_by) {
      const successor = byId.get(rec.superseded_by);
      // If querying historical system time, record was still head if successor wasn't recorded yet
      if (!successor || Date.parse(successor.recorded_at) <= recordedAsOfMs) {
        return false;
      }
    }

    if (!includeExpired && rec.expires_at) {
      if (Date.parse(rec.expires_at) <= asOfMs) {
        return false;
      }
    }

    const validFromMs = Date.parse(rec.valid_from);
    const validToMs = rec.valid_to ? Date.parse(rec.valid_to) : Infinity;
    if (asOfMs < validFromMs || asOfMs >= validToMs) {
      return false;
    }

    if (queryText) {
      const haystack = [
        rec.namespace,
        rec.key,
        rec.title,
        rec.content,
        rec.kind,
        ...(rec.tags || []),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(queryText)) return false;
    }

    return true;
  });

  filtered.sort((a, b) => {
    const nsCmp = a.namespace.localeCompare(b.namespace);
    if (nsCmp !== 0) return nsCmp;
    const keyCmp = a.key.localeCompare(b.key);
    if (keyCmp !== 0) return keyCmp;
    return Date.parse(b.recorded_at) - Date.parse(a.recorded_at);
  });

  return {
    status: 200,
    body: {
      ok: true,
      schema: RECORD_SCHEMA,
      as_of: new Date(asOfMs).toISOString(),
      recorded_as_of: new Date(recordedAsOfMs).toISOString(),
      count: filtered.length,
      records: filtered,
    },
  };
}

// ---------------------------------------------------------------------------
// Supersession Helper
// ---------------------------------------------------------------------------

function applySupersession(existingChain, newRecord, closePreviousValidTo) {
  const chain = existingChain.map((r) => ({ ...r }));
  let superseded = null;

  // Find current active head (superseded_by === null)
  const headIdx = chain.findIndex((r) => r.superseded_by === null);
  if (headIdx !== -1) {
    const prev = chain[headIdx];
    prev.superseded_by = newRecord.id;

    if (closePreviousValidTo && prev.valid_to === null) {
      const prevFromMs = Date.parse(prev.valid_from);
      const newFromMs = Date.parse(newRecord.valid_from);
      prev.valid_to =
        newFromMs >= prevFromMs ? newRecord.valid_from : prev.valid_from;
    }

    newRecord.supersedes = prev.id;
    newRecord.version = (prev.version || 1) + 1;
    superseded = prev;
  } else {
    const maxVersion = chain.reduce((m, r) => Math.max(m, r.version || 1), 0);
    newRecord.version = maxVersion + 1;
  }

  chain.push(newRecord);
  return { chain, record: newRecord, superseded };
}

// ---------------------------------------------------------------------------
// Backend 1: GitHub Gist Adapter (public/* and shared/*)
// ---------------------------------------------------------------------------

function encodeGistFilename(namespace, key) {
  return `oam__${namespace.replace(/\//g, "__")}--${key}.json`;
}

function getGistConfig(env) {
  const token = env.GIST_TOKEN || env.GITHUB_TOKEN;
  const gistId = env.GIST_ID;
  if (!gistId || !token) {
    const err = new Error(
      "GitHub Gist backend is not configured. Set GIST_ID and GIST_TOKEN (or GITHUB_TOKEN)."
    );
    err.status = 503;
    throw err;
  }
  return { gistId, token };
}

async function fetchGist(env) {
  const { gistId, token } = getGistConfig(env);
  const res = await fetch(`${GITHUB_API}/gists/${encodeURIComponent(gistId)}`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) {
    throw await githubApiError("Failed to read GitHub Gist", res);
  }
  return res.json();
}

async function extractGistFileJson(fileObj, token) {
  let raw = fileObj.content || "";
  if (fileObj.truncated && fileObj.raw_url) {
    const rawRes = await fetch(fileObj.raw_url, { headers: githubHeaders(token) });
    if (!rawRes.ok) {
      throw await githubApiError("Failed to fetch truncated Gist file", rawRes);
    }
    raw = await rawRes.text();
  }
  return JSON.parse(raw);
}

async function listGistRecords(env) {
  const { token } = getGistConfig(env);
  const gist = await fetchGist(env);
  const files = gist.files || {};
  const records = [];

  for (const [filename, fileObj] of Object.entries(files)) {
    if (!filename.startsWith("oam__") || !filename.endsWith(".json")) continue;
    try {
      const parsed = await extractGistFileJson(fileObj, token);
      if (parsed && Array.isArray(parsed.records)) {
        records.push(...parsed.records);
      } else if (parsed && parsed.schema === RECORD_SCHEMA) {
        records.push(parsed);
      }
    } catch {
      // Ignore malformed non-OAM files in Gist
    }
  }
  return records;
}

async function readGistChain(env, namespace, key) {
  const { token } = getGistConfig(env);
  const gist = await fetchGist(env);
  const filename = encodeGistFilename(namespace, key);
  const fileObj = gist.files && gist.files[filename];
  if (!fileObj) return [];
  const parsed = await extractGistFileJson(fileObj, token);
  if (parsed && Array.isArray(parsed.records)) return parsed.records;
  if (parsed && parsed.schema === RECORD_SCHEMA) return [parsed];
  return [];
}

async function patchGistFile(env, filename, contentOrNull) {
  const { gistId, token } = getGistConfig(env);
  const body = {
    files: {
      [filename]: contentOrNull === null ? null : { content: contentOrNull },
    },
  };
  const res = await fetch(`${GITHUB_API}/gists/${encodeURIComponent(gistId)}`, {
    method: "PATCH",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await githubApiError("Failed to update GitHub Gist", res);
  }
}

async function upsertGistRecord(env, record, closePreviousValidTo) {
  const existingChain = await readGistChain(env, record.namespace, record.key);
  const { chain, record: savedRecord, superseded } = applySupersession(
    existingChain,
    record,
    closePreviousValidTo
  );

  const envelope = {
    schema: CHAIN_SCHEMA,
    namespace: savedRecord.namespace,
    key: savedRecord.key,
    updated_at: new Date().toISOString(),
    records: chain,
  };

  const filename = encodeGistFilename(savedRecord.namespace, savedRecord.key);
  await patchGistFile(env, filename, JSON.stringify(envelope, null, 2));
  return { record: savedRecord, superseded };
}

async function deleteOrExpireGistRecord(env, namespace, key, id, mode) {
  const filename = encodeGistFilename(namespace, key);
  const chain = await readGistChain(env, namespace, key);
  if (chain.length === 0) {
    const err = new Error(`No records found at oam://${namespace}/${key}`);
    err.status = 404;
    throw err;
  }

  const nowIso = new Date().toISOString();
  let updatedChain;

  if (mode === "expire") {
    let matched = false;
    updatedChain = chain.map((r) => {
      if (id ? r.id === id : r.superseded_by === null) {
        matched = true;
        return { ...r, expires_at: nowIso };
      }
      return r;
    });
    if (!matched) {
      const err = new Error("Target record not found in chain.");
      err.status = 404;
      throw err;
    }
    const envelope = {
      schema: CHAIN_SCHEMA,
      namespace,
      key,
      updated_at: nowIso,
      records: updatedChain,
    };
    await patchGistFile(env, filename, JSON.stringify(envelope, null, 2));
    return { address: `oam://${namespace}/${key}`, remaining: updatedChain.length };
  }

  // Hard delete
  updatedChain = id ? chain.filter((r) => r.id !== id) : [];
  if (updatedChain.length === 0) {
    await patchGistFile(env, filename, null);
  } else {
    const envelope = {
      schema: CHAIN_SCHEMA,
      namespace,
      key,
      updated_at: nowIso,
      records: updatedChain,
    };
    await patchGistFile(env, filename, JSON.stringify(envelope, null, 2));
  }
  return { address: `oam://${namespace}/${key}`, remaining: updatedChain.length };
}

// ---------------------------------------------------------------------------
// Backend 2: Private GitHub Repository Adapter (private/* & default)
// ---------------------------------------------------------------------------

function getRepoConfig(env) {
  const token = env.REPO_TOKEN || env.GITHUB_TOKEN;
  const repo = (env.GITHUB_REPO || "").trim();
  const branch = (env.GITHUB_BRANCH || "main").trim();
  if (!repo || !repo.includes("/") || !token) {
    const err = new Error(
      "Private GitHub Repo backend is not configured. Set GITHUB_REPO ('owner/repo') and REPO_TOKEN (or GITHUB_TOKEN)."
    );
    err.status = 503;
    throw err;
  }
  return { repo, branch, token };
}

function repoChainPath(namespace, key) {
  return `memories/${namespace}/${key}.json`;
}

const REPO_INDEX_PATH = "memories/index.json";

async function readRepoFile(env, filePath) {
  const { repo, branch, token } = getRepoConfig(env);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw await githubApiError(`Failed to read ${filePath} from ${repo}`, res);
  }
  const data = await res.json();
  const text = fromBase64Utf8(data.content || "");
  try {
    return { sha: data.sha, json: JSON.parse(text) };
  } catch {
    const err = new Error(`Malformed JSON in ${repo}/${filePath}`);
    err.status = 502;
    throw err;
  }
}

async function writeRepoFile(env, filePath, jsonObj, message, existingSha = null) {
  const { repo, branch, token } = getRepoConfig(env);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodedPath}`;
  const body = {
    message,
    content: toBase64Utf8(JSON.stringify(jsonObj, null, 2) + "\n"),
    branch,
  };
  if (existingSha) body.sha = existingSha;

  const res = await fetch(url, {
    method: "PUT",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await githubApiError(`Failed to write ${filePath} to ${repo}`, res);
  }
  return res.json();
}

async function deleteRepoFile(env, filePath, sha, message) {
  const { repo, branch, token } = getRepoConfig(env);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodedPath}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch }),
  });
  if (!res.ok) {
    throw await githubApiError(`Failed to delete ${filePath} from ${repo}`, res);
  }
}

async function listRepoRecords(env) {
  const indexFile = await readRepoFile(env, REPO_INDEX_PATH);
  if (!indexFile || !indexFile.json) return [];
  if (Array.isArray(indexFile.json.records)) return indexFile.json.records;
  if (Array.isArray(indexFile.json)) return indexFile.json;
  return [];
}

async function readRepoChain(env, namespace, key) {
  const file = await readRepoFile(env, repoChainPath(namespace, key));
  if (!file || !file.json) return [];
  if (Array.isArray(file.json.records)) return file.json.records;
  if (file.json.schema === RECORD_SCHEMA) return [file.json];
  return [];
}

async function syncRepoIndex(env, namespace, key, newChain, commitMessage) {
  const indexFile = await readRepoFile(env, REPO_INDEX_PATH);
  const existingRecords =
    indexFile && indexFile.json && Array.isArray(indexFile.json.records)
      ? indexFile.json.records
      : [];

  const others = existingRecords.filter(
    (r) => !(r.namespace === namespace && r.key === key)
  );
  const merged = [...others, ...newChain];

  const indexPayload = {
    schema: INDEX_SCHEMA,
    updated_at: new Date().toISOString(),
    records: merged,
  };
  await writeRepoFile(
    env,
    REPO_INDEX_PATH,
    indexPayload,
    commitMessage,
    indexFile ? indexFile.sha : null
  );
}

async function upsertRepoRecord(env, record, closePreviousValidTo) {
  const filePath = repoChainPath(record.namespace, record.key);
  const existingFile = await readRepoFile(env, filePath);
  const existingChain =
    existingFile && existingFile.json && Array.isArray(existingFile.json.records)
      ? existingFile.json.records
      : [];

  const { chain, record: savedRecord, superseded } = applySupersession(
    existingChain,
    record,
    closePreviousValidTo
  );

  const envelope = {
    schema: CHAIN_SCHEMA,
    namespace: savedRecord.namespace,
    key: savedRecord.key,
    updated_at: new Date().toISOString(),
    records: chain,
  };

  const action = superseded ? "supersede" : "create";
  const commitMsg = `oam(${action}): ${savedRecord.namespace}/${savedRecord.key} v${savedRecord.version}`;

  await writeRepoFile(env, filePath, envelope, commitMsg, existingFile ? existingFile.sha : null);
  await syncRepoIndex(env, savedRecord.namespace, savedRecord.key, chain, `oam(index): ${savedRecord.namespace}/${savedRecord.key}`);

  return { record: savedRecord, superseded };
}

async function deleteOrExpireRepoRecord(env, namespace, key, id, mode) {
  const filePath = repoChainPath(namespace, key);
  const existingFile = await readRepoFile(env, filePath);
  const chain =
    existingFile && existingFile.json && Array.isArray(existingFile.json.records)
      ? existingFile.json.records
      : [];

  if (chain.length === 0) {
    const err = new Error(`No records found at oam://${namespace}/${key}`);
    err.status = 404;
    throw err;
  }

  const nowIso = new Date().toISOString();
  let updatedChain;

  if (mode === "expire") {
    let matched = false;
    updatedChain = chain.map((r) => {
      if (id ? r.id === id : r.superseded_by === null) {
        matched = true;
        return { ...r, expires_at: nowIso };
      }
      return r;
    });
    if (!matched) {
      const err = new Error("Target record not found in chain.");
      err.status = 404;
      throw err;
    }
    const envelope = {
      schema: CHAIN_SCHEMA,
      namespace,
      key,
      updated_at: nowIso,
      records: updatedChain,
    };
    await writeRepoFile(
      env,
      filePath,
      envelope,
      `oam(expire): ${namespace}/${key}`,
      existingFile.sha
    );
    await syncRepoIndex(env, namespace, key, updatedChain, `oam(index): expire ${namespace}/${key}`);
    return { address: `oam://${namespace}/${key}`, remaining: updatedChain.length };
  }

  // Hard delete
  updatedChain = id ? chain.filter((r) => r.id !== id) : [];
  if (updatedChain.length === 0) {
    await deleteRepoFile(env, filePath, existingFile.sha, `oam(delete): ${namespace}/${key}`);
  } else {
    const envelope = {
      schema: CHAIN_SCHEMA,
      namespace,
      key,
      updated_at: nowIso,
      records: updatedChain,
    };
    await writeRepoFile(
      env,
      filePath,
      envelope,
      `oam(prune): ${namespace}/${key}`,
      existingFile.sha
    );
  }
  await syncRepoIndex(env, namespace, key, updatedChain, `oam(index): delete ${namespace}/${key}`);
  return { address: `oam://${namespace}/${key}`, remaining: updatedChain.length };
}

// ---------------------------------------------------------------------------
// Export Formatter: AGENTS.md
// ---------------------------------------------------------------------------

function renderAgentsMarkdown(records, opts = {}) {
  const lines = [
    "# AGENTS.md — OpenAgentMemory Context",
    "",
    `> Generated by OpenAgentMemory (\`${RECORD_SCHEMA}\`)`,
    `> As-of: \`${opts.asOf || new Date().toISOString()}\` · Records: **${records.length}**`,
    "",
  ];

  if (records.length === 0) {
    lines.push("_No active memories matched the export criteria._", "");
    return lines.join("\n");
  }

  const grouped = new Map();
  for (const r of records) {
    if (!grouped.has(r.namespace)) grouped.set(r.namespace, []);
    grouped.get(r.namespace).push(r);
  }

  const namespaces = Array.from(grouped.keys()).sort();
  for (const ns of namespaces) {
    const route = routeNamespace(ns);
    lines.push(`## \`${ns}\` (${route === "gist" ? "public/shared" : "private"})`, "");
    for (const r of grouped.get(ns)) {
      const metaParts = [
        `\`oam://${r.namespace}/${r.key}\``,
        `kind: \`${r.kind || "fact"}\``,
        `v${r.version || 1}`,
        `valid from: ${r.valid_from.slice(0, 10)}`,
      ];
      if (r.expires_at) metaParts.push(`expires: ${r.expires_at.slice(0, 10)}`);
      lines.push(`### ${r.title}`, "", `_${metaParts.join(" · ")}_`, "", r.content, "");
      if (Array.isArray(r.citations) && r.citations.length > 0) {
        lines.push("**Citations:**");
        for (const c of r.citations) {
          const label = c.label || c.uri;
          const excerpt = c.excerpt ? ` — "${c.excerpt}"` : "";
          lines.push(`- [${label}](${c.uri})${excerpt}`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Auth, Encoding & HTTP Utilities
// ---------------------------------------------------------------------------

function isAuthorized(request, env) {
  if (!env.OAM_API_TOKEN) return true;
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice(7).trim();
  return timingSafeEqual(token, String(env.OAM_API_TOKEN));
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
}

async function githubApiError(prefix, res) {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (body && body.message) detail = `${res.status}: ${body.message}`;
  } catch {
    // ignore parse error
  }
  let hint = "";
  if (res.status === 401) {
    hint = " — check GITHUB_TOKEN / REPO_TOKEN / GIST_TOKEN";
  } else if (res.status === 403) {
    const remaining = res.headers && res.headers.get("x-ratelimit-remaining");
    hint =
      remaining === "0"
        ? " — GitHub API rate limit exceeded"
        : " — verify token scope (Contents: Read & Write for repo, gist scope for Gist)";
  } else if (res.status === 404) {
    hint = " — verify GITHUB_REPO, GITHUB_BRANCH, or GIST_ID exists and token has access";
  } else if (res.status === 409) {
    hint = " — concurrent update conflict; retry request";
  }
  const err = new Error(`${prefix} (${detail}${hint})`);
  err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
  return err;
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function fromBase64Utf8(b64) {
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function buildCorsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
