---
type: memory
title: "DCP Resets All State When Opencode Compacts Natively"
createdAt: "2026-06-09T11:30:00Z"
updatedAt: "2026-06-09T11:30:00Z"
tags: [dcp, opencode, compaction, state, gotcha]
see_also: ["../concepts/0001-dynamic-context-pruning.concept.md"]
---

# Memory: DCP Resets All State When Opencode Compacts Natively

## Fact

When opencode performs a native compaction (creating an assistant message with `summary: true`), DCP detects it and calls `resetOnCompaction(state)`, which clears **all** DCP internal state: compression blocks, nudge anchors, message IDs, and tool caches.

## Context

Detected during deep-dive analysis of the DCP compaction mechanism (Jun 9 session). The linkage is in `checkSession()` (lib/state/state.ts):

```typescript
const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
if (lastCompactionTimestamp > state.lastCompaction) {
    state.lastCompaction = lastCompactionTimestamp
    resetOnCompaction(state)  // clears blocks, anchors, prune state, message IDs
}
```

`findLastCompactionTimestamp` scans for assistant messages with `summary: true` — the exact flag set by opencode's native compaction.

`resetOnCompaction()` clears:
- `state.toolParameters` — all cached tool parameters
- `state.prune.tools` and `state.prune.messages` — all compression blocks and prune state
- `state.messageIds` — all message ID mappings (raw ID → ref)
- `state.nudges` — all contextLimitAnchors, turnNudgeAnchors, iterationNudgeAnchors

## Impact

- **After native compaction, DCP starts fresh** — all existing compression blocks are lost. The model cannot `/dcp decompress` previously compressed ranges
- **Anchors are cleared** — nudge anchors reset, so the nudge system restarts from scratch
- **Complementary design:** DCP is the scalpel (precise, model-controlled, range-level); opencode native is the sledgehammer (catastrophic, whole-session, overflow-driven). When the sledgehammer fires, the scalpel's work is erased
