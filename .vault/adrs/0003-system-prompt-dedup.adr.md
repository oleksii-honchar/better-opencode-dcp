---
type: adr
id: ADR-0003
title: "Session-Level Flag for System Prompt Deduplication"
status: accepted
createdAt: "2026-06-10T12:30:00Z"
updatedAt: "2026-06-10T12:30:00Z"
tags: [dcp, system-prompt, cache, kv-cache, dedup]
see_also:
  - "../concepts/0001-dynamic-context-pruning.concept.md"
  - "../specifications/0001-dcp-system-prompt-dedup.spec.md"
---

# ADR-0003: Session-Level Flag for System Prompt Deduplication

## Context

The DCP plugin's `createSystemPromptHandler` (lib/hooks.ts) appends its system prompt (compression instructions + extensions) to the last system message on **every request** without checking if the instructions are already present. This causes:

1. The system message changes on every turn (grows by appending duplicate instructions)
2. llama.cpp detects the prompt prefix change and invalidates the KV cache
3. Full prompt re-processing is forced on every turn — cache reuse is destroyed

The log shows: "forcing full prompt re-processing due to lack of cache data" with a token count mismatch (~108K cached vs ~55K new), confirming the system message modification directly triggers cache invalidation.

The user requires modification to happen only once per session.

## Decision

Use a `dcpPromptInjected: boolean` flag in `SessionState` to track whether the prompt has been injected, and skip injection on subsequent requests.

### Implementation

1. **`lib/state/types.ts`** — Add `dcpPromptInjected: boolean` to `SessionState` interface
2. **`lib/state/state.ts`** — Initialize `false` in `createSessionState()` and `resetSessionState()`
3. **`lib/hooks.ts`** — Wrap injection block in `if (!state.dcpPromptInjected) { ... }`, set flag `true` after injection

Additionally, `prompts.reload()` and `renderSystemPrompt()` are moved **inside** the guard to avoid unnecessary work on every turn.

### No Content-Based Fallback

A content-based fallback (`includes()`) is intentionally **not** added. Rationale:
- The flag is sufficient — it's set immediately after injection and persisted
- A content-based fallback would mask bugs in flag state management
- Simpler to reason about: one mechanism, not two

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| **Session-level flag (chosen)** | Guarantees one-time injection; follows existing pattern (`systemPromptTokens`, `modelContextLimit`) | Dynamic extensions won't update mid-session | — |
| **Content-based dedup (`includes()`)** | Self-healing; knows if prompt is present regardless of flag state | Would re-inject when dynamic extensions change (manual mode toggle, threshold notifications) | Re-injection defeats the purpose of cache stability |
| **Extension-aware re-injection** | Tracks last extension state, re-injects on change | Complex; marginal benefit over flag approach | Over-engineered for informational-only extensions |

## Consequences

- **Positive:** KV cache is stable after first injection — cache reuse works for the entire session
- **Positive:** Minimal change (~4 lines state + ~5 lines guard) — precisely follows the spec
- **Negative:** Dynamic extensions (manual mode toggle, below-threshold notification) won't update after first injection. Acceptable — extensions are informational only; base SYSTEM prompt covers core instructions.
- **Neutral:** Flag must be reset in `resetSessionState()` for session reuse (already done)
- **Neutral:** If state is lost (server restart), prompt re-injects on next request — correct behavior (new process = new KV cache anyway)
