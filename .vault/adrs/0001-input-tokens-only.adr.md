---
type: adr
id: ADR-0001
title: "Use Input Tokens Only for Threshold Comparison"
status: accepted
createdAt: "2026-06-09T11:00:00Z"
updatedAt: "2026-06-09T11:00:00Z"
tags: [dcp, token-counting, threshold]
see_also: ["../concepts/0001-dynamic-context-pruning.concept.md"]
---

# ADR-0001: Use Input Tokens Only for Threshold Comparison

## Context

The DCP plugin's `getCurrentTokenUsage()` summed ALL token types (input + output + reasoning + cache), inflating the reported context size by ~20–25%. This caused compression to trigger ~20–25 percentage points below the configured 80% `minContextLimit` threshold. For a 128K context model, the model saw 62.5% actual usage but the plugin reported 85.9%, triggering compression at 62.5% real usage.

## Decision

`getCurrentTokenUsage()` returns only `tokens.input` — the actual input tokens occupying the context window. This aligns with how opencode itself calculates context tokens: `const contextTokens = inputTokens` (session.ts:429).

**Before (broken):**
```typescript
const input = assistantInfo.tokens?.input || 0
const output = assistantInfo.tokens?.output || 0
const reasoning = assistantInfo.tokens?.reasoning || 0
const cacheRead = assistantInfo.tokens?.cache?.read || 0
const cacheWrite = assistantInfo.tokens?.cache?.write || 0
return input + output + reasoning + cacheRead + cacheWrite
```

**After (fixed):**
```typescript
return assistantInfo.tokens?.input || 0
```

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Input tokens only (chosen) | Semantically correct, single-line change | None | — |
| Input + cache tokens | Cache tokens are "real" | Cache tokens don't occupy context window | Context window constraint is the concern |
| Return weighted total (input + 0.5 × output) | Accounts for some output impact | Arbitrary weighting, still incorrect | No principled basis for weighting |
| Add a separate function for context-window-only tokens | Backward compatible | Unnecessary complexity | Only one consumer (`isContextOverLimits`) |

## Consequences

- **Positive:** Threshold comparison is now apples-to-apples: 80% of context window vs. actual context window usage
- **Positive:** ~20–25 percentage points of false-positive triggers eliminated
- **Positive:** Aligns with opencode's own `contextTokens = inputTokens` convention
- **Positive:** Single-line change in `lib/token-utils.ts`, well-isolated (only used in `isContextOverLimits`)
