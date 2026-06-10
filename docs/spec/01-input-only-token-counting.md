# 01-input-only-token-counting

## Summary

Fix `getCurrentTokenUsage()` to return only `tokens.input` — the actual input tokens sent to the model — instead of summing all token types (input + output + reasoning + cache). This aligns with opencode's own context token calculation and resolves the primary root cause of premature compression.

## Problem

The DCP plugin's `getCurrentTokenUsage()` sums ALL token types:

```typescript
// lib/token-utils.ts:29-34
const input = assistantInfo.tokens?.input || 0
const output = assistantInfo.tokens?.output || 0
const reasoning = assistantInfo.tokens?.reasoning || 0
const cacheRead = assistantInfo.tokens?.cache?.read || 0
const cacheWrite = assistantInfo.tokens?.cache?.write || 0
return input + output + reasoning + cacheRead + cacheWrite
```

This inflates the reported context size by ~20-25%, causing compression to trigger well below the configured `minContextLimit` threshold.

### Impact

For a 128K context model with `minContextLimit: "80%"` (102.4K threshold):

| Metric | Value |
|--------|-------|
| Actual input tokens (context) | 80,000 (62.5%) |
| Output tokens | +15,000 |
| Reasoning tokens | +10,000 |
| Cache tokens | +5,000 |
| **Reported total** | **110,000 (85.9%)** → triggers compression at 62.5% actual usage |

## Solution

Use **only `tokens.input`** — the actual input tokens sent to the model — which is the same value opencode uses for its context tracking:

```typescript
// From opencode session.ts:429
const contextTokens = inputTokens
```

### Code Change

**File:** `lib/token-utils.ts`, lines 29-34

**Before:**
```typescript
const input = assistantInfo.tokens?.input || 0
const output = assistantInfo.tokens?.output || 0
const reasoning = assistantInfo.tokens?.reasoning || 0
const cacheRead = assistantInfo.tokens?.cache?.read || 0
const cacheWrite = assistantInfo.tokens?.cache?.write || 0
return input + output + reasoning + cacheRead + cacheWrite
```

**After:**
```typescript
return assistantInfo.tokens?.input || 0
```

### Why This Works

- `tokens.input` is the actual number of tokens in the model's context window — the input sent to the model.
- `tokens.output` is what the model generates — NOT in the context window.
- `tokens.reasoning` is internal reasoning — NOT in the context window.
- `tokens.cache.read` and `tokens.cache.write` are caching overhead — NOT in the context window.
- The `minContextLimit` / `maxContextLimit` are percentages of the model's context window — they should be compared against actual context usage, not an inflated total.

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Downstream consumers expect total tokens | Low | `getCurrentTokenUsage` is only used for threshold comparison in `isContextOverLimits` |
| Other code depends on the inflated total | Low | Grep confirms single usage in `isContextOverLimits` |
| Cache tokens should partially count | Very low | Cache tokens are not in the context window; they're optimized reads/writes |

## Verification

- `overMinLimit` should be `false` when actual input tokens are below the configured `minContextLimit`
- `overMinLimit` should be `true` when actual input tokens reach the configured `minContextLimit`
- No other code path should be affected by the change

## References

- Session: 260609-1053 dcp-token-counting-opencode-sessions
- Old session: 260515-1619-dcp-compress-below-80 (original investigation)
- Opencode: `packages/opencode/src/session/session.ts:429` — `const contextTokens = inputTokens`
- SDK: `packages/sdk/js/src/v2/gen/types.gen.ts:457` — `AssistantMessage.tokens` type
