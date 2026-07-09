import assert from "node:assert/strict"
import test from "node:test"
import type { WithParts } from "../lib/state"
import { createSessionState } from "../lib/state"
import { prune } from "../lib/messages/prune"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"

const PRUNED_QUESTION_INPUT_REPLACEMENT =
    "[questions removed - see output for user's answers]"
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"

function makeLogger(): Logger {
    return new Logger(false)
}

function makeConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "detailed",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 100000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

function makeToolPart(
    toolName: string,
    callID: string,
    status: "completed" | "running" | "error" | "pending",
    input: Record<string, unknown> | undefined,
    output: string | undefined,
): WithParts["parts"][number] {
    const base = {
        id: `part-${callID}`,
        sessionID: "ses_test",
        messageID: "msg_test",
        type: "tool" as const,
        callID,
        tool: toolName,
    }

    if (status === "completed") {
        return {
            ...base,
            state: {
                status: "completed" as const,
                input: input ?? {},
                output: output ?? "",
                title: toolName,
                metadata: {},
                time: { start: 1, end: 2 },
            },
        } as WithParts["parts"][number]
    }

    if (status === "error") {
        return {
            ...base,
            state: {
                status: "error" as const,
                input: input ?? {},
                error: "something went wrong",
                time: { start: 1, end: 2 },
            },
        } as WithParts["parts"][number]
    }

    if (status === "running") {
        return {
            ...base,
            state: {
                status: "running" as const,
                input: input ?? {},
                time: { start: 1 },
            },
        } as WithParts["parts"][number]
    }

    return {
        ...base,
        state: {
            status: "pending" as const,
            input: input ?? {},
            raw: "{}",
        },
    } as WithParts["parts"][number]
}

function makeMessage(id: string, parts: WithParts["parts"]): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "ses_test",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts,
    }
}

test("pruneToolInputs: question tool only prunes questions field, preserves rest of input", async () => {
    const state = createSessionState()
    const logger = makeLogger()
    const config = makeConfig()

    const callID = "call_q1"
    const input = {
        questions: "What is your name?",
        context: "Important context that must be preserved",
        metadata: { key: "value" },
    }

    const message = makeMessage("msg_q1", [
        makeToolPart("question", callID, "completed", input, "John"),
    ])

    const messages = [message]
    state.prune.tools.set(callID, 1)

    prune(state, logger, config, messages)

    const part = messages[0].parts[0] as WithParts["parts"][number] & {
        state: { input: typeof input }
    }

    // questions field should be pruned
    assert.equal(
        part.state.input.questions,
        PRUNED_QUESTION_INPUT_REPLACEMENT,
        "questions field should be replaced with placeholder",
    )

    // Other fields must be preserved
    assert.equal(
        part.state.input.context,
        "Important context that must be preserved",
        "context field must be preserved",
    )
    assert.deepEqual(
        part.state.input.metadata,
        { key: "value" },
        "metadata field must be preserved",
    )

    // input object itself must NOT be undefined/null
    assert.ok(
        part.state.input !== undefined && part.state.input !== null,
        "part.state.input must not be undefined or null",
    )
})

test("pruneToolInputs: non-question completed tools are never touched", async () => {
    const state = createSessionState()
    const logger = makeLogger()
    const config = makeConfig()

    const callID = "call_b1"
    const input = { command: "ls -la /important/path" }

    const message = makeMessage("msg_b1", [
        makeToolPart("bash", callID, "completed", input, "file1.txt\n"),
    ])

    const messages = [message]
    state.prune.tools.set(callID, 1)

    prune(state, logger, config, messages)

    const part = messages[0].parts[0] as WithParts["parts"][number] & {
        state: { input: typeof input }
    }

    // Input must be completely untouched
    assert.equal(
        part.state.input.command,
        "ls -la /important/path",
        "bash tool input must be untouched",
    )

    // input object must NOT be undefined/null
    assert.ok(
        part.state.input !== undefined && part.state.input !== null,
        "part.state.input must not be undefined or null",
    )
})

test("pruneToolInputs: edit tool completed is never touched", async () => {
    const state = createSessionState()
    const logger = makeLogger()
    const config = makeConfig()

    const callID = "call_e1"
    const input = { file: "/path/to/file.ts", content: "const x = 1" }

    const message = makeMessage("msg_e1", [
        makeToolPart("edit", callID, "completed", input, "edited"),
    ])

    const messages = [message]
    state.prune.tools.set(callID, 1)

    prune(state, logger, config, messages)

    const part = messages[0].parts[0] as WithParts["parts"][number] & {
        state: { input: typeof input }
    }

    assert.equal(
        part.state.input.file,
        "/path/to/file.ts",
        "edit tool input must be untouched",
    )
    assert.ok(
        part.state.input !== undefined && part.state.input !== null,
        "part.state.input must not be undefined or null",
    )
})

test("pruneToolErrors: errored tool string fields replaced, but input object preserved", async () => {
    const state = createSessionState()
    const logger = makeLogger()
    const config = makeConfig()

    const callID = "call_err1"
    const input = {
        command: "rm -rf /important",
        description: "This is a sensitive description",
        count: 42,
    }

    const message = makeMessage("msg_err1", [
        makeToolPart("bash", callID, "error", input, undefined),
    ])

    const messages = [message]
    state.prune.tools.set(callID, 1)

    prune(state, logger, config, messages)

    const part = messages[0].parts[0] as WithParts["parts"][number] & {
        state: { input: typeof input }
    }

    // String fields should be replaced
    assert.equal(
        part.state.input.command,
        PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
        "string field should be replaced with placeholder",
    )
    assert.equal(
        part.state.input.description,
        PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
        "string field should be replaced with placeholder",
    )

    // Non-string fields must be preserved
    assert.equal(
        part.state.input.count,
        42,
        "non-string field must be preserved",
    )

    // input object itself must NOT be undefined/null
    assert.ok(
        part.state.input !== undefined && part.state.input !== null,
        "part.state.input must not be undefined or null",
    )
})

test("pruneToolErrors: errored tool with no string fields preserves input unchanged", async () => {
    const state = createSessionState()
    const logger = makeLogger()
    const config = makeConfig()

    const callID = "call_err2"
    const input = { count: 42, flag: true }

    const message = makeMessage("msg_err2", [
        makeToolPart("bash", callID, "error", input, undefined),
    ])

    const messages = [message]
    state.prune.tools.set(callID, 1)

    prune(state, logger, config, messages)

    const part = messages[0].parts[0] as WithParts["parts"][number] & {
        state: { input: typeof input }
    }

    assert.equal(part.state.input.count, 42)
    assert.equal(part.state.input.flag, true)
    assert.ok(
        part.state.input !== undefined && part.state.input !== null,
        "part.state.input must not be undefined or null",
    )
})

test("pruneToolInputs: tool not in prune.tools map is never touched", async () => {
    const state = createSessionState()
    const logger = makeLogger()
    const config = makeConfig()

    const callID = "call_skip1"
    const input = { command: "echo hello" }

    const message = makeMessage("msg_skip1", [
        makeToolPart("bash", callID, "completed", input, "hello"),
    ])

    const messages = [message]
    // NOT adding callID to prune.tools — should be skipped

    prune(state, logger, config, messages)

    const part = messages[0].parts[0] as WithParts["parts"][number] & {
        state: { input: typeof input }
    }

    assert.equal(part.state.input.command, "echo hello")
    assert.ok(
        part.state.input !== undefined && part.state.input !== null,
        "part.state.input must not be undefined or null",
    )
})

test("pruneToolInputs: non-completed tool is never touched", async () => {
    const state = createSessionState()
    const logger = makeLogger()
    const config = makeConfig()

    const callID = "call_run1"
    const input = { command: "sleep 100" }

    const message = makeMessage("msg_run1", [
        makeToolPart("bash", callID, "running", input, undefined),
    ])

    const messages = [message]
    state.prune.tools.set(callID, 1)

    prune(state, logger, config, messages)

    const part = messages[0].parts[0] as WithParts["parts"][number] & {
        state: { input: typeof input }
    }

    assert.equal(part.state.input.command, "sleep 100")
    assert.ok(
        part.state.input !== undefined && part.state.input !== null,
        "part.state.input must not be undefined or null",
    )
})

test("pruneToolInputs: question tool with no questions field preserves input", async () => {
    const state = createSessionState()
    const logger = makeLogger()
    const config = makeConfig()

    const callID = "call_q2"
    const input = { context: "No questions field here" }

    const message = makeMessage("msg_q2", [
        makeToolPart("question", callID, "completed", input, "answer"),
    ])

    const messages = [message]
    state.prune.tools.set(callID, 1)

    prune(state, logger, config, messages)

    const part = messages[0].parts[0] as WithParts["parts"][number] & {
        state: { input: typeof input }
    }

    assert.equal(part.state.input.context, "No questions field here")
    assert.ok(
        part.state.input !== undefined && part.state.input !== null,
        "part.state.input must not be undefined or null",
    )
})

test("pruneToolErrors: errored question tool preserves non-string fields", async () => {
    const state = createSessionState()
    const logger = makeLogger()
    const config = makeConfig()

    const callID = "call_qerr"
    const input = {
        questions: "What is the answer?",
        count: 99,
        options: ["a", "b", "c"],
    }

    const message = makeMessage("msg_qerr", [
        makeToolPart("question", callID, "error", input, undefined),
    ])

    const messages = [message]
    state.prune.tools.set(callID, 1)

    prune(state, logger, config, messages)

    const part = messages[0].parts[0] as WithParts["parts"][number] & {
        state: { input: typeof input }
    }

    // String field replaced
    assert.equal(
        part.state.input.questions,
        PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
        "string field should be replaced",
    )

    // Non-string fields preserved
    assert.equal(part.state.input.count, 99)
    assert.deepEqual(part.state.input.options, ["a", "b", "c"])

    assert.ok(
        part.state.input !== undefined && part.state.input !== null,
        "part.state.input must not be undefined or null",
    )
})

test("pruneToolInputs: write tool completed is never touched", async () => {
    const state = createSessionState()
    const logger = makeLogger()
    const config = makeConfig()

    const callID = "call_w1"
    const input = { file: "/path/to/file.txt", content: "file content" }

    const message = makeMessage("msg_w1", [
        makeToolPart("write", callID, "completed", input, "written"),
    ])

    const messages = [message]
    state.prune.tools.set(callID, 1)

    prune(state, logger, config, messages)

    const part = messages[0].parts[0] as WithParts["parts"][number] & {
        state: { input: typeof input }
    }

    assert.equal(part.state.input.file, "/path/to/file.txt")
    assert.equal(part.state.input.content, "file content")
    assert.ok(
        part.state.input !== undefined && part.state.input !== null,
        "part.state.input must not be undefined or null",
    )
})

test("pruneToolInputs: multiple tool parts in same message, only question pruned", async () => {
    const state = createSessionState()
    const logger = makeLogger()
    const config = makeConfig()

    const qCallID = "call_multi_q"
    const bCallID = "call_multi_b"

    const qInput = { questions: "Your name?", context: "preserve me" }
    const bInput = { command: "ls" }

    const message = makeMessage("msg_multi", [
        makeToolPart("question", qCallID, "completed", qInput, "John"),
        makeToolPart("bash", bCallID, "completed", bInput, "file.txt"),
    ])

    const messages = [message]
    state.prune.tools.set(qCallID, 1)
    state.prune.tools.set(bCallID, 1)

    prune(state, logger, config, messages)

    const qPart = messages[0].parts[0] as WithParts["parts"][number] & {
        state: { input: typeof qInput }
    }
    const bPart = messages[0].parts[1] as WithParts["parts"][number] & {
        state: { input: typeof bInput }
    }

    // Question: questions pruned, context preserved
    assert.equal(qPart.state.input.questions, PRUNED_QUESTION_INPUT_REPLACEMENT)
    assert.equal(qPart.state.input.context, "preserve me")

    // Bash: completely untouched
    assert.equal(bPart.state.input.command, "ls")

    // Neither input is undefined/null
    assert.ok(qPart.state.input !== undefined && qPart.state.input !== null)
    assert.ok(bPart.state.input !== undefined && bPart.state.input !== null)
})
