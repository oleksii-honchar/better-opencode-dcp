import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCompressRangeTool } from "../lib/compress/range"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { prune } from "../lib/messages/prune"

const testDataHome = join(tmpdir(), `opencode-dcp-integration-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-integration-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["bash", "grep", "edit", "write"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
        ...overrides,
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function toolPart(
    messageID: string,
    sessionID: string,
    callID: string,
    toolName: string,
    status: "completed" | "error" | "running",
    input: Record<string, unknown>,
    output?: string,
): WithParts["parts"][number] {
    const base = {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool: toolName,
        callID,
    }

    if (status === "completed") {
        return {
            ...base,
            state: {
                status: "completed" as const,
                input,
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
                input,
                error: "tool error",
                time: { start: 1, end: 2 },
            },
        } as WithParts["parts"][number]
    }

    return {
        ...base,
        state: {
            status: "running" as const,
            input,
            time: { start: 1 },
        },
    } as WithParts["parts"][number]
}

function makeMessage(
    id: string,
    role: "user" | "assistant",
    sessionID: string,
    parts: WithParts["parts"],
    agent = "assistant",
): WithParts {
    const base: WithParts["info"] = {
        id,
        role,
        sessionID,
        agent,
        time: { created: 1 },
    }
    if (role === "user") {
        ;(base as any).model = {
            providerID: "anthropic",
            modelID: "claude-test",
        }
    }
    return { info: base, parts }
}

/**
 * Build a realistic conversation with multiple tool calls that have arguments.
 * This simulates the scenario that caused the original bug:
 * "Missing required parameter: 'input[98].arguments'" after compaction.
 */
function buildLongConversation(sessionID: string): WithParts[] {
    return [
        // User initiates
        makeMessage("msg-user-1", "user", sessionID, [
            textPart("msg-user-1", sessionID, "part-1", "Investigate the build failure in /src/core"),
        ]),

        // Assistant responds with text
        makeMessage("msg-assistant-1", "assistant", sessionID, [
            textPart("msg-assistant-1", sessionID, "part-2", "Let me check the build output"),
        ]),

        // Tool call: bash with arguments
        makeMessage("msg-assistant-2", "assistant", sessionID, [
            toolPart(
                "msg-assistant-2",
                sessionID,
                "call-bash-1",
                "bash",
                "completed",
                { command: "cd /src/core && npm run build 2>&1 | tail -20" },
                "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'",
            ),
        ]),

        // Assistant responds with text
        makeMessage("msg-assistant-3", "assistant", sessionID, [
            textPart("msg-assistant-3", sessionID, "part-3", "Found a type error. Let me search for the usage."),
        ]),

        // Tool call: grep with arguments
        makeMessage("msg-assistant-4", "assistant", sessionID, [
            toolPart(
                "msg-assistant-4",
                sessionID,
                "call-grep-1",
                "grep",
                "completed",
                { pattern: "TS2345", path: "/src/core" },
                "/src/core/index.ts:42: const x: number = 'hello'",
            ),
        ]),

        // Tool call: edit with arguments (protected by file pattern)
        makeMessage("msg-assistant-5", "assistant", sessionID, [
            toolPart(
                "msg-assistant-5",
                sessionID,
                "call-edit-1",
                "edit",
                "completed",
                { file: "/src/core/index.ts", oldString: "const x: number = 'hello'", newString: "const x: number = 42" },
                "edited",
            ),
        ]),

        // More user messages
        makeMessage("msg-user-2", "user", sessionID, [
            textPart("msg-user-2", sessionID, "part-4", "Also check the test suite"),
        ]),

        // Tool call: bash again
        makeMessage("msg-assistant-6", "assistant", sessionID, [
            toolPart(
                "msg-assistant-6",
                sessionID,
                "call-bash-2",
                "bash",
                "completed",
                { command: "cd /src/core && npm test -- --run" },
                "PASS  tests/core.test.ts (12 passed)",
            ),
        ]),

        // Final assistant message
        makeMessage("msg-assistant-7", "assistant", sessionID, [
            textPart("msg-assistant-7", sessionID, "part-5", "Build and tests are passing now."),
        ]),
    ]
}

test("integration: compaction preserves tool arguments in summary", async () => {
    const sessionID = `ses_integration_args_${Date.now()}`
    const rawMessages = buildLongConversation(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    // Compress the middle of the conversation (messages 2-6, which contain tool calls)
    const result = await tool.execute(
        {
            topic: "Build investigation",
            content: [
                {
                    startId: "m0002",
                    endId: "m0006",
                    summary:
                        "Assistant investigated build failure, found type error, fixed it, and verified tests pass.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress",
        },
    )

    assert.equal(result, "Compressed 5 messages into [Compressed conversation section].")
    assert.equal(state.prune.messages.blocksById.size, 1)

    // Get the compression block
    const block = Array.from(state.prune.messages.blocksById.values())[0]
    assert.ok(block, "Compression block should exist")

    // CRITICAL: The summary must contain tool arguments (this is the regression test)
    const summary = block.summary
    assert.ok(
        summary.includes("Arguments:"),
        "Summary must contain 'Arguments:' label — tool arguments must be preserved in compaction",
    )

    // Verify specific tool arguments are in the summary
    assert.ok(
        summary.includes('"command"') || summary.includes("command:"),
        "Summary must contain bash command arguments",
    )
    assert.ok(
        summary.includes("cd /src/core && npm run build") ||
            summary.includes("cd /src/core && npm test"),
        "Summary must contain the actual bash command from arguments",
    )
    assert.ok(
        summary.includes('"pattern"') || summary.includes("pattern:"),
        "Summary must contain grep pattern arguments",
    )
    assert.ok(
        summary.includes('"file"') || summary.includes("file:"),
        "Summary must contain edit file arguments",
    )
})

test("integration: prune preserves part.state.input on surviving tool messages", async () => {
    const sessionID = `ses_integration_prune_${Date.now()}`
    const messages = [
        makeMessage("msg-user-1", "user", sessionID, [
            textPart("msg-user-1", sessionID, "part-1", "Run a command"),
        ]),

        // This message survives pruning (not in compression range)
        makeMessage("msg-assistant-1", "assistant", sessionID, [
            toolPart(
                "msg-assistant-1",
                sessionID,
                "call-bash-1",
                "bash",
                "completed",
                { command: "echo hello" },
                "hello",
            ),
        ]),

        // This message is in the compression range (will be pruned)
        makeMessage("msg-assistant-2", "assistant", sessionID, [
            toolPart(
                "msg-assistant-2",
                sessionID,
                "call-bash-2",
                "bash",
                "completed",
                { command: "pwd" },
                "/home/user",
            ),
        ]),

        makeMessage("msg-user-2", "user", sessionID, [
            textPart("msg-user-2", sessionID, "part-2", "Done"),
        ]),
    ]

    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    // Set up compression: msg-assistant-2 is compressed
    state.prune.messages.byMessageId.set("msg-assistant-2", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })

    // Anchor the summary at msg-user-2
    state.prune.messages.activeByAnchorMessageId.set("msg-user-2", 1)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 100,
        summaryTokens: 50,
        durationMs: 0,
        topic: "Test",
        startId: "m0002",
        endId: "m0002",
        anchorMessageId: "msg-user-2",
        compressMessageId: "msg-compress",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-assistant-2"],
        directToolIds: [],
        effectiveMessageIds: ["msg-assistant-2"],
        effectiveToolIds: [],
        createdAt: Date.now(),
        summary: "Summarized content",
    } as any)

    // Mark the tool for pruning
    state.prune.tools.set("call-bash-2", 1)

    // Run prune
    prune(state, logger, config, messages)

    // msg-assistant-1 should survive with its input intact
    const survivingMsg = messages.find((m) => m.info.id === "msg-assistant-1")
    assert.ok(survivingMsg, "msg-assistant-1 should survive pruning")

    const survivingPart = survivingMsg.parts[0] as any
    assert.ok(
        survivingPart.state?.input !== undefined && survivingPart.state?.input !== null,
        "Surviving tool message must have part.state.input defined",
    )
    assert.equal(
        survivingPart.state.input.command,
        "echo hello",
        "Surviving tool message must have original input preserved",
    )

    // msg-assistant-2 should be filtered out (compressed)
    const prunedMsg = messages.find((m) => m.info.id === "msg-assistant-2")
    assert.equal(
        prunedMsg,
        undefined,
        "msg-assistant-2 should be removed by filterCompressedRanges",
    )
})

test("integration: full compaction pipeline — arguments survive compression and pruning", async () => {
    /**
     * This is the critical end-to-end test that reproduces the original bug scenario:
     * 1. Create a long conversation with tool calls
     * 2. Compress the middle (which includes tool calls with arguments)
     * 3. Verify the compressed summary contains arguments (via appendProtectedTools)
     * 4. Verify surviving tool messages retain part.state.input (via prune)
     * 5. Verify pruned tool messages are removed but their arguments live in the summary
     */
    const sessionID = `ses_integration_e2e_${Date.now()}`
    const rawMessages = buildLongConversation(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    // Compress messages 2-6 (the tool-heavy middle section)
    await tool.execute(
        {
            topic: "Build investigation",
            content: [
                {
                    startId: "m0002",
                    endId: "m0006",
                    summary: "Assistant investigated and fixed the build.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress",
        },
    )

    const block = Array.from(state.prune.messages.blocksById.values())[0]
    assert.ok(block, "Compression block should exist")

    // Phase 1: Verify appendProtectedTools captured arguments
    const summary = block.summary
    assert.ok(
        summary.includes("Arguments:"),
        "Compaction summary must contain tool arguments (appendProtectedTools fix)",
    )

    // Verify bash arguments are present
    assert.ok(
        summary.includes("cd /src/core"),
        "Bash command arguments must be in summary",
    )

    // Verify grep arguments are present
    assert.ok(
        summary.includes("TS2345"),
        "Grep pattern arguments must be in summary",
    )

    // Phase 2: Simulate filterCompressedRanges + prune on the full message list
    // The compressed messages should be replaced by a synthetic summary message
    const messages = [...rawMessages]

    // Mark tools in the compressed range for pruning
    state.prune.tools.set("call-bash-1", 1)
    state.prune.tools.set("call-grep-1", 1)
    state.prune.tools.set("call-edit-1", 1)
    state.prune.tools.set("call-bash-2", 1)

    prune(state, logger, config, messages)

    // Phase 3: Verify compressed messages were removed
    const compressedMsgIds = [
        "msg-assistant-1",
        "msg-assistant-2",
        "msg-assistant-3",
        "msg-assistant-4",
        "msg-assistant-5",
    ]
    for (const msgId of compressedMsgIds) {
        const found = messages.find((m) => m.info.id === msgId)
        assert.equal(
            found,
            undefined,
            `Message ${msgId} should have been removed by filterCompressedRanges`,
        )
    }

    // Phase 4: Verify surviving messages (not compressed) still have valid input
    // msg-user-1 and msg-user-2 and msg-assistant-7 should survive
    const user1 = messages.find((m) => m.info.id === "msg-user-1")
    assert.ok(user1, "msg-user-1 should survive")

    const user2 = messages.find((m) => m.info.id === "msg-user-2")
    assert.ok(user2, "msg-user-2 should survive")

    const assistant7 = messages.find((m) => m.info.id === "msg-assistant-7")
    assert.ok(assistant7, "msg-assistant-7 should survive")

    // Phase 5: Verify synthetic summary message was injected
    const syntheticMsg = messages.find((m) => m.info.id?.startsWith("msg_dcp_summary"))
    assert.ok(
        syntheticMsg,
        "A synthetic summary message should be injected at the anchor point",
    )
    assert.ok(
        syntheticMsg.parts[0]?.type === "text",
        "Synthetic message should have a text part",
    )
    const summaryText = (syntheticMsg.parts[0] as any).text
    // Summary is wrapped with [Compressed conversation section] header
    assert.ok(
        summaryText.includes("[Compressed conversation section]") || summaryText.includes("Assistant investigated and fixed the build"),
        `Synthetic message should contain the summary content. Got: ${summaryText.slice(0, 200)}`,
    )
})

test("integration: compaction preserves arguments for multiple tool types simultaneously", async () => {
    const sessionID = `ses_integration_multi_tool_${Date.now()}`
    const rawMessages = [
        makeMessage("msg-user-1", "user", sessionID, [
            textPart("msg-user-1", sessionID, "part-1", "Search and fix"),
        ]),

        makeMessage("msg-assistant-1", "assistant", sessionID, [
            toolPart(
                "msg-assistant-1",
                sessionID,
                "call-bash-1",
                "bash",
                "completed",
                { command: "ls -la /src" },
                "file1.ts\nfile2.ts",
            ),
            toolPart(
                "msg-assistant-1",
                sessionID,
                "call-grep-1",
                "grep",
                "completed",
                { pattern: "FIXME", path: "/src" },
                "/src/file1.ts:42: // FIXME: refactor",
            ),
            toolPart(
                "msg-assistant-1",
                sessionID,
                "call-write-1",
                "write",
                "completed",
                { file: "/src/file1.ts", content: "const x = 42" },
                "written",
            ),
        ]),

        makeMessage("msg-user-2", "user", sessionID, [
            textPart("msg-user-2", sessionID, "part-2", "Done"),
        ]),
    ]

    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    // m0001 = msg-user-1, m0002 = msg-assistant-1 (with tools), m0003 = msg-user-2
    // Compress m0002 which contains the tool calls
    await tool.execute(
        {
            topic: "Multi-tool compression",
            content: [
                {
                    startId: "m0002",
                    endId: "m0002",
                    summary: "Assistant searched and fixed code.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress",
        },
    )

    const block = Array.from(state.prune.messages.blocksById.values())[0]
    assert.ok(block, "Compression block should exist")

    const summary = block.summary

    // All three tool types should have arguments in the summary
    assert.ok(
        summary.includes("### Tool: bash"),
        `Bash tool heading should be in summary. Got: ${summary.slice(0, 500)}`,
    )
    assert.ok(
        summary.includes("### Tool: grep"),
        `Grep tool heading should be in summary. Got: ${summary.slice(0, 500)}`,
    )
    assert.ok(
        summary.includes("### Tool: write"),
        `Write tool heading should be in summary. Got: ${summary.slice(0, 500)}`,
    )

    // All three should have Arguments: label
    const argumentsCount = (summary.match(/Arguments:/g) || []).length
    assert.ok(
        argumentsCount >= 3,
        `At least 3 tool calls should have 'Arguments:' in summary (found ${argumentsCount})`,
    )

    // Verify specific arguments
    assert.ok(
        summary.includes("ls -la /src"),
        "Bash command argument should be in summary",
    )
    assert.ok(
        summary.includes("FIXME"),
        "Grep pattern argument should be in summary",
    )
    assert.ok(
        summary.includes("/src/file1.ts"),
        "Write file argument should be in summary",
    )
})

test("integration: compaction preserves arguments for errored tools", async () => {
    const sessionID = `ses_integration_error_tool_${Date.now()}`
    const rawMessages = [
        makeMessage("msg-user-1", "user", sessionID, [
            textPart("msg-user-1", sessionID, "part-1", "Try something that might fail"),
        ]),

        makeMessage("msg-assistant-1", "assistant", sessionID, [
            toolPart(
                "msg-assistant-1",
                sessionID,
                "call-bash-err",
                "bash",
                "error",
                { command: "rm -rf /important" },
                undefined,
            ),
        ]),

        makeMessage("msg-user-2", "user", sessionID, [
            textPart("msg-user-2", sessionID, "part-2", "OK"),
        ]),
    ]

    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    // m0001 = msg-user-1, m0002 = msg-assistant-1 (with errored tool), m0003 = msg-user-2
    // Compress m0002 which contains the errored tool call
    await tool.execute(
        {
            topic: "Errored tool compression",
            content: [
                {
                    startId: "m0002",
                    endId: "m0002",
                    summary: "Assistant attempted a command that failed.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress",
        },
    )

    const block = Array.from(state.prune.messages.blocksById.values())[0]
    assert.ok(block, "Compression block should exist")

    const summary = block.summary

    // Errored tool arguments should still be captured
    assert.ok(
        summary.includes("Arguments:"),
        `Errored tool should have 'Arguments:' in summary. Got: ${summary.slice(0, 500)}`,
    )
    assert.ok(
        summary.includes("rm -rf /important"),
        `Errored tool command argument should be in summary. Got: ${summary.slice(0, 500)}`,
    )
})

test("integration: prune never sets part.state.input to undefined for completed tools", async () => {
    const sessionID = `ses_integration_no_undefined_${Date.now()}`
    const messages = [
        makeMessage("msg-user-1", "user", sessionID, [
            textPart("msg-user-1", sessionID, "part-1", "Run commands"),
        ]),

        // Bash tool — completed, should never have input pruned
        makeMessage("msg-assistant-1", "assistant", sessionID, [
            toolPart(
                "msg-assistant-1",
                sessionID,
                "call-bash-1",
                "bash",
                "completed",
                { command: "ls -la" },
                "file.txt",
            ),
        ]),

        // Question tool — completed, only questions field pruned
        makeMessage("msg-assistant-2", "assistant", sessionID, [
            toolPart(
                "msg-assistant-2",
                sessionID,
                "call-question-1",
                "question",
                "completed",
                { questions: "What is your name?", context: "preserve this" },
                "John",
            ),
        ]),

        // Edit tool — completed, should never have input pruned
        makeMessage("msg-assistant-3", "assistant", sessionID, [
            toolPart(
                "msg-assistant-3",
                sessionID,
                "call-edit-1",
                "edit",
                "completed",
                { file: "/path/file.ts", oldString: "a", newString: "b" },
                "edited",
            ),
        ]),
    ]

    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()

    // Mark all tools for pruning
    state.prune.tools.set("call-bash-1", 1)
    state.prune.tools.set("call-question-1", 1)
    state.prune.tools.set("call-edit-1", 1)

    prune(state, logger, config, messages)

    // Bash: input must be completely intact
    const bashPart = messages[1].parts[0] as any
    assert.ok(bashPart.state.input !== undefined && bashPart.state.input !== null, "Bash input must not be undefined/null")
    assert.equal(bashPart.state.input.command, "ls -la", "Bash command must be intact")

    // Question: questions field pruned, but other fields preserved
    const questionPart = messages[2].parts[0] as any
    assert.ok(questionPart.state.input !== undefined && questionPart.state.input !== null, "Question input must not be undefined/null")
    assert.equal(questionPart.state.input.questions, "[questions removed - see output for user's answers]", "Questions field should be pruned")
    assert.equal(questionPart.state.input.context, "preserve this", "Question context must be preserved")

    // Edit: input must be completely intact
    const editPart = messages[3].parts[0] as any
    assert.ok(editPart.state.input !== undefined && editPart.state.input !== null, "Edit input must not be undefined/null")
    assert.equal(editPart.state.input.file, "/path/file.ts", "Edit file must be intact")
    assert.equal(editPart.state.input.oldString, "a", "Edit oldString must be intact")
})
