# OpenAgentMemory Specification (`oam.record.v1`)

**Version:** `1.0.0` (`oam.record.v1`)  
**Status:** Open Specification (MIT Licensed)  
**Design Goals:** Zero paid dependencies · Zero build tools · Plain JSON & Markdown · Bitemporal & Git-native

---

## 1. Overview

OpenAgentMemory (OAM) defines a minimal, portable, human-readable record format and routing convention for persistent AI agent memory. Instead of locking agent memory inside proprietary APIs or hosted vector databases, OAM stores memories as immutable, bitemporal JSON records (`oam.record.v1`) that can live in browser `localStorage`, a private GitHub repository, a GitHub Gist, or behind a thin stateless proxy such as a Cloudflare Worker.

Core invariants:

1. **Deterministic Addressing:** Every logical memory slot is addressed by `(namespace, key)` → `oam://<namespace>/<key>`.
2. **Bitemporal Truth:** Domain validity (`valid_from`, `valid_to`) is tracked independently from system recording time (`recorded_at`).
3. **Immutable Lineage:** Updates never silently destroy prior state; new versions link forward and backward via `supersedes` and `superseded_by`.
4. **Explicit Retention:** Hard expiration (`expires_at`) is separated from historical validity (`valid_to`).
5. **Verifiable Evidence:** Every memory carries structured `provenance` and optional `citations`.
6. **Fail-Closed Routing:** Only `public/*` and `shared/*` namespaces route to public/shared storage (e.g., GitHub Gist). `private/*` and all unknown namespaces MUST route to private storage.

---

## 2. Addressing: Namespaces & Keys

### 2.1 Canonical URI

A logical memory address is formatted as:

```text
oam://<namespace>/<key>
```

A specific immutable version may be addressed as:

```text
oam://<namespace>/<key>@<id>
```

### 2.2 Syntax Rules

- **`namespace`**: Lowercase, slash-delimited segments.
  - Pattern: `^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)*$`
  - Max length: `128` characters.
  - Recommended top-level prefixes: `public/...`, `shared/...`, `private/...`.
  - Examples: `public/architecture`, `shared/team/conventions`, `private/preferences`.
- **`key`**: Lowercase identifier unique within its namespace.
  - Pattern: `^[a-z0-9][a-z0-9._-]*$`
  - Max length: `128` characters.
  - Examples: `zero-dependencies`, `editor-formatting`, `q4-migration-freeze`.

### 2.3 Path-Traversal & Safety Rules

Implementations MUST reject any `namespace` or `key` that:

- Contains `..`, `.` as a standalone segment, backslashes (`\`), whitespace, uppercase letters, or ASCII control characters.
- Starts or ends with `/`.
- Contains empty segments (`//`).

---

## 3. Record Schema (`oam.record.v1`)

Every OAM record is a UTF-8 JSON object conforming to `oam.record.v1`.

### 3.1 Field Reference

| Field | Type | Req. | Description |
| :--- | :--- | :--- | :--- |
| `schema` | `string` | REQUIRED | Must be `"oam.record.v1"`. |
| `id` | `string` | REQUIRED | Globally unique immutable record ID (e.g. `oam_<timestamp>_<random>` or UUID/ULID). |
| `namespace` | `string` | REQUIRED | Hierarchical namespace (`public/*`, `shared/*`, `private/*`, etc.). |
| `key` | `string` | REQUIRED | Logical memory key within `namespace`. |
| `title` | `string` | REQUIRED | Concise human-readable title (recommended ≤ 120 chars). |
| `content` | `string` | REQUIRED | Memory payload in plain text or Markdown. |
| `kind` | `string` | OPTIONAL | Semantic category. Recommended values: `"fact"`, `"preference"`, `"decision"`, `"procedure"`, `"context"`, `"constraint"`. Default: `"fact"`. |
| `tags` | `string[]` | OPTIONAL | Lowercase keyword tags for filtering. Default: `[]`. |
| `confidence` | `number` | OPTIONAL | Certainty score in `[0.0, 1.0]`. Default: `1.0`. |
| `valid_from` | `string` | REQUIRED | ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`) when the claim became true in domain time. |
| `valid_to` | `string \| null` | REQUIRED | ISO-8601 UTC timestamp when the claim ceased to be true in domain time, or `null` if open-ended. |
| `recorded_at` | `string` | REQUIRED | ISO-8601 UTC timestamp when this record version was written (system / transaction time). |
| `expires_at` | `string \| null` | OPTIONAL | ISO-8601 UTC timestamp after which this record is excluded from active recall and eligible for pruning, or `null` for no expiration. |
| `version` | `integer` | OPTIONAL | Positive monotonically increasing version number within `(namespace, key)` starting at `1`. |
| `supersedes` | `string \| null` | OPTIONAL | `id` of the immediately preceding version replaced by this record, or `null` for version `1`. |
| `superseded_by` | `string \| null` | REQUIRED | `id` of the newer version that replaced this record, or `null` if this record is the current head. |
| `provenance` | `object` | REQUIRED | Origin metadata describing who/what created the record and how (see §3.2). |
| `citations` | `object[]` | OPTIONAL | Supporting evidence links, commits, docs, or quotes (see §3.3). Default: `[]`. |
| `metadata` | `object` | OPTIONAL | Free-form extension object for custom client fields without violating `oam.record.v1`. |

### 3.2 `provenance` Object

| Field | Type | Req. | Description |
| :--- | :--- | :--- | :--- |
| `actor` | `string` | REQUIRED | Principal that authored or extracted the memory (e.g. `"user:alex"`, `"agent:claude-code"`, `"system:seed"`). |
| `source` | `string` | REQUIRED | Origin channel (e.g. `"manual"`, `"conversation"`, `"pr-review"`, `"adr"`, `"import"`). |
| `method` | `string` | OPTIONAL | Acquisition mode: `"explicit"`, `"inferred"`, `"consolidated"`, `"imported"`. Default: `"explicit"`. |
| `trust` | `string` | OPTIONAL | Verification level: `"verified"`, `"unverified"`, `"derived"`. Default: `"verified"`. |
| `session_id` | `string \| null` | OPTIONAL | Optional conversation, run, or commit identifier. |

### 3.3 `citations` Array Items

| Field | Type | Req. | Description |
| :--- | :--- | :--- | :--- |
| `uri` | `string` | REQUIRED | Reference URI (HTTPS URL, repo path, commit SHA, or `oam://` address). |
| `label` | `string` | OPTIONAL | Short display label for the citation. |
| `excerpt` | `string` | OPTIONAL | Brief verbatim quote or note from the source. |
| `accessed_at` | `string` | OPTIONAL | ISO-8601 UTC timestamp when the cited resource was observed. |

### 3.4 Complete Example Record

```json
{
  "schema": "oam.record.v1",
  "id": "oam_20261122_a9f3c1e2",
  "namespace": "public/architecture",
  "key": "zero-build-frontend",
  "title": "Frontend stays single-file vanilla HTML/CSS/JS",
  "content": "Ship the web console as a single self-contained index.html with zero npm dependencies, zero bundlers, and zero frameworks so it deploys straight from the repo root on GitHub Pages.",
  "kind": "decision",
  "tags": ["architecture", "frontend", "github-pages"],
  "confidence": 1.0,
  "valid_from": "2026-01-15T00:00:00.000Z",
  "valid_to": null,
  "recorded_at": "2026-01-15T14:22:00.000Z",
  "expires_at": null,
  "version": 1,
  "supersedes": null,
  "superseded_by": null,
  "provenance": {
    "actor": "user:maintainer",
    "source": "adr",
    "method": "explicit",
    "trust": "verified",
    "session_id": "adr-001"
  },
  "citations": [
    {
      "uri": "https://docs.github.com/en/pages",
      "label": "GitHub Pages Root Deployment",
      "excerpt": "Publish directly from the root folder of a branch without build actions.",
      "accessed_at": "2026-01-15T14:20:00.000Z"
    }
  ]
}
```

---

## 4. Bitemporal Validity & Expiration

OAM tracks **three distinct timestamps** to avoid conflating history, auditing, and cache expiration:

```text
Domain Reality (Valid Time)      :  valid_from  ──────────────────────►  valid_to (or ∞)
System Knowledge (System Time)   :         recorded_at ───────────────►  (immutable audit)
Retention Policy (TTL)           :  ──────────────────────────────────►  expires_at (prune/hide)
```

### 4.1 Semantic Distinction

- **`valid_from` / `valid_to` (Valid Time):** Half-open interval `[valid_from, valid_to)`.
  - Answers: *"Was this statement true in the real world at time `V`?"*
  - Example: *"Production ran PostgreSQL 14 from 2024-03-01 until 2025-10-01."* Setting `valid_to` preserves historical truth for audits and postmortems.
- **`recorded_at` (Transaction / System Time):**
  - Answers: *"When did the memory store first record this exact assertion?"*
  - Enables point-in-time debugging (*"What did the agent believe on Tuesday?"*).
- **`expires_at` (Retention TTL):**
  - Answers: *"Should this memory still be surfaced in active recall?"*
  - Example: *"Deployment freeze until Friday 18:00 UTC."* Once `now >= expires_at`, the record is excluded from default recall and `AGENTS.md` exports, and MAY be garbage-collected by maintenance jobs.

### 4.2 Query Evaluation Rules

Given a query with valid-time instant `V` (default: `now`), optional system-time instant `S` (default: `now`), `include_superseded` (default: `false`), and `include_expired` (default: `false`), a record `r` matches iff:

1. **System time:** `Date.parse(r.recorded_at) <= S`
2. **Supersession:** `include_superseded === true` OR `r.superseded_by === null` (or, for historical system-time travel at `S`, the superseding record was recorded strictly after `S`)
3. **Expiration:** `include_expired === true` OR `r.expires_at === null` OR `Date.parse(r.expires_at) > V`
4. **Domain validity:** `Date.parse(r.valid_from) <= V` AND (`r.valid_to === null` OR `V < Date.parse(r.valid_to)`)

Invariant: If `valid_to !== null`, `Date.parse(valid_to) >= Date.parse(valid_from)` MUST hold.

---

## 5. Versioning & `superseded_by` Protocol

Records in OAM are append-only by convention. Modifying a memory at `(namespace, key)` creates a new record version and links the chain:

```text
[ v1: id="oam_1" ]  ──superseded_by──►  [ v2: id="oam_2" ]  ──superseded_by──►  [ v3: id="oam_3" ]
  superseded_by: "oam_2"                  superseded_by: "oam_3"                  superseded_by: null (HEAD)
  supersedes: null                        supersedes: "oam_1"                     supersedes: "oam_2"
```

### 5.1 Supersession Procedure

When writing a new record `r_new` for an existing `(namespace, key)` with current head `r_old`:

1. Set `r_new.id` to a fresh unique identifier.
2. Set `r_new.version = (r_old.version || 1) + 1`.
3. Set `r_new.supersedes = r_old.id`.
4. Set `r_new.superseded_by = null`.
5. Set `r_new.recorded_at = now_utc()`.
6. Update `r_old.superseded_by = r_new.id`.
7. **Closing `r_old.valid_to`:**
   - **Fact Evolution (default):** If the underlying world changed and `r_old.valid_to === null`, set `r_old.valid_to = r_new.valid_from` (clamped so `r_old.valid_to >= r_old.valid_from`). Time-travel queries before `r_new.valid_from` will accurately recall `r_old`.
   - **Retroactive Correction:** If `r_old` was factually erroneous, clients MAY leave `r_old.valid_to` closed or equal to `r_old.valid_from` so `r_new` governs the full corrected interval.

### 5.2 Retraction & Expiration

- **Soft expire:** Set `expires_at` to `now_utc()` (or supersede with an expired/closed record) to preserve auditability.
- **Hard delete:** Permanently removes the record or chain (intended for accidental secret leakage or GDPR/erasure requests).

---

## 6. Namespace Routing (`public/*` vs `private/*`)

OAM separates storage trust boundaries strictly by namespace prefix.

### 6.1 Routing Table

| Namespace Pattern | Route Target | Intended Visibility | Example Reference Backend |
| :--- | :--- | :--- | :--- |
| `public` or `public/*` | `gist` (Public/Shared Store) | Publicly readable; auth-gated writes | GitHub Gist |
| `shared` or `shared/*` | `gist` (Public/Shared Store) | Shared across collaborators/agents via URL or token | GitHub Gist (unlisted/secret) |
| `private` or `private/*` | `repo` (Private Store) | Strictly private; auth-gated reads & writes | Private GitHub Repository |
| *Any other namespace* | `repo` (**Fail-Closed Default**) | Strictly private | Private GitHub Repository |

### 6.2 Fail-Closed Security Invariant

Routing MUST use an **explicit allowlist** for public/shared backends:

```js
function routeNamespace(namespace) {
  if (
    namespace === "public" ||
    namespace.startsWith("public/") ||
    namespace === "shared" ||
    namespace.startsWith("shared/")
  ) {
    return "gist";
  }
  return "repo"; // Fail-closed: private/* and any unknown namespace stay private
}
```

A typo such as `privte/tokens` or `personal/notes` MUST NEVER fall through to a public Gist.

---

## 7. Storage Layout Conventions

### 7.1 Private GitHub Repository Layout

To keep diffs clean while allowing single-request reads:

```text
memories/
├── index.json                              # Consolidated index (oam.index.v1) for O(1) reads
├── private/
│   ├── preferences/
│   │   └── agent-tone.json                 # Version chain (oam.chain.v1) for private/preferences/agent-tone
│   └── context/
│       └── q4-migration-freeze.json
└── custom/
    └── ...
```

Each per-key file (`memories/<namespace>/<key>.json`) uses the `oam.chain.v1` envelope:

```json
{
  "schema": "oam.chain.v1",
  "namespace": "private/preferences",
  "key": "agent-tone",
  "updated_at": "2026-11-22T12:00:00.000Z",
  "records": [ /* oam.record.v1[] ordered oldest → newest */ ]
}
```

The consolidated index (`memories/index.json`) uses `oam.index.v1`:

```json
{
  "schema": "oam.index.v1",
  "updated_at": "2026-11-22T12:00:00.000Z",
  "records": [ /* flat array of all oam.record.v1 records in this repo */ ]
}
```

### 7.2 GitHub Gist Layout

Because GitHub Gist filenames cannot contain `/`, each `(namespace, key)` chain is stored as a flat file:

```text
oam__<namespace with "/" replaced by "__">--<key>.json
```

Example: `public/architecture` + `zero-build-frontend` → `oam__public__architecture--zero-build-frontend.json`.

Each Gist file stores the exact same `oam.chain.v1` JSON structure. A single `GET /gists/{gist_id}` fetches all `public/*` and `shared/*` records in one round trip.

### 7.3 Browser `localStorage` Layout

For instant zero-account usage, clients store the full `oam.record.v1[]` array under key `oam.records.v1` in `window.localStorage`.

---

## 8. Export Formats

### 8.1 `AGENTS.md` (Markdown Export)

`AGENTS.md` is a deterministic Markdown projection of active, valid, non-expired memories designed for direct consumption by coding agents:

- Grouped alphabetically by `namespace`.
- Each record renders its `title`, canonical `oam://<namespace>/<key>` address, `kind`, `valid_from` (and `expires_at` if set), `content`, and formatted `citations`.
- Superseded and expired records are omitted by default so agent context stays compact and accurate.

### 8.2 JSON Bundle (`oam.bundle.v1`)

Portable archive format for backup, migration, or import:

```json
{
  "schema": "oam.bundle.v1",
  "record_schema": "oam.record.v1",
  "exported_at": "2026-11-22T12:00:00.000Z",
  "count": 6,
  "records": [ /* oam.record.v1[] */ ]
}
```

---

## 9. Reference HTTP API (`worker.js`)

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Public | Returns service status, schema version, and backend availability. |
| `GET` | `/records` | Token for `private/*` & `shared/*` | Query records (`?namespace=&key=&as_of=&recorded_as_of=&include_superseded=&include_expired=&q=`). |
| `GET` | `/record` | Token for `private/*` & `shared/*` | Fetch full version chain for `?namespace=<ns>&key=<key>`. |
| `POST` | `/records` | Bearer Token | Validate and persist a new `oam.record.v1` (auto-supersedes existing head for the same `namespace`/`key`). |
| `PUT` | `/records` | Bearer Token | Alias for `POST /records`. |
| `DELETE` | `/records` | Bearer Token | Soft-expire (`mode=expire`, default) or hard-delete (`mode=hard`) by `?namespace=&key=&id=`. |
| `GET` | `/export/agents.md` | Token if private included | Returns `text/markdown` `AGENTS.md` projection. |
| `GET` | `/export/json` | Token if private included | Returns `application/json` `oam.bundle.v1` export. |

Authentication uses `Authorization: Bearer <OAM_API_TOKEN>`. When `OAM_API_TOKEN` is configured, unauthenticated `GET /records` requests ONLY return `public/*` records and never read or expose `private/*` or `shared/*`.
