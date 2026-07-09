---
type: adr
id: ADR-0005
title: Pre-API Validation in lowerToolCall() Functions
createdAt: 2026-07-09T09:50:00Z
updatedAt: 2026-07-09T09:50:00Z
tags:
  - validation
  - tool-calls
  - api
  - error-handling
see_also:
  - adrs/0004-dual-layer-tool-call-protection.adr.md
---

# ADR-0005: Pre-API Validation in lowerToolCall() Functions

## Context

After the dual-layer defense was implemented (ADR-0004), Layer 2 required a validation function to catch malformed tool call inputs before they reached the API. Without this validation, the compaction fix alone wouldn't catch future regressions where tool call arguments might be lost or corrupted through other code paths.

## Decision

Add `validateToolCallInput()` in `packages/llm/src/protocols/shared.ts` and call it from `lowerToolCall()` in both OpenAI protocol implementations:

**Validation function** (`packages/llm/src/protocols/shared.ts`):
```typescript
function validateToolCallInput(part): Effect.Effect<void, Error, never> {
  if (!part.input) return Effect.fail("Missing input");
  if (!part.id || !part.name) return Effect.fail("Missing id/name");
  if (typeof part.input === 'string' && part.input.trim() === '') return Effect.fail("Empty input");
  return Effect.succeed(void 0);
}
```

**Integration points**:
- `packages/llm/src/protocols/openai-chat.ts` — `lowerToolCall()` calls `validateToolCallInput()` before API dispatch
- `packages/llm/src/protocols/openai-responses.ts` — same pattern

**Error handling**:
- Structured logging: `Logger.error()` with validation failure details
- Return `Effect.fail` with `InvalidRequestReason` for proper error propagation

## Alternatives Considered

1. **No validation** — Rely solely on Layer 1 (compaction fix). Rejected: no safety net for future regressions.

2. **Schema validation in lowerToolCall** — Use Zod schemas to validate the entire tool call shape. Rejected: too heavy; only the input field is at risk, not the entire shape.

3. **Validation in lowerToolCall** (selected) — Lightweight, targeted validation of the input field. Chosen because it's focused, fast, and integrates cleanly with the Effect error model.

4. **Middleware validation** — Add validation as a middleware layer. Rejected: over-engineered for a single validation point.

## Consequences

- **Early detection**: Malformed tool calls are caught before API dispatch
- **Clear errors**: Structured logging and `InvalidRequestReason` provide actionable diagnostics
- **Minimal overhead**: Only checks the at-risk field (input), not the entire shape
- **Extensibility**: The `validateToolCallInput()` function can be extended with additional checks if needed
