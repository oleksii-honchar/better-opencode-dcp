---
type: specification
kind: refactor
title: "DCP System Prompt Deduplication"
status: completed
createdAt: "2026-06-10T12:30:00Z"
updatedAt: "2026-06-10T12:30:00Z"
tags: [dcp, system-prompt, cache, kv-cache, dedup]
see_also:
  - "../adrs/0003-system-prompt-dedup.adr.md"
  - "../concepts/0001-dynamic-context-pruning.concept.md"
  - "../memories/0004-dcp-cache-invalidation.memory.md"
---

# Specification: DCP System Prompt Deduplication

## Goal

Eliminate llama.cpp KV-cache invalidation caused by the DCP plugin appending its system prompt on every request, by injecting the system prompt only once per session.

## Root Cause

The DCP plugin's `createSystemPromptHandler` (lib/hooks.ts) appends compression instructions + extensions to the last system message on **every request** without deduplication. Changing the system message modifies the prompt prefix, causing llama.cpp to detect a prefix mismatch and force full cache re-processing.

## Architecture

### Before (Cache-Breaking)

```mermaid
sequenceDiagram
    participant OC as opencode
    participant DCP as DCP Plugin
    participant LLM as llama.cpp

    Note over DCP: Session start
    OC->>DCP: system.transform hook
    DCP->>DCP: Append SYSTEM prompt to last system msg
    DCP-->>OC: System msg modified
    OC->>LLM: Send prompt with new system msg
    LLM->>LLM: Cache new KV prefix
    Note over LLM: Turn 2
    OC->>DCP: system.transform hook
    DCP->>DCP: Append SYSTEM prompt AGAIN (+extensions)
    DCP-->>OC: System msg MODIFIED again
    OC->>LLM: Send prompt with changed system msg
    LLM->>LLM: ❌ Prefix mismatch — invalidate cache
```

### After (Cache-Preserving)

```mermaid
sequenceDiagram
    participant OC as opencode
    participant DCP as DCP Plugin
    participant LLM as llama.cpp

    Note over DCP: Session start, dcpPromptInjected = false
    OC->>DCP: system.transform hook
    DCP->>DCP: dcpPromptInjected? → false
    DCP->>DCP: Append SYSTEM prompt
    DCP->>DCP: dcpPromptInjected = true
    DCP-->>OC: System msg modified (first time)
    OC->>LLM: Send prompt → Cache KV prefix

    Note over LLM: Turn 2+
    OC->>DCP: system.transform hook
    DCP->>DCP: dcpPromptInjected? → true → SKIP
    DCP-->>OC: System msg UNCHANGED
    OC->>LLM: Send prompt with SAME system msg
    LLM->>LLM: ✅ Prefix matches — reuse cache
```

## Data Model

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dcpPromptInjected` | `boolean` | `false` | Whether DCP system prompt has been injected this session. Reset on `resetSessionState()`. |

## Implementation

### Phase 1: State Extension (lib/state/types.ts + lib/state/state.ts)

- Add `dcpPromptInjected: boolean` to `SessionState` interface
- Initialize `false` in `createSessionState()` and `resetSessionState()`

### Phase 2: Hook Dedup (lib/hooks.ts)

- After existing early returns (internal agent, permission deny), wrap injection block in `if (!state.dcpPromptInjected) { ... }`
- Move `prompts.reload()` and `renderSystemPrompt()` inside the guard
- Set `state.dcpPromptInjected = true` after injection

## Verification

- **Tests:** 111/111 pass (7 new tests covering full lifecycle)
- **TypeScript:** Clean compilation (`tsc --noEmit`)
- **Code review:** 100% spec compliance, 100% decision compliance

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Dynamic extensions don't update mid-session | User toggles manual mode but doesn't see manual extension in system prompt | Acceptable — extensions are informational bonuses |
| New session starts but flag not reset | DCP prompt never injected | `resetSessionState()` clears flag |
| Flag not persisted across restarts | Prompt re-injects on next request after restart | Acceptable — restart = new KV cache anyway |
