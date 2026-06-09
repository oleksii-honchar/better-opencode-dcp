---
type: memory
title: "Per-Turn Compression Nudge Config"
createdAt: "2026-06-09T12:00:00Z"
updatedAt: "2026-06-09T12:00:00Z"
tags: [dcp, config, per-turn, nudge, compression]
see_also: ["../concepts/0001-dynamic-context-pruning.concept.md"]
---

# Memory: Per-Turn Compression Nudge Config

## Fact

DCP can be configured to nudge the model toward compression on every turn using existing configuration options. This creates per-turn compression behavior without code changes.

## Context

Researched during the Jun 9 session to determine whether per-turn compression (compress after each LLM stream finishes) is achievable with current configuration. Traced the full nudge injection flow in `lib/messages/inject/inject.ts` and `applyAnchoredNudges` in `lib/messages/inject/utils.ts`.

## Config

```json
{
  "compress": {
    "mode": "range",
    "minContextLimit": 0,
    "nudgeFrequency": 1,
    "iterationNudgeThreshold": 999,
    "nudgeForce": "strong"
  }
}
```

### How Each Option Works

| Option | Value | Effect |
|--------|-------|--------|
| `minContextLimit` | `0` | Every turn is "above threshold" → turn nudge system always enabled |
| `nudgeFrequency` | `1` | Nudge fires every fetch (every turn), not every Nth fetch |
| `nudgeForce` | `"strong"` | Turn nudge injects into **user messages** (visible at turn start), not assistant messages |
| `iterationNudgeThreshold` | `999` | Disables mid-turn iteration nudges (clean per-turn boundary only) |

### What Happens on Each Turn

1. User sends message
2. DCP `injectCompressNudges` runs → `overMinLimit=true` (minContextLimit=0) → turn nudge anchors set for last user + last assistant
3. `collectTurnNudgeAnchors` with `nudgeForce="strong"` targets user messages
4. Turn nudge text injects into the user message:
   > *"Evaluate the conversation for compressible ranges. If any messages are cleanly closed and unlikely to be needed again, use the compress tool on them. If direction has shifted, compress earlier ranges that are now less relevant."*
5. Model processes user message + nudge text
6. If closed sections exist, model calls `compress`

### With Low iterationNudgeThreshold (Alternative)

Setting `iterationNudgeThreshold: 1` fires iteration nudges DURING agent turns:
> *"You've been iterating for a while after the last user message. If there is a closed portion..., use the compress tool on it now."*

This is more aggressive but can be intrusive — the model sees compression prompts mid-reasoning. The threshold=999 variant is cleaner: compress only at turn boundaries.

## Limitations

| Limitation | Detail |
|-----------|--------|
| No auto-compression | DCP can only nudge — the model must voluntarily call the `compress` tool |
| Turn nudge timing | Fires on the **next user message**, not immediately after stream finishes |
| Nudge text assumes fork | Requires the fork's filled nudge prompts (upstream DCP has empty nudge text) |

## Impact

This config transforms DCP from a threshold-based emergency compressor into a per-turn context-maintenance tool. Instead of waiting for context to fill up (80%), the model is prompted to evaluate compression opportunities on every turn, preventing accumulation before it becomes a problem.
