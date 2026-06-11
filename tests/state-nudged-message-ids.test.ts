import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, resetSessionState } from "../lib/state/state"

test("createSessionState initializes nudgedMessageIds as empty Set", () => {
    const state = createSessionState()

    assert.ok(state.nudges.nudgedMessageIds instanceof Set)
    assert.equal(state.nudges.nudgedMessageIds.size, 0)
})

test("resetSessionState resets nudgedMessageIds to empty Set", () => {
    const state = createSessionState()

    // Seed with some IDs to verify reset clears them
    state.nudges.nudgedMessageIds.add("msg-001")
    state.nudges.nudgedMessageIds.add("msg-002")
    assert.equal(state.nudges.nudgedMessageIds.size, 2)

    resetSessionState(state)

    assert.ok(state.nudges.nudgedMessageIds instanceof Set)
    assert.equal(state.nudges.nudgedMessageIds.size, 0)
})
