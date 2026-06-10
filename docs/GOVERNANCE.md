# better-opencode-dcp Governance

This document defines the governance procedures for maintaining the `better-opencode-dcp` fork — the four fixes applied, how the fork integrates with `better-opencode`'s dev server, how to sync with upstream, build, and test.

**Fork location:** `~/www/misc/better-opencode-dcp`  
**Branch:** `patched/main` (v3.1.12 base)  
**Origin:** `git@github.com:oleksii-honchar/better-opencode-dcp.git`  
**Upstream:** `git@github.com:Tarquinen/opencode-dynamic-context-pruning.git`

---

## Fork Overview

The DCP (Dynamic Context Pruning) plugin (`@tarquinen/opencode-dcp`) helps manage context window usage by nudging the model to compress closed conversation sections. The upstream plugin has a bug where it **triggers compression below the configured `minContextLimit` threshold** because it sums ALL token types (input + output + reasoning + cache) instead of just input tokens.

This fork applies **four fixes** across two domains:
- **Fixes 1–3:** Correct token counting, input budget calculation, and system prompt behavior so compression only fires when context usage actually exceeds the configured thresholds.
- **Fix 4:** Prevent KV-cache invalidation by injecting the DCP system prompt only once per session.

### Branch Structure

```
                     upstream/Tarquinen/opencode-dynamic-context-pruning
                     ┌──────────────────────────────────────────┐
                     │  master (v3.1.12)                        │◀── upstream release
                     └──────────────────────────────────────────┘
                               │
                               │ fork
                               ▼
                oleksii-honchar/better-opencode-dcp (origin)
                ┌──────────────────────────────────────────────┐
                │  master (mirrors upstream/master)             │◀── kept current
                │  patched/main (working branch)                │◀── 4 fixes applied
                └──────────────────────────────────────────────┘
```

**Key rules:**
- **`master`** — Mirrors upstream/master. Updated via periodic sync.
- **`patched/main`** — Working branch containing the 3 fixes plus upstream base.
- **`origin`** — Your fork on GitHub (push target).
- **`upstream`** — Original Tarquinen repo (read-only, never push).

---

## The Four Fixes

### Fix 1: Input-Only Token Counting

**Files:** `lib/token-utils.ts`  
**Status:** ✅ Applied

**Problem:** `getCurrentTokenUsage()` summed ALL token types (input + output + reasoning + cache read + cache write), inflating the reported context size by ~20-25%. For a 128K context model with 80K input tokens, the function would return ~110K (85.9% of 128K), triggering compression even though actual context usage was only 62.5%.

**Fix:** Return only `assistantInfo.tokens?.input || 0` — the actual input tokens sent to the model. This aligns with how opencode core calculates `contextTokens` (`session.ts:429: const contextTokens = inputTokens`).

```typescript
// Before: input + output + reasoning + cacheRead + cacheWrite
// After:
return assistantInfo.tokens?.input || 0
```

**Tests:** `tests/token-utils.test.ts` (3 tests: input-only, no-tokens, compaction)

---

### Fix 2: Input Budget Calculation

**Files:** `lib/input-budget.ts` (NEW), `lib/hooks.ts`  
**Status:** ✅ Applied

**Problem:** Percentage thresholds (`maxContextLimit`, `minContextLimit`) were calculated against the full `limit.context` value instead of the safe input budget. For shared-pool models (Anthropic, GPT-4o, Gemini, Grok), `input + output` must not exceed `limit.context`. Using the full context as the base inflated the threshold and delayed nudges for split-budget models (OpenAI GPT-5 line) that define `limit.input` separately.

**Fix:** Create `computeInputBudget()` that returns the safe input token budget:

```typescript
export function computeInputBudget(limit: {
    context: number
    input?: number
    output?: number
}): number {
    if (!limit.context) return 0
    return limit.input ?? Math.max(0, limit.context - (limit.output ?? 0))
}
```

Then use it in `lib/hooks.ts`:

```typescript
// Before:
state.modelContextLimit = input.model.limit.context

// After:
state.modelContextLimit = computeInputBudget(input.model.limit)
```

**Tests:** `tests/input-budget.test.ts` (9 tests covering shared-pool, split-budget, zero context, missing output, output exceeds context)

---

### Fix 3: Threshold-Aware System Prompt

**Files:**
- `lib/prompts/extensions/system-below-threshold.ts` (NEW)
- `lib/prompts/index.ts`
- `lib/prompts/store.ts`
- `lib/state/types.ts`
- `lib/state/state.ts`
- `lib/hooks.ts`

**Status:** ✅ Applied

**Problem:** The DCP system prompt unconditionally tells the model to "compress when sections are closed," giving the model permission to compress at any context level — even when usage is well below the configured thresholds.

**Fix:** Add a conditional extension to the system prompt that tempers the compression guidance when context usage is below `minContextLimit`:

```
Context usage is currently below the configured threshold.
You may compress if a section is clearly closed, but prioritize
keeping raw context available for active work.
```

The `overMinLimit` boolean is computed during `createChatMessageTransformHandler`, cached on `SessionState`, and read by `createSystemPromptHandler` when rendering the system prompt.

**Tests:** `tests/prompts.test.ts` (4 tests verifying extension presence/absence based on `overMinLimit`)

---

### Fix 4: System Prompt Deduplication (Session-Level Flag)

**Files:**
- `lib/state/types.ts`
- `lib/state/state.ts`
- `lib/hooks.ts`

**Status:** ✅ Applied

**Problem:** The DCP plugin's `createSystemPromptHandler` appends the DCP system prompt to the last system message on **every request**, modifying the prompt prefix. llama.cpp detects the prefix change and invalidates its KV cache, forcing full prompt re-processing on every turn. Cache reuse is destroyed.

**Fix:** Add a `dcpPromptInjected: boolean` flag to `SessionState`:

```typescript
// lib/hooks.ts — guard inside createSystemPromptHandler
if (!state.dcpPromptInjected) {
    prompts.reload()
    const runtimePrompts = prompts.getRuntimePrompts()
    const newPrompt = renderSystemPrompt(/* ... */)
    output.system[output.system.length - 1] += "\n\n" + newPrompt
    state.dcpPromptInjected = true  // first and only injection
}
// Subsequent calls: flag is true → early return → system msg unchanged → cache HIT
```

**Log signature of the problem:**
```
W slot update_slots: id 0 | task 2483 | forcing full prompt re-processing
W slot update_slots: id 0 | task 2483 | erased invalidated context checkpoint
  (pos_min = 108456, pos_max = 108456, n_tokens = 108457, ...)
```

With the fix, the log shows cache hits on turn 2+ (no "forcing full prompt re-processing" warning).

**Design rationale:**
- Flag-based (not content-based) guarantees one-time injection — dynamic extensions that change mid-session won't trigger re-injection
- Reset in `resetSessionState()` for clean session lifecycle
- `prompts.reload()` and `renderSystemPrompt()` moved inside the guard to avoid unnecessary work

**Tests:** `tests/hooks-permission.test.ts` (7 new tests: flag default, reset, guard skips, empty system array, flag already true, lifecycle inject→reset→inject, internal agent still skips)

---

## Integration with better-opencode Dev Server

The fork is configured as a local plugin for the `better-opencode` dev server:

### Config (`~/.config/opencode/opencode.jsonc:538`)

```jsonc
"plugin": [
    "@devtheops/opencode-plugin-otel",
    "file:///Users/oleksii.honchar/www/misc/better-opencode-dcp",
    "./plugins/rules-inject.ts"
]
```

The `file://` URL tells opencode to load the plugin from the local directory instead of the published npm package. The plugin loader:
1. Detects it as a path spec via `isPathPluginSpec()`
2. Resolves the directory (which has `package.json`) → returns directory URL
3. Reads `package.json` → finds `"main": "./dist/index.js"` → resolves to `dist/index.js`

### Dev Server Auto-Build (`scripts/start-dev.sh`)

The `start-dev.sh` script in `better-opencode` includes an auto-build hook that builds the DCP fork before starting the dev server:

```bash
DCP_DIR="${DCP_DIR:-$HOME/www/misc/better-opencode-dcp}"
if [ -d "$DCP_DIR" ] && [ -f "$DCP_DIR/package.json" ]; then
  echo "  Building local DCP plugin fork ($DCP_DIR)..."
  (cd "$DCP_DIR" && npm run build 2>&1 | sed 's/^/    /')
  echo "  DCP plugin fork built."
fi
```

This ensures `dist/` is always up-to-date when starting the dev server. Override with `DCP_DIR=/path/to/dcp`.

### How the Data Flow Works

```
start-dev.sh
  │
  ├── Build DCP fork (npm run build)
  │     └── dist/index.js ←── includes all 3 fixes
  │
  └── Start opencode server (bun run src/index.ts)
        │
        └── Load config → ~/.config/opencode/opencode.jsonc
              │
              └── Resolve "file:///Users/.../better-opencode-dcp"
                    │
                    └── Read package.json → main: ./dist/index.js
                          │
                          └── Load plugin with 3 fixes active
```

---

## Building and Testing

### Build the Fork

```bash
cd ~/www/misc/better-opencode-dcp
npm run build
```

This runs `tsup` + `tsc --emitDeclarationOnly`. Output goes to `dist/`.

### Run Tests

```bash
cd ~/www/misc/better-opencode-dcp
npm test
```

Uses `node --import tsx --test tests/*.test.ts`. Currently **111 tests** (0 failures).

### Typecheck

```bash
cd ~/www/misc/better-opencode-dcp
npm run typecheck
```

### Verify All Changes

```bash
cd ~/www/misc/better-opencode-dcp
npm run typecheck && npm test && echo "All good ✓"
```

---

## Syncing with Upstream

When the upstream Tarquinen repo releases a new version, rebase `patched/main` onto the new upstream/master:

```bash
cd ~/www/misc/better-opencode-dcp

# 1. Fetch latest from both remotes
git fetch upstream master --quiet
git fetch origin --quiet

# 2. Check divergence
git log --oneline patched/main..upstream/master | wc -l  # commits behind
git log --oneline upstream/master..patched/main | wc -l  # commits ahead (should be 3+)

# 3. Rebase patched/main onto upstream/master
git checkout patched/main
git rebase upstream/master

# 4. Resolve conflicts if they occur
#    - Our 3 fixes are in: lib/token-utils.ts, lib/input-budget.ts, lib/hooks.ts,
#      lib/prompts/index.ts, lib/prompts/store.ts, lib/state/*.ts,
#      lib/prompts/extensions/system-below-threshold.ts
#    - If upstream changed the same files, keep our fix logic
#    - git add <resolved-file>
#    - git rebase --continue

# 5. Build and test after rebase
npm run build
npm run typecheck
npm test

# 6. Push rebased branch
git push origin patched/main --force-with-lease
```

**Upstream remote info:**
- Remote name: `upstream`
- URL: `git@github.com:Tarquinen/opencode-dynamic-context-pruning.git`
- Only fetch from upstream, never push

---

## Rebase Workflow — Agent Instructions

When an agent (or human) is rebasing `patched/main` onto upstream/master:

### 1. Read this governance file first

Before resolving conflicts, read `docs/GOVERNANCE.md` to understand:
- What the three fixes are and which files they touch
- The core principle: **preserve our fix logic**
- The sync workflow

### 2. Understand the rebase

- **`patched/main` onto `upstream/master`** — upstream released a new version, adapt our patches to the new codebase
- Our fixes touch 8 source files + 4 test files + 2 new files (all 4 fixes)

### 3. Resolve conflicts

Apply this decision tree:

1. **Is our fix code in the conflict?** → Keep our fix, adapt to upstream patterns if needed.
2. **Is this a structural change (API, type, pattern)?** → Adapt our fix code to the new upstream API while preserving its behavior.
3. **Is this a doc/spec file for our fix?** → Keep our version.
4. **Is this a shared file where both sides added different things?** → Keep both, merge carefully.
5. **When in doubt** → Keep our fix code. It's safer to have a conflict to fix later than to lose fix logic.

### 4. Verify after rebase

```bash
cd ~/www/misc/better-opencode-dcp
npm run build && npm run typecheck && npm test
```

---

## Pushing Changes to GitHub

```bash
cd ~/www/misc/better-opencode-dcp

# Normal push
git push origin patched/main

# Force push (after rebase)
git push origin patched/main --force-with-lease

# Push master (when syncing with upstream)
git checkout master
git merge upstream/master
git push origin master
```

---

## Recovery Scenarios

| Problem | Solution |
|---------|----------|
| Rebase fails with conflicts | Resolve conflicts (preserve our fixes!), `git rebase --continue` |
| Rebase is too messy to continue | `git rebase --abort` to reset, then resolve manually |
| Accidentally lost our fix code in conflict | Check `git reflog` to recover, or re-apply from `origin/patched/main` |
| Fork is far behind upstream | Run sync steps, resolve conflicts iteratively |
| Two config entries for DCP in plugin list | Deduplicate — keep only the `file://` entry (local fork) |
| Dev server loads old npm DCP instead of fork | Check `~/.config/opencode/opencode.jsonc` — must use `file://` URL |

---

## Common Mistakes to Avoid

- **Don't push to `upstream`** — Upstream is read-only. Always push to `origin`.
- **Don't use `-X theirs` when rebasing** — It will discard our three fixes on conflict.
- **Don't publish to npm from `patched/main`** — This is a private fork with patches; the package name `@tarquinen/opencode-dcp` belongs to the original author.
- **Don't forget to build after changes** — `dist/` must be up-to-date for the dev server to load changes. Either run `npm run build` manually or rely on `start-dev.sh` auto-build.
- **Don't skip `npm test` after rebase** — Upstream changes may have broken our fix logic silently.
- **Don't commit changes to `dist/`** — The `dist/` directory is built output; add it to `.gitignore` if not already.

---

## File Inventory

| File | Status | Fix |
|------|--------|-----|
| `lib/token-utils.ts` | Modified | Fix 1 |
| `lib/input-budget.ts` | **NEW** | Fix 2 |
| `lib/hooks.ts` | Modified | Fix 2, Fix 3, **Fix 4** |
| `lib/prompts/extensions/system-below-threshold.ts` | **NEW** | Fix 3 |
| `lib/prompts/index.ts` | Modified | Fix 3 |
| `lib/prompts/store.ts` | Modified | Fix 3 |
| `lib/state/types.ts` | Modified | Fix 3, **Fix 4** |
| `lib/state/state.ts` | Modified | Fix 3, **Fix 4** |
| `tests/token-utils.test.ts` | **NEW** | Fix 1 |
| `tests/input-budget.test.ts` | **NEW** | Fix 2 |
| `tests/hooks-permission.test.ts` | Modified | Fix 2, **Fix 4** (+7 new tests) |
| `tests/prompts.test.ts` | Modified | Fix 3 |
| `tests/token-usage.test.ts` | Modified | Fix 1 |

---

## Verification Commands

```bash
# Verify remotes
git remote -v
# origin → git@github.com:oleksii-honchar/better-opencode-dcp.git
# upstream → git@github.com:Tarquinen/opencode-dynamic-context-pruning.git

# Verify current branch
git branch --show-current
# Should show: patched/main

# Verify the four fixes
grep -n "return assistantInfo.tokens?.input || 0" lib/token-utils.ts           # Fix 1
grep -n "computeInputBudget" lib/input-budget.ts                                # Fix 2
grep -n "belowThresholdExtension" lib/prompts/store.ts                          # Fix 3
grep -n "dcpPromptInjected" lib/hooks.ts                                        # Fix 4

# Verify tests
npm test | tail -5
# Expected: ℹ tests 111 | ℹ pass 111 | ℹ fail 0

# Verify integration
grep "better-opencode-dcp" ~/.config/opencode/opencode.jsonc
# Expected: "file:///Users/oleksii.honchar/www/misc/better-opencode-dcp",

# Verify dev server build hook
grep -A2 "Build local DCP" ~/www/misc/better-opencode/scripts/start-dev.sh
# Expected: auto-build hook exists
```
