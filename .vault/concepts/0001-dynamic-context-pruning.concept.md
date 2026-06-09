---
type: concept
title: "Dynamic Context Pruning"
createdAt: "2026-06-09T11:00:00Z"
updatedAt: "2026-06-09T11:00:00Z"
tags: [dcp, context, compression, plugin]
see_also: ["../adrs/0001-input-tokens-only.adr.md", "../adrs/0002-fork-dcp-plugin.adr.md", "../memories/0001-pruning-not-deletion.memory.md"]
---

# Concept: Dynamic Context Pruning

## What

DCP (opencode-dynamic-context-pruning) is a reactive, threshold-based context management plugin. It watches the conversation context and triggers compression when token thresholds are crossed, replacing raw conversation segments with model-generated technical summaries.

## Why

LLM context windows are finite (e.g., 128K tokens). Long agent sessions with tool outputs, code, and explorations fill the context window, degrading model performance. DCP compresses "closed" conversation sections into summaries to keep the context window manageable while preserving critical information.

## Key Details

### Architecture Flow

```
Token counting → Threshold eval (min/max) → Anchor state → Nudge injection → Model sees: system prompt + nudges + compress tool
```

### Reactive (Post-Hoc) vs. Proactive (Pre-Hoc)

DCP operates **reactively** — data enters the context window first, then DCP compresses it:
```
Tool output → LLM context → Token count rises → DCP compress tool → Model writes summary
```

This contrasts with **proactive** approaches (e.g., context-mode) that intercept tool outputs before they reach the LLM:
```
Tool output → Interception layer → SQLite/FTS5 store → Compact reference injected
```

### No Physical Deletion

**Critical:** DCP does NOT physically remove messages from the database. All pruning is an in-memory transformation:
- `filterCompressedRanges()` (lib/messages/prune.ts) filters compressed messages from the in-memory message array
- A synthetic user message with the summary text is injected at the anchor point
- Original messages remain in the database and can be restored via `/dcp decompress`

### Token Counting (Fixed in Fork)

The threshold comparison uses **only `tokens.input`** (the actual context window usage). Output, reasoning, and cache tokens are excluded — they don't occupy the context window. This aligns with opencode's own `contextTokens = inputTokens` convention.

### Compression Modes

- **`mode: "message"`** — Compress individual messages one at a time
- **`mode: "range"`** — Compress a range of messages as a batch

### Compression State

Compression blocks are tracked in `state.prune.messages` with:
- `blocksById` — Map of block ID → CompressionBlock
- `byMessageId` — Map of message ID → activeBlockIds
- `activeByAnchorMessageId` — Anchor message ID → block ID (for summary injection)
- `activeBlockIds` — Set of currently active block IDs

### Decompression

`/dcp decompress <n>` sets `block.active = false` and `block.deactivatedByUser = true`, restoring original messages from the database (they were never deleted, just filtered from the in-memory pipeline).
