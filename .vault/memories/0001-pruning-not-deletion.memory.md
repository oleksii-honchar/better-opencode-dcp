---
type: memory
title: "DCP Pruning Does Not Delete Messages from Database"
createdAt: "2026-06-09T11:00:00Z"
updatedAt: "2026-06-09T11:00:00Z"
tags: [dcp, database, pruning, gotcha]
see_also: ["../concepts/0001-dynamic-context-pruning.concept.md"]
---

# Memory: DCP Pruning Does Not Delete Messages from Database

## Fact

When DCP compresses messages, the original messages are **NOT** deleted from the database. All pruning is an in-memory filter transformation applied in the `experimental.chat.messages.transform` hook.

## Context

Investigated during the Jun 9 session (260609-1053-dynamic-context-pruning-fork) to understand the actual pruning mechanism. Traced the flow from `compress` tool invocation through `applyCompressionState()` to `filterCompressedRanges()`.

### How it works:

1. `applyCompressionState()` (lib/compress/state.ts) registers a `CompressionBlock` with `summary` text and marks messages as having `activeBlockIds` — all in-memory state
2. On each LLM turn, `prune()` (lib/messages/prune.ts) → `filterCompressedRanges()` iterates the message array:
   - Messages with `activeBlockIds.length > 0` are **skipped** (not included in the filtered array)
   - At the anchor message point, a **synthetic user message** with the summary text is **injected**
3. The filtered array replaces the original in-place (`messages.length = 0; messages.push(...result)`)
4. The database is untouched — `SyncEvent.project(MessageV2.Event.Removed)` is never triggered by DCP

### Contrast with opencode's native compaction:

Opencode's compaction (session/compaction.ts) also does **NOT** delete messages. It creates a new assistant message with `mode: "compaction"` and `summary: true` containing the generated summary. Original messages remain in the database, tracked via a `hidden` set and `tail_start_id`.

### Database-level message deletion:

The only database-level message deletion happens via `SyncEvent.project(MessageV2.Event.Removed)` in projectors.ts — triggered by explicit removal events, never by DCP compression or native compaction.

## Impact

Decompression (`/dcp decompress`) works because the original messages are still in the database — they were only filtered from the in-memory pipeline. The DCP plugin is a pure transform layer with no database write side-effects.
