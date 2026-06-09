---
type: concept
title: "Dynamic Context Pruning"
createdAt: "2026-06-09T11:00:00Z"
updatedAt: "2026-06-09T11:30:00Z"
tags: [dcp, context, compression, plugin]
see_also: ["../adrs/0001-input-tokens-only.adr.md", "../adrs/0002-fork-dcp-plugin.adr.md", "../memories/0001-pruning-not-deletion.memory.md", "../memories/0002-dcp-native-compaction-reset.memory.md"]
---

# Concept: Dynamic Context Pruning

## What

DCP (opencode-dynamic-context-pruning) is a reactive, threshold-based context management plugin. It watches the conversation context and triggers compression when token thresholds are crossed, replacing raw conversation segments with model-generated technical summaries.

## Why

LLM context windows are finite (e.g., 128K tokens). Long agent sessions with tool outputs, code, and explorations fill the context window, degrading model performance. DCP compresses "closed" conversation sections into summaries to keep the context window manageable while preserving critical information.

## Key Details

### Architecture Flow

```
Token counting → Threshold eval (min/max) → Anchor state → Nudge injection → compress tool
```

### The Summary Overlay Mechanism

DCP does NOT remove messages from the database. On every request, `filterCompressedRanges()` (lib/messages/prune.ts) rewrites the in-memory message array:

1. **Walk the message array** — for each message:
2. **Check anchor** — is this message an anchor point for an active compression block? If yes → **inject synthetic user message** with the summary text right before it
3. **Check compression** — is this message covered by an active compression block? If yes → **skip it** (don't include in output)
4. **Pass through** — otherwise → include unchanged
5. **Replace** — `messages.length = 0; messages.push(...result)` — same array reference, filtered contents

### Synthetic Messages

After compression, the model sees a synthetic user message with:
- **Deterministic ID:** `msg_dcp_summary_{sha256("blockId:anchorMessageId")}` — prevents duplicates on repeated injections
- **Content format:**
  ```
  [Compressed conversation section]
  {model's summary text}

  <dcp-message-id>bN</dcp-message-id>
  ```
- **`<dcp-message-id>bN</dcp-message-id>` tags** serve as boundary markers — the model can reference `startId="b1"` in future compressions to start from a previous compression block

### Compression State

Compression blocks are tracked in `state.prune.messages`:

| Field | Purpose |
|-------|---------|
| `blocksById` | Map of block ID → CompressionBlock (summary, active status, consumedBlockIds) |
| `byMessageId` | Map of message ID → `{tokenCount, allBlockIds, activeBlockIds}` — which blocks cover this message |
| `activeByAnchorMessageId` | Map of anchor message ID → active block ID — where to inject the summary |
| `activeBlockIds` | Set of currently active block IDs |

The `anchorMessageId` determines **where** the summary injects (immediately before this message). The `byMessageId` map determines **what** gets skipped. These are independent — the anchor message itself might NOT be part of the compressed range.

### Block Stacking (consumedBlockIds)

When the model compresses a range that includes an earlier compression block (`startId="b1"`):

```
Block b2: compresses range b1 → m0005
  consumedBlockIds: [1]           ← b2 "consumes" b1's territory

applyCompressionState():
  b1.active = false               ← b1 deactivated
  b1.deactivatedByBlockId = 2     ← marked as consumed by b2
  activeByAnchorMessageId cleared for b1's anchor
  b2 becomes the active block
```

Result: only b2's summary appears in the conversation — b1 is subsumed. This prevents summary bloat while preserving the ability to consolidate multiple compressed sections.

### DCP ↔ Opencode Native Compaction Interaction

**Critical:** DCP and opencode's native compaction are complementary layers that interact via `checkSession()`.

`checkSession()` (lib/state/state.ts) scans for assistant messages with `summary: true` — the flag opencode's native compaction sets. When detected:

```typescript
const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
if (lastCompactionTimestamp > state.lastCompaction) {
    state.lastCompaction = lastCompactionTimestamp
    resetOnCompaction(state)  // ← clears ALL DCP state (anchors, blocks, prune, IDs)
}
```

`resetOnCompaction()` clears: tool parameters, prune tools/messages state, message IDs, and — critically — **all nudge anchors** (contextLimitAnchors, turnNudgeAnchors, iterationNudgeAnchors).

```
DCP (scalpel)                          Opencode Native (sledgehammer)
───────                                ─────────────────────────
Model voluntarily calls compress       isOverflow() → processor returns "compact"
Specific message ranges (startId→endId) Entire conversation (except tail)
Synthetic user message with summary    Assistant message with summary:true flag
Messages stay in DB, filtered in memory Entire session replaced with summary + tail
Triggers proactively (~80% threshold)   Triggers catastrophically at overflow
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

### Token Counting (Fixed in Fork)

The threshold comparison uses **only `tokens.input`** (the actual context window usage). Output, reasoning, and cache tokens are excluded — they don't occupy the context window. This aligns with opencode's own `contextTokens = inputTokens` convention.

### Compression Modes

- **`mode: "message"`** — Compress individual messages one at a time
- **`mode: "range"`** — Compress a range of messages as a batch

### Decompression

`/dcp decompress <n>` sets `block.active = false` and `block.deactivatedByUser = true`, restoring original messages from the database (they were never deleted, just filtered from the in-memory pipeline).
