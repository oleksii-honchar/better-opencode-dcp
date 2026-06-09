import assert from "node:assert/strict"
import test from "node:test"
import { computeInputBudget } from "../lib/input-budget"

test("computeInputBudget shared-pool model: context - output when input is undefined", () => {
    assert.equal(computeInputBudget({ context: 200000, output: 16000 }), 184000)
})

test("computeInputBudget split-budget model: input is used directly when defined", () => {
    assert.equal(computeInputBudget({ context: 200000, input: 150000 }), 150000)
})

test("computeInputBudget zero context returns 0", () => {
    assert.equal(computeInputBudget({ context: 0 }), 0)
})

test("computeInputBudget empty object returns 0", () => {
    assert.equal(computeInputBudget({}), 0)
})

test("computeInputBudget large shared-pool model (Claude Opus)", () => {
    assert.equal(computeInputBudget({ context: 1000000, output: 128000 }), 872000)
})

test("computeInputBudget split-budget with output (input wins over context-output)", () => {
    assert.equal(computeInputBudget({ context: 400000, input: 272000, output: 128000 }), 272000)
})

test("computeInputBudget missing output field falls back to context", () => {
    assert.equal(computeInputBudget({ context: 200000 }), 200000)
})

test("computeInputBudget very large output (output exceeds context)", () => {
    assert.equal(computeInputBudget({ context: 100000, output: 200000 }), 0)
})

test("computeInputBudget negative prevention (output exceeds context)", () => {
    assert.equal(computeInputBudget({ context: 50000, output: 60000 }), 0)
})
