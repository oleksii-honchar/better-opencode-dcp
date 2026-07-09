---
type: adr
id: ADR-0004
title: Dual-Layer Defense for Tool Call Argument Preservation
createdAt: 2026-07-09T09:50:00Z
updatedAt: 2026-07-09T09:50:00Z
tags:
  - compaction
  - tool-calls
  - api-validation
  - safety
see_also:
  - adrs/0005-pre-api-validation-in-lowerToolCall.adr.md
  - specifications/0001-auto-save-tool-responses.spec.md
---

# ADR-0004: Dual-Layer Defense for Tool Call Argument Preservation

## Context

The agent-meta-tool Codex backend was dropping tool call arguments during message compaction, leading to runtime API errors. The root cause: during compression, `appendProtectedTools()` in `lib/compress/protected-content.ts` was only extracting tool call outputs, not arguments. When a compressed range included a tool call message, the `part.state.input` (arguments) was discarded. The API server then received a malformed request with missing `input[N].arguments`, producing errors like:

```
Missing required parameter: 'input[98].arguments'
```

This was particularly problematic because:
- The compaction pipeline was fundamentally sound for other message types
- Tool call arguments were silently lost without any validation
- No pre-API check caught the malformed request before it reached the server

## Decision

Implement a dual-layer defense strategy to protect tool call arguments:

**Layer 1 — Argument Protection during Compaction** (`lib/compress/protected-content.ts`):
- `appendProtectedTools()` now extracts `part.state.input` (arguments) alongside outputs during compaction
- Protected tool state is preserved as a structured object with both `input` and `output` fields
- The `part.state` field is fully restored from the protected state during message reconstruction

**Layer 2 — Pre-API Validation** (`packages/llm/src/protocols/shared.ts`):
- `validateToolCallInput()` function added to validate tool call arguments before API dispatch
- Called from `lowerToolCall()` in both `openai-chat.ts` and `openai-responses.ts`
- Validates: non-null input, required `id` and `name`, valid/non-empty JSON string for arguments
- On failure: structured logging via `Logger.error()` and `Effect.fail` with `InvalidRequestReason`

## Alternatives Considered

1. **Skip arguments during compaction** — Only preserve outputs, reconstruct arguments from context. Rejected: arguments are not reconstructable from outputs alone.

2. **Add only pre-API validation** — Don't fix compaction; just add validation to catch the error earlier. Rejected: doesn't address the root cause; still results in failed requests.

3. **Dual-layer defense** (selected) — Fix compaction AND add validation. Chosen because it addresses root cause (Layer 1) and provides a safety net (Layer 2) for future regressions.

4. **Disable compaction for tool call messages** — Exclude tool call messages from compaction entirely. Rejected: too aggressive; compaction is needed for large conversations and tool calls are a valid part of those conversations.

## Consequences

- **Root cause fixed**: Tool call arguments are now preserved during compaction
- **Safety net**: Pre-API validation catches any future regressions with clear error messages
- **Diagnostics**: Structured logging provides visibility into validation failures
- **Complexity**: Slight increase in code complexity, but modular and testable
- **Performance**: ⚠️ unverified — estimated ~1-2 microseconds per validation call, ~5-10 microseconds per compaction (from spec, not measured)
- **Test coverage**: Integration tests cover the full compaction pipeline with tool calls
