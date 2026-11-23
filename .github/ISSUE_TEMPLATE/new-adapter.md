---
name: New Storage Adapter Proposal
about: Propose a new storage adapter (e.g., Cloudflare D1, Cloudflare KV, local SQLite/JSON, S3-compatible) for OpenAgentMemory
title: "[Adapter]: "
labels: adapter, enhancement
assignees: ''
---

## Adapter Summary

<!-- Describe the proposed storage backend (e.g., Cloudflare D1, Cloudflare KV, local SQLite, local JSON file store). -->

- **Adapter Name:**
- **Target Runtime:** (e.g., Cloudflare Worker, Browser, Node.js CLI, Deno/Bun)
- **Target Namespaces:** (e.g., `private/*` only, `public/*` & `shared/*`, or full router)

## Zero-Cost & Zero-Build Alignment

OpenAgentMemory prioritizes zero paid dependencies, no credit-card requirements for core usage, and a dependency-free single-file UI (`index.html`).

- [ ] Works on a free tier or locally with **no credit card required**
- [ ] Does **not** introduce build tools, npm dependencies, or frameworks into `index.html`
- [ ] Requires no proprietary hosted vector DB or paid SaaS

<!-- Explain any free-tier limits, quota constraints, or local setup steps. -->

## Namespace Privacy & Fail-Closed Routing

- **How does this adapter enforce namespace boundaries?**
  - `public/*` and `shared/*` handling:
  - `private/*` and unrecognized namespace handling (must fail closed):
- [ ] Confirmed: `private/*` data is **never** written to a public or secret GitHub Gist or any unauthenticated/link-accessible store.

## `oam.record.v1` Compliance

Describe how the adapter stores and queries the full record model without lossy transformations:

- **Addressing (`oam://<namespace>/<key>`):**
- **Bitemporal queries (`valid_from`, `valid_to`, `recorded_at`):**
- **Immutable lineage (`supersedes`, `superseded_by`, `version`):**
- **Retention TTL (`expires_at`):**
- **Provenance & citations (`provenance`, `citations`):**
- **Atomic / concurrency behavior (e.g., SHA check, SQL transaction, CAS):**

## Minimal Example or Interface Sketch

```js
// Sketch the read/write interface or storage layout (tables, keys, or file paths)
```

## Testing & Verification Plan

<!-- How can maintainers verify this adapter locally without paid credentials? -->
