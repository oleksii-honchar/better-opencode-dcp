---
type: index
title: "Atomic Memories"
createdAt: "2026-06-09T10:00:00Z"
updatedAt: "2026-06-09T12:00:00Z"
tags: []
---

# Atomic Memories

Small, standalone facts, gotchas, and lessons learned from working with the DCP plugin.

## Nodes

- [[0001-pruning-not-deletion.memory.md]] — DCP pruning does not delete messages from the database (in-memory filter only)
- [[0002-dcp-native-compaction-reset.memory.md]] — DCP resets all state when opencode compacts natively (blocks, anchors, IDs lost)
- [[0003-per-turn-compression-config.memory.md]] — Config to nudge model toward compression on every turn (`minContextLimit: 0`, `nudgeFrequency: 1`, `nudgeForce: "strong"`)
