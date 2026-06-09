import assert from "node:assert/strict"
import test from "node:test"
import type { WithParts } from "../lib/state"
import { createSessionState } from "../lib/state"
import { getCurrentTokenUsage } from "../lib/token-utils"

test("getCurrentTokenUsage returns only input tokens when multiple token types are present", () => {
    const sessionID = "ses_token_utils_test"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
                tokens: {
                    input: 2400,
                    output: 600,
                    reasoning: 150,
                    cache: {
                        read: 300,
                        write: 0,
                    },
                },
            } as WithParts["info"],
            parts: [],
        },
    ]

    const state = createSessionState()
    const result = getCurrentTokenUsage(state, messages)

    // Should return only input tokens (2400), not the sum (3450)
    assert.equal(result, 2400)
})

test("getCurrentTokenUsage returns 0 when assistant message has no tokens", () => {
    const sessionID = "ses_token_utils_no_tokens"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-assistant-no-tokens",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [],
        },
    ]

    const state = createSessionState()
    const result = getCurrentTokenUsage(state, messages)

    assert.equal(result, 0)
})

test("getCurrentTokenUsage returns 0 when last assistant is a compaction summary", () => {
    const sessionID = "ses_token_utils_compaction"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-assistant-summary",
                role: "assistant",
                sessionID,
                agent: "assistant",
                summary: true,
                time: { created: 2 },
                tokens: {
                    input: 86000,
                    output: 1200,
                },
            } as WithParts["info"],
            parts: [],
        },
    ]

    const state = createSessionState()
    state.lastCompaction = 2
    const result = getCurrentTokenUsage(state, messages)

    assert.equal(result, 0)
})
