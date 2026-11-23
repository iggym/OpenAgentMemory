---
name: Schema Proposal (oam.record.v1)
about: Propose an optional field, semantic clarification, or backward-compatible extension to oam.record.v1
title: "[Schema]: "
labels: spec, enhancement
assignees: ''
---

## Proposal Summary

<!-- Summarize the proposed optional field or specification change in 1–3 sentences. -->

## Motivation & Use Case

<!-- What real agent memory workflow cannot be expressed cleanly today using existing oam.record.v1 fields or `metadata`? -->

## Proposed Field / Change

| Property | Value |
| :--- | :--- |
| **Field Name** | e.g., `scope` or `provenance.model` |
| **Type** | e.g., `string \| null` |
| **Requirement** | `OPTIONAL` (must remain backward-compatible with `oam.record.v1`) |
| **Default when omitted** | e.g., `null` |

### JSON Example

```json
{
  "schema": "oam.record.v1",
  "id": "oam_20261122_example1",
  "namespace": "private/preferences",
  "key": "example-key",
  "title": "Example record showing proposed field",
  "content": "...",
  "valid_from": "2026-11-22T00:00:00.000Z",
  "valid_to": null,
  "recorded_at": "2026-11-22T00:00:00.000Z",
  "expires_at": null,
  "superseded_by": null,
  "provenance": {
    "actor": "user:example",
    "source": "manual"
  }
}
```

## Compatibility & Edge Cases

- [ ] **Backward compatible:** Existing `oam.record.v1` records without this field remain valid.
- [ ] **Safe to ignore:** Clients and adapters that do not recognize this field can preserve and ignore it without breaking queries.
- **Interaction with bitemporal validity (`valid_from`, `valid_to`, `recorded_at`) & `expires_at`:**
- **Interaction with `superseded_by` versioning:** (e.g., carried forward on supersede or reset per version?)
- **Export behavior:** How (if at all) should this field appear in `AGENTS.md` and `oam.bundle.v1` JSON exports?

## Alternatives Considered

<!-- Could this live inside the existing `metadata` extension map instead? Why or why not? -->
