# Contributing to OpenAgentMemory (OAM)

Thank you for helping keep AI agent memory open, portable, and vendor-free. Before opening an issue or pull request, please review the core principles below.

---

## 1. Core Philosophy: Zero-Cost · No Credit Card · Zero-Build

OpenAgentMemory is designed so anyone can adopt, fork, host, and audit it forever without paying for SaaS infrastructure or fighting a JavaScript build pipeline:

1. **Zero paid dependencies & no credit card required:** Every default workflow must work with free, accessible tools—browser `localStorage`, free GitHub repositories, GitHub Pages, GitHub Gists, local files/SQLite, and free-tier serverless runtimes (such as Cloudflare Workers Free). Never require a paid API, hosted vector database, or credit-card-gated service for core features.
2. **Zero build tools in the core UI:** [`index.html`](./index.html) MUST remain a single, self-contained vanilla HTML/CSS/JavaScript file. Do **not** add `package.json`, `npm`, `node_modules`, React, TypeScript, Tailwind, Vite, or any bundler/transpiler step. Opening `index.html` via `file://` or GitHub Pages from `/ (root)` must always work immediately.
3. **Human-readable & Git-native:** Memories are plain UTF-8 JSON (`oam.record.v1`) and deterministic Markdown (`AGENTS.md`) that diff cleanly in Git and can be read without special tooling.

---

## 2. Namespace Privacy Boundaries (Non-Negotiable)

OAM enforces a **fail-closed** security boundary based on namespace prefixes (see [`SPEC.md` §6](./SPEC.md#6-namespace-routing-public-vs-private)):

| Namespace | Allowed Storage Class | Rule |
| :--- | :--- | :--- |
| `public`, `public/*` | Public/shared store (e.g., GitHub Gist) | Explicit allowlist only. |
| `shared`, `shared/*` | Shared store (e.g., GitHub Gist) | Explicit allowlist only. Intended for non-secret team conventions. |
| `private`, `private/*` | Private authenticated store (e.g., Private GitHub Repo, local disk/SQLite, private D1/KV) | Auth-gated reads and writes. |
| *Anything else* | Private authenticated store (**fail-closed default**) | Typos like `privte/keys` or `personal/notes` MUST NEVER fall through to public/shared storage. |

### Never Put Private Data in Secret Gists

> **Important Security Rule:** GitHub **"secret" Gists are NOT private.** A secret Gist is only *unlisted*—anyone who obtains or guesses the URL (via browser history, logs, referrers, or accidental paste) can read its full contents without authentication, and Gists lack repository-level access controls and audit trails.
>
> Adapters and pull requests MUST **never** route `private/*` (or unrecognized namespaces) to a secret or public GitHub Gist.

---

## 3. Adding a Storage Adapter Without Breaking `oam.record.v1`

We welcome reference adapters for **Cloudflare D1**, **Cloudflare KV**, **local SQLite**, **local JSON files**, and other zero-cost backends.

### Where Adapters Live

- Place standalone backend adapters under `adapters/` (e.g., `adapters/cloudflare-d1.js`, `adapters/cloudflare-kv.js`, `adapters/local-sqlite.mjs`) or propose an adapter first using the [New Storage Adapter Proposal](./.github/ISSUE_TEMPLATE/new-adapter.md) issue template.
- Keep each adapter self-contained, dependency-free (using native runtime APIs such as `fetch`, Web Crypto, Cloudflare bindings, or Node built-ins like `node:fs` / `node:sqlite`), and documented with a brief header comment or `README` section.

### Required Adapter Contract

Every adapter MUST preserve all `oam.record.v1` semantics losslessly:

1. **Preserve all fields verbatim:** Never drop `valid_from`, `valid_to`, `recorded_at`, `expires_at`, `version`, `supersedes`, `superseded_by`, `provenance`, `citations`, or custom `metadata`.
2. **Validate addresses strictly:** Reject `..`, leading/trailing `/`, empty segments, whitespace, or uppercase characters in `namespace` and `key`.
3. **Maintain append-only supersession chains:** Updating `(namespace, key)` MUST create a new record ID, increment `version`, set `new.supersedes = old.id`, and set `old.superseded_by = new.id` (optionally closing `old.valid_to = new.valid_from` when `old.valid_to === null`).
4. **Support bitemporal queries:** Filter accurately by `as_of` (`valid_from <= V < valid_to`), `recorded_as_of` (`recorded_at <= S`), `include_superseded`, and `include_expired` (`expires_at === null || expires_at > V`).
5. **Respect fail-closed routing:** If your adapter only handles private storage, document that clearly; if it routes multiple namespaces, use an explicit allowlist for `public/*` and `shared/*` and default everything else to private storage.
6. **Keep `index.html` lightweight:** Do not bloat `index.html` with backend-specific SDKs. Prefer exposing the standard HTTP API from [`SPEC.md` §9](./SPEC.md#9-reference-http-api-workerjs) so `index.html`'s existing Worker/HTTP client works with your adapter automatically.

---

## 4. Proposing Optional Schema Fields

`oam.record.v1` is intentionally minimal and stable.

- For application-specific attributes, prefer the open `metadata` object first.
- If a field benefits the entire ecosystem, open a [Schema Proposal](./.github/ISSUE_TEMPLATE/schema-proposal.md) issue.
- New fields in `v1` MUST be **optional**, **backward-compatible**, and safe for existing clients to ignore without breaking validation or exports.

---

## 5. Development & Pull Request Checklist

Before opening a pull request:

1. **Check syntax (no bundler needed):**
   ```bash
   node --check worker.js
   node --check examples/sync-agents-md.mjs
   ```
2. **Verify `index.html` works standalone:** Open `index.html` directly in a browser (and via a local static server like `python3 -m http.server 8000`) and confirm zero console errors, seeded `localStorage` loading, time-travel filtering, supersession, and `AGENTS.md` / JSON exports.
3. **Verify `oam.record.v1` compliance:** Test any new sample records with the interactive validator in `index.html` (**Spec Overview → Interactive Validator**) and verify `examples/sync-agents-md.mjs` runs cleanly against them.
4. **Keep diffs focused:** Submit one logical change per PR (one adapter, one UI improvement, or one spec clarification).
5. **Never commit secrets:** Keep `.env`, `.dev.vars`, and personal GitHub tokens out of commits.
