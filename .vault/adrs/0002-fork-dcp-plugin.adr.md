---
type: adr
id: ADR-0002
title: "Fork DCP Plugin Instead of Patching Upstream"
status: accepted
createdAt: "2026-06-09T11:00:00Z"
updatedAt: "2026-06-09T11:00:00Z"
tags: [dcp, fork, upstream]
see_also: ["../concepts/0001-dynamic-context-pruning.concept.md", "0001-input-tokens-only.adr.md"]
---

# ADR-0002: Fork DCP Plugin Instead of Patching Upstream

## Context

The upstream DCP plugin (opencode-dynamic-context-pruning) had three defects causing premature compression: (1) token counting inflation, (2) empty nudge prompts, (3) unconditional system prompt guidance. The token counting bug alone caused compression to trigger ~20–25 percentage points below the intended threshold.

## Decision

Fork the upstream DCP repo as `better-opencode-dcp` (v3.1.12, branch `patched/main`) and apply fixes independently rather than waiting for upstream patches. The fork publishes under a separate npm scope, preserving AGPL-3.0 compliance.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|-------------|------|------|-------------|
| Fork DCP (chosen) | Immediate fix, full control | Fork drift, maintenance burden | Fastest path to working plugin |
| PR to upstream | Fixes benefit everyone | Upstream timeline uncertain | Blocking on upstream review cycle |
| Use context-mode instead | Proactive interception, no hallucination | Different workflow, requires SQLite | Doesn't replace DCP's threshold-based approach |

## Consequences

- **Positive:** Immediate fix available (Fix 1: input-only token counting)
- **Negative:** Must maintain fork long-term — upstream changes don't auto-merge
- **Negative:** Still reactive and abstractive (hallucination risk remains in model-generated summaries)
- **Neutral:** AGPL-3.0 compatible — legal fork with source available
