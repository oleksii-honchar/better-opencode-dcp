---
type: memory
title: No part.state Null Guard in appendProtectedTools
createdAt: 2026-07-09T09:50:00Z
updatedAt: 2026-07-09T09:50:00Z
tags:
  - compaction
  - null-guard
  - gotcha
see_also:
  - adrs/0004-dual-layer-tool-call-protection.adr.md
---

# No part.state Null Guard in appendProtectedTools

**Fact:** `lib/compress/protected-content.ts` line 196 accesses `part.state.input` without guarding for null.

**Context:** During the dual-layer defense implementation (ADR-0004), the `appendProtectedTools()` function was updated to extract `part.state.input`. However, if `part.state` is null (e.g., a malformed tool part), accessing `.input` will throw a TypeError.

**Impact:** Low. In practice, tool parts with null `state` are rare and would likely indicate a deeper issue. However, the error message would be confusing — a TypeError from compaction rather than a clear validation error.

**Suggested fix:** Add optional chaining guard: `part.state?.input` with appropriate fallback logging if state is null.
