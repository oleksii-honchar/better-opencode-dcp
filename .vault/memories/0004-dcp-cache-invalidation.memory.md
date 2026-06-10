---
type: memory
title: "DCP System Prompt Append Invalidates llama.cpp KV Cache"
createdAt: "2026-06-10T12:30:00Z"
updatedAt: "2026-06-10T12:30:00Z"
tags: [dcp, cache, kv-cache, llama.cpp, system-prompt, gotcha]
see_also:
  - "../adrs/0003-system-prompt-dedup.adr.md"
  - "../concepts/0001-dynamic-context-pruning.concept.md"
---

# Memory: DCP System Prompt Append Invalidates llama.cpp KV Cache

## Fact

The DCP plugin's `createSystemPromptHandler` (lib/hooks.ts) appends the DCP system prompt (compression instructions + extensions) to the last system message on **every request** without deduplication. This changes the prompt prefix on every turn, causing llama.cpp to detect a prefix mismatch and force full cache re-processing — destroying KV cache reuse entirely.

**Log signature:**
```
W slot update_slots: id 0 | task 2483 | forcing full prompt re-processing
  due to lack of cache data (likely due to SWA or hybrid/recurrent memory...)
W slot update_slots: id 0 | task 2483 | erased invalidated context checkpoint
  (pos_min = 108456, pos_max = 108456, n_tokens = 108457, ...)
```

The token count mismatch (~108K cached vs ~55K new) confirms the prompt structure changed significantly between turns.

## Context

Investigated and fixed in the Jun 10 session (260610-1206-dcp-cache-invalidation). The issue was reproduced with:
- **DCP plugin** connected to **better-opencode** fork
- **llama.cpp build:** ref `ad1b88ca0` (June 5, 2026, KleiAI hybrid scheduling)
- **Config:** config-9.yaml (Qwopus3.6-27B, MTP speculative decoding)
- Effect is independent of context size (reproduces at 5K and 100K tokens)

### How the invalidation happens:

1. `createSystemPromptHandler` runs on every opencode request
2. If not filtered by early returns (internal agent, permission deny), it appends:
   ```
   output.system[last] += "\n\n" + newPrompt
   ```
3. The system message changes length/content on every turn
4. llama.cpp uses the prompt prefix for KV cache lookup
5. Changed prefix → prefix mismatch → cache checkpoint erased → full reprocessing

### How it was fixed (ADR-0003):

A `dcpPromptInjected: boolean` flag in `SessionState` tracks whether injection has happened. On subsequent requests, the guard `if (!state.dcpPromptInjected) return` skips the append. The flag is set to `false` in `resetSessionState()`.

## Impact

- **Without fix:** KV cache is invalidated on every turn — 100% reprocessing overhead, negating prompt caching entirely
- **With fix:** KV cache is stable after first system prompt injection — cache hits on subsequent turns
- **Secondary issue (unrelated):** A GBNF grammar parse failure (`E failed to parse grammar`) may appear in logs independently. This is a known llama.cpp issue (ggml-org/llama.cpp#13116 — JSON schema with empty array generates un-parseable GBNF) and does not affect cache behavior.
