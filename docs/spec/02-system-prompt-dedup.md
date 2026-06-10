# 02-system-prompt-dedup

## Summary

Add a `dcpPromptInjected: boolean` flag to `SessionState` to inject the DCP system prompt only once per session, preventing llama.cpp KV-cache invalidation caused by per-request system message modification.

## Problem

The DCP plugin's `createSystemPromptHandler` (`lib/hooks.ts`) appends its system prompt (compression instructions + extensions) to the last system message on **every request** without deduplication:

```typescript
// hooks.ts — line ~95 (before fix)
output.system[output.system.length - 1] += "\n\n" + newPrompt
```

This causes llama.cpp to detect a prefix change on every turn, invalidating the KV cache:

```
W slot update_slots: id 0 | task 2483 | forcing full prompt re-processing
  due to lack of cache data
W slot update_slots: id 0 | task 2483 | erased invalidated context checkpoint
  (pos_min = 108456, pos_max = 108456, n_tokens = 108457, ...)
```

The token count mismatch (~108K cached vs ~55K new) confirms the prompt changed.

### Impact

- **KV cache is 100% wasted** — every turn forces full prompt re-processing
- **Higher latency** on every request (no cache reuse)
- **Effect is independent of context size** — reproduces at 5K and 100K tokens
- **Not model-specific** — happens with any llama.cpp build using MTP or standard grammar

## Solution

### Design: Session-Level Boolean Flag

Add a `dcpPromptInjected` field to `SessionState`:

```typescript
// lib/state/types.ts
export interface SessionState {
    // ... existing fields ...
    dcpPromptInjected: boolean  // tracks whether DCP system prompt has been injected
}
```

**Why a flag, not a content check:** A session-level boolean guarantees one-time injection. A content check (`includes()`) would re-inject when dynamic extensions change (manual mode toggle, threshold notifications), defeating the purpose of cache stability.

### Code Changes

#### 1. State Extension (`lib/state/state.ts`)

```typescript
// createSessionState() — add:
dcpPromptInjected: false,

// resetSessionState() — add:
state.dcpPromptInjected = false
```

#### 2. Dedup Guard (`lib/hooks.ts`)

```typescript
// Inside createSystemPromptHandler, after existing early returns

if (!state.dcpPromptInjected) {
    prompts.reload()
    const runtimePrompts = prompts.getRuntimePrompts()
    const newPrompt = renderSystemPrompt(
        runtimePrompts,
        buildProtectedToolsExtension(config.compress.protectedTools),
        !!state.manualMode,
        state.isSubAgent && config.experimental.allowSubAgents,
        state.overMinLimit,
    )
    output.system[output.system.length - 1] += "\n\n" + newPrompt
    state.dcpPromptInjected = true
}
// Guard: if dcpPromptInjected is true, skip injection → system msg unchanged
```

The guard is placed **after** the existing early returns (internal agent check, permission deny) but wraps the entire injection block. `prompts.reload()` and `renderSystemPrompt()` are moved inside the guard to avoid unnecessary work.

### Edge Cases

| Edge case | Behavior |
|-----------|----------|
| Empty system array | Prompt pushed as new entry (`output.system.push(newPrompt)`) |
| Flag already `true` before handler | Early return — system unchanged (e.g., state restored from file) |
| `resetSessionState()` called | Flag cleared to `false` — next request re-injects |
| Server restart | State lost → flag defaults to `false` → prompt re-injects on first request (correct: new process = new KV cache) |
| Internal agent / permission deny | These early returns fire **before** the dedup guard — behavior unchanged |

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Dynamic extensions don't update mid-session | Low | Acceptable — extensions are informational bonuses; base SYSTEM prompt covers core instructions. User explicitly required one-time modification. |
| New session starts but flag not reset | Low | `resetSessionState()` clears flag. Also, `ensureSessionInitialized()` calls `resetSessionState()` when `sessionId` changes. |
| Flag not persisted across restarts | Low | Restart = new process = new KV cache anyway. Re-injection on first request is correct. |
| GBNF grammar parse failure still occurs | Medium | The grammar error (`E failed to parse grammar` with `"" until-suffix` rule) is a known llama.cpp issue (ggml-org/llama.cpp#13116) — independent of this fix. |

## Verification

- `dcpPromptInjected === false` on fresh `createSessionState()`
- `dcpPromptInjected === false` after `resetSessionState()`
- First call to handler: injects prompt, sets flag to `true`
- Second+ calls: early return, `output.system` unchanged
- Empty system array: prompt pushed as new entry
- Internal agent: still skips regardless of flag
- Permission deny: still skips regardless of flag
- Full lifecycle: inject → reset → inject again works

## References

- Session: 260610-1206-dcp-cache-invalidation
- Vault ADR: `adrs/0003-system-prompt-dedup.adr.md`
- Vault spec: `specifications/0001-dcp-system-prompt-dedup.spec.md`
- Vault memory: `memories/0004-dcp-cache-invalidation.memory.md`
- llama.cpp issue: [ggml-org/llama.cpp#13116](https://github.com/ggml-org/llama.cpp/issues/13116)
