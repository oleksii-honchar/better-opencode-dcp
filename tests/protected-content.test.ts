import assert from "node:assert/strict"
import test from "node:test"
import type { WithParts } from "../lib/state"
import { createSessionState } from "../lib/state"
import { appendProtectedTools } from "../lib/compress/protected-content"
import type { SearchContext, SelectionResolution } from "../lib/compress/types"

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

    // pending
    return {
        ...base,
        state: {
            status: "pending" as const,
            input: input ?? {},
            raw: "{}",
        },
    } as WithParts["parts"][number]
}

function makeSearchContext(messages: WithParts[]): SearchContext {
    const rawMessagesById = new Map<string, WithParts>()
    for (const msg of messages) {
        rawMessagesById.set(msg.info.id, msg)
    }
    return {
        rawMessages: messages,
        rawMessagesById,
        rawIndexById: new Map(),
        summaryByBlockId: new Map(),
    }
}

function makeSelection(messageIds: string[]): SelectionResolution {
    return {
        startReference: { kind: "message", rawIndex: 0 },
        endReference: { kind: "message", rawIndex: 0 },
        messageIds,
        messageTokenById: new Map(),
        toolIds: [],
        requiredBlockIds: [],
    }
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

test("appendProtectedTools extracts arguments for completed protected tools", async () => {
    const state = createSessionState()
    const toolName = "bash"
    const callID = "call_1"
    const input = { command: "ls -la" }
    const output = "file1.txt\nfile2.txt"

    const message = makeMessage("msg_1", [
        makeToolPart(toolName, callID, "completed", input, output),
    ])

    const searchContext = makeSearchContext([message])
    const selection = makeSelection(["msg_1"])

    const result = await appendProtectedTools(
        null,
        state,
        false,
        "",
        selection,
        searchContext,
        [toolName],
    )

    // Should contain both arguments and output
    assert.ok(
        result.includes("Arguments:"),
        "Result should contain 'Arguments:' label",
    )
    assert.ok(
        result.includes(JSON.stringify(input)),
        `Result should contain stringified arguments: ${JSON.stringify(input)}`,
    )
    assert.ok(
        result.includes(output),
        `Result should contain output: ${output}`,
    )
})

test("appendProtectedTools stringifies arguments that are objects", async () => {
    const state = createSessionState()
    const toolName = "grep"
    const callID = "call_2"
    const input = { pattern: "error", path: "/src" }

    const message = makeMessage("msg_2", [
        makeToolPart(toolName, callID, "completed", input, "some match"),
    ])

    const searchContext = makeSearchContext([message])
    const selection = makeSelection(["msg_2"])

    const result = await appendProtectedTools(
        null,
        state,
        false,
        "",
        selection,
        searchContext,
        [toolName],
    )

    assert.ok(
        result.includes(JSON.stringify(input)),
        `Result should contain JSON.stringify of arguments: ${JSON.stringify(input)}`,
    )
})

test("appendProtectedTools preserves string arguments as-is", async () => {
    const state = createSessionState()
    const toolName = "bash"
    const callID = "call_3"
    // Some tools have string inputs
    const stringInput = "echo hello"

    const message = makeMessage("msg_3", [
        makeToolPart(toolName, callID, "completed", { command: stringInput }, "hello"),
    ])

    const searchContext = makeSearchContext([message])
    const selection = makeSelection(["msg_3"])

    const result = await appendProtectedTools(
        null,
        state,
        false,
        "",
        selection,
        searchContext,
        [toolName],
    )

    // The input object should be stringified
    assert.ok(
        result.includes(JSON.stringify({ command: stringInput })),
        "Result should contain JSON.stringify of arguments object",
    )
})

test("appendProtectedTools extracts arguments for tools with no output (status=running)", async () => {
    const state = createSessionState()
    const toolName = "bash"
    const callID = "call_4"
    const input = { command: "sleep 100" }

    const message = makeMessage("msg_4", [
        makeToolPart(toolName, callID, "running", input, undefined),
    ])

    const searchContext = makeSearchContext([message])
    const selection = makeSelection(["msg_4"])

    const result = await appendProtectedTools(
        null,
        state,
        false,
        "",
        selection,
        searchContext,
        [toolName],
    )

    // Tool is protected by name, so arguments should be extracted even without output
    assert.ok(
        result.includes("Arguments:"),
        "Result should contain 'Arguments:' for running tool",
    )
    assert.ok(
        result.includes(JSON.stringify(input)),
        `Result should contain arguments: ${JSON.stringify(input)}`,
    )
})

test("appendProtectedTools extracts arguments for tools with no output (status=pending)", async () => {
    const state = createSessionState()
    const toolName = "bash"
    const callID = "call_5"
    const input = { command: "pwd" }

    const message = makeMessage("msg_5", [
        makeToolPart(toolName, callID, "pending", input, undefined),
    ])

    const searchContext = makeSearchContext([message])
    const selection = makeSelection(["msg_5"])

    const result = await appendProtectedTools(
        null,
        state,
        false,
        "",
        selection,
        searchContext,
        [toolName],
    )

    assert.ok(
        result.includes("Arguments:"),
        "Result should contain 'Arguments:' for pending tool",
    )
    assert.ok(
        result.includes(JSON.stringify(input)),
        `Result should contain arguments: ${JSON.stringify(input)}`,
    )
})

test("appendProtectedTools preserves existing output extraction behavior", async () => {
    const state = createSessionState()
    const toolName = "bash"
    const callID = "call_6"
    const input = { command: "cat file.txt" }
    const output = "file contents here"

    const message = makeMessage("msg_6", [
        makeToolPart(toolName, callID, "completed", input, output),
    ])

    const searchContext = makeSearchContext([message])
    const selection = makeSelection(["msg_6"])

    const result = await appendProtectedTools(
        null,
        state,
        false,
        "",
        selection,
        searchContext,
        [toolName],
    )

    // Output must still be present (no regression)
    assert.ok(
        result.includes(output),
        `Result should still contain output: ${output}`,
    )
    assert.ok(
        result.includes(`### Tool: ${toolName}`),
        "Result should contain tool heading",
    )
})

test("appendProtectedTools returns unchanged summary when no protected tools", async () => {
    const state = createSessionState()
    const summary = "Initial summary"

    const message = makeMessage("msg_7", [
        makeToolPart("unknown_tool", "call_7", "completed", {}, "output"),
    ])

    const searchContext = makeSearchContext([message])
    const selection = makeSelection(["msg_7"])

    const result = await appendProtectedTools(
        null,
        state,
        false,
        summary,
        selection,
        searchContext,
        ["bash"], // only bash is protected, not unknown_tool
    )

    assert.equal(result, summary, "Result should be unchanged when no protected tools match")
})

test("appendProtectedTools includes arguments in correct format under tool heading", async () => {
    const state = createSessionState()
    const toolName = "bash"
    const callID = "call_8"
    const input = { command: "ls" }
    const output = "file.txt"

    const message = makeMessage("msg_8", [
        makeToolPart(toolName, callID, "completed", input, output),
    ])

    const searchContext = makeSearchContext([message])
    const selection = makeSelection(["msg_8"])

    const result = await appendProtectedTools(
        null,
        state,
        false,
        "",
        selection,
        searchContext,
        [toolName],
    )

    // Verify format: ### Tool: {name}\nArguments: {json}\n{output}
    assert.ok(
        result.includes(`### Tool: ${toolName}`),
        "Should have tool heading",
    )
    assert.ok(
        result.includes(`Arguments: ${JSON.stringify(input)}`),
        `Should have 'Arguments: {json}' format`,
    )
})

test("appendProtectedTools handles multiple protected tools with arguments", async () => {
    const state = createSessionState()
    const messages = [
        makeMessage("msg_9a", [
            makeToolPart("bash", "call_9a", "completed", { command: "ls" }, "dir1\n"),
        ]),
        makeMessage("msg_9b", [
            makeToolPart("grep", "call_9b", "completed", { pattern: "test" }, "match"),
        ]),
    ]

    const searchContext = makeSearchContext(messages)
    const selection = makeSelection(["msg_9a", "msg_9b"])

    const result = await appendProtectedTools(
        null,
        state,
        false,
        "",
        selection,
        searchContext,
        ["bash", "grep"],
    )

    assert.ok(
        result.includes("### Tool: bash"),
        "Should contain bash tool heading",
    )
    assert.ok(
        result.includes("### Tool: grep"),
        "Should contain grep tool heading",
    )
    assert.ok(
        result.includes(JSON.stringify({ command: "ls" })),
        "Should contain bash arguments",
    )
    assert.ok(
        result.includes(JSON.stringify({ pattern: "test" })),
        "Should contain grep arguments",
    )
})

test("appendProtectedTools does not extract arguments for non-protected tools", async () => {
    const state = createSessionState()
    const message = makeMessage("msg_10", [
        makeToolPart("unprotected", "call_10", "completed", { key: "value" }, "output"),
    ])

    const searchContext = makeSearchContext([message])
    const selection = makeSelection(["msg_10"])

    const result = await appendProtectedTools(
        null,
        state,
        false,
        "",
        selection,
        searchContext,
        ["bash"], // only bash is protected
    )

    assert.equal(result, "", "Result should be empty for non-protected tool")
})
