import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    ensureSessionInitialized,
    resetSessionState,
    saveSessionState,
    type WithParts,
} from "../lib/state"

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
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
            mode: "message",
            permission,
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
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
    }
}

function buildMessage(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "session-1",
                type: "text",
                text,
            },
        ],
    }
}

test("system prompt handler caches full model context for percentage thresholds", async () => {
    const state = createSessionState()
    const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("deny"), {
        reload() {},
        getRuntimePrompts() {
            return {} as any
        },
    } as any)

    await handler(
        {
            sessionID: "session-1",
            model: {
                limit: {
                    context: 200000,
                    output: 131072,
                },
            },
        } as any,
        { system: ["base system"] },
    )

    assert.equal(state.modelContextLimit, 68928)
})

test("system prompt handler dedup guard skips injection on subsequent calls", async () => {
    const state = createSessionState()
    const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("allow"), {
        reload() {},
        getRuntimePrompts() {
            return { system: "runtime prompt" } as any
        },
    } as any)

    const output = { system: ["base system"] }

    // First call — should inject the system prompt
    await handler(
        {
            sessionID: "session-1",
            model: {
                limit: {
                    context: 200000,
                    output: 131072,
                },
            },
        } as any,
        output,
    )

    const afterFirstCall = output.system[output.system.length - 1]
    assert.ok(afterFirstCall.includes("base system"), "first call should have base system")
    assert.ok(afterFirstCall.length > "base system".length, "first call should append system prompt")
    assert.equal(state.dcpPromptInjected, true, "dcpPromptInjected should be true after first call")

    // Second call — should NOT inject the system prompt again
    const snapshot = [...output.system]
    await handler(
        {
            sessionID: "session-1",
            model: {
                limit: {
                    context: 200000,
                    output: 131072,
                },
            },
        } as any,
        output,
    )

    assert.deepEqual(output.system, snapshot, "output.system should not change on second call")
})

test("session state creates with dcpPromptInjected defaulting to false", () => {
    const state = createSessionState()

    assert.equal(state.dcpPromptInjected, false)
})

test("session state resets dcpPromptInjected to false", () => {
    const state = createSessionState()
    state.dcpPromptInjected = true

    resetSessionState(state)

    assert.equal(state.dcpPromptInjected, false)
})

test("system prompt handler with empty system array pushes new entry", async () => {
    const state = createSessionState()
    const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("allow"), {
        reload() {},
        getRuntimePrompts() {
            return { system: "runtime prompt" } as any
        },
    } as any)

    const output = { system: [] as string[] }

    await handler(
        {
            sessionID: "session-1",
            model: {
                limit: { context: 200000, output: 131072 },
            },
        } as any,
        output,
    )

    assert.equal(output.system.length, 1)
    assert.ok(output.system[0].includes("runtime prompt"), "should contain rendered prompt text")
    assert.equal(state.dcpPromptInjected, true)
})

test("system prompt handler with flag already true skips injection and leaves system unchanged", async () => {
    const state = createSessionState()
    state.dcpPromptInjected = true
    const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("allow"), {
        reload() {},
        getRuntimePrompts() {
            return { system: "runtime prompt" } as any
        },
    } as any)

    const output = { system: ["base system"] }
    const snapshot = [...output.system]

    await handler(
        {
            sessionID: "session-1",
            model: {
                limit: { context: 200000, output: 131072 },
            },
        } as any,
        output,
    )

    assert.deepEqual(output.system, snapshot, "output.system should remain unchanged")
    assert.equal(state.dcpPromptInjected, true, "flag should stay true")
})

test("system prompt handler injects again after resetSessionState", async () => {
    const state = createSessionState()
    const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("allow"), {
        reload() {},
        getRuntimePrompts() {
            return { system: "runtime prompt" } as any
        },
    } as any)

    // First call — injects the prompt
    const output1 = { system: ["base system"] }
    await handler(
        {
            sessionID: "session-1",
            model: {
                limit: { context: 200000, output: 131072 },
            },
        } as any,
        output1,
    )

    assert.equal(state.dcpPromptInjected, true)
    assert.ok(output1.system[0].includes("base system"))
    assert.ok(output1.system[0].length > "base system".length, "first call should append system prompt")

    // Reset state — flag resets to false
    resetSessionState(state)
    assert.equal(state.dcpPromptInjected, false)

    // Second call — should inject again
    const output2 = { system: ["base system"] }
    await handler(
        {
            sessionID: "session-1",
            model: {
                limit: { context: 200000, output: 131072 },
            },
        } as any,
        output2,
    )

    assert.equal(state.dcpPromptInjected, true)
    assert.ok(output2.system[0].includes("base system"))
    assert.ok(output2.system[0].length > "base system".length, "second call should also append system prompt after reset")
})

test("system prompt handler with internal agent signature skips injection regardless of flag", async () => {
    const state = createSessionState()
    const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("allow"), {
        reload() {},
        getRuntimePrompts() {
            return { system: "runtime prompt" } as any
        },
    } as any)

    const output = { system: ["You are a title generator"] }

    await handler(
        {
            sessionID: "session-1",
            model: {
                limit: { context: 200000, output: 131072 },
            },
        } as any,
        output,
    )

    assert.deepEqual(output.system, ["You are a title generator"], "system should remain unchanged")
    assert.equal(state.dcpPromptInjected, false, "flag should remain false since injection never happened")
})

test("system prompt handler compresses permission deny skips injection regardless of flag", async () => {
    const state = createSessionState()
    const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("deny"), {
        reload() {},
        getRuntimePrompts() {
            return { system: "runtime prompt" } as any
        },
    } as any)

    const output = { system: ["base system"] }

    await handler(
        {
            sessionID: "session-1",
            model: {
                limit: { context: 200000, output: 131072 },
            },
        } as any,
        output,
    )

    assert.deepEqual(output.system, ["base system"], "system should remain unchanged")
    assert.equal(state.dcpPromptInjected, false, "flag should remain false since injection never happened")
})

test("chat message transform preserves dcp tags — stripHallucinations removed from pipeline", async () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        state,
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [buildMessage("assistant-1", "assistant", "alpha  omega")],
    }

    await handler({}, output)

    assert.equal(output.messages[0]?.parts[0]?.type, "text")
    // stripHallucinations was removed from the transform pipeline to avoid cache invalidation.
    // The createTextCompleteHandler (experimental.text.complete hook) still strips hallucinations
    // from model-generated text in real-time, so dcp tags remain in the transform path.
    assert.equal((output.messages[0]?.parts[0] as any).text, "alpha  omega")
})

test("chat message transform drops messages without info instead of crashing", async () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        state,
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [
            {
                role: "user",
                time: 1,
                parts: [
                    {
                        type: "text",
                        text: "Carica le skill di laravel",
                    },
                ],
            } as any,
        ],
    }

    await handler({}, output as any)

    assert.equal(state.sessionId, null)
    assert.equal(output.messages.length, 0)
})

test("command execute exits after effective permission resolves to deny", async () => {
    let sessionMessagesCalls = 0
    const output = { parts: [] as any[] }
    const handler = createCommandExecuteHandler(
        {
            session: {
                messages: async () => {
                    sessionMessagesCalls += 1
                    return { data: [] }
                },
            },
        } as any,
        createSessionState(),
        new Logger(false),
        buildConfig("deny"),
        "/tmp",
        { global: undefined, agents: {} },
    )

    await handler({ command: "dcp", sessionID: "session-1", arguments: "context" }, output)

    assert.equal(sessionMessagesCalls, 1)
    assert.deepEqual(output.parts, [])
})

test("text complete strips hallucinated metadata tags", async () => {
    const output = { text: "alpha  omega" }
    const handler = createTextCompleteHandler()

    await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output)

    assert.equal(output.text, "alpha  omega")
})

test("text complete handler strips dcp tags — regression after removing stripHallucinations from transform pipeline", async () => {
    const handler = createTextCompleteHandler()

    // Paired dcp tags
    const output1 = { text: "before<dcp-metadata>stripped</dcp-metadata> after" }
    await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output1)
    assert.equal(output1.text, "before after")

    // Unpaired dcp tags
    const output2 = { text: "start</dcp-metadata> end" }
    await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output2)
    assert.equal(output2.text, "start end")

    // Mixed paired and unpaired tags
    const output3 = { text: "x<dcp-metadata>y</dcp-metadata> z<dcp-metadata>q</dcp-metadata> w" }
    await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output3)
    assert.equal(output3.text, "x z w")

    // Non-dcp tags are preserved
    const output4 = { text: "<div>hello</div>" }
    await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output4)
    assert.equal(output4.text, "<div>hello</div>")
})

test("event hook attaches durations to matching blocks by message and call id", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(state, new Logger(false))
    const originalNow = Date.now
    Date.now = () => 100

    try {
        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "pending",
                            input: {},
                            raw: "",
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "pending",
                            input: {},
                            raw: "",
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "running",
                            input: {},
                            time: { start: 325 },
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "running",
                            input: {},
                            time: { start: 410 },
                        },
                    },
                },
            },
        })
        state.prune.messages.blocksById.set(1, {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 0,
            durationMs: 0,
            mode: "message",
            topic: "one",
            batchTopic: "one",
            startId: "m0001",
            endId: "m0001",
            anchorMessageId: "msg-a",
            compressMessageId: "message-1",
            compressCallId: "call-1",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: ["msg-a"],
            effectiveToolIds: [],
            createdAt: 1,
            summary: "a",
        })
        state.prune.messages.blocksById.set(2, {
            blockId: 2,
            runId: 2,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 0,
            durationMs: 0,
            mode: "message",
            topic: "two",
            batchTopic: "two",
            startId: "m0002",
            endId: "m0002",
            anchorMessageId: "msg-b",
            compressMessageId: "message-1",
            compressCallId: "call-2",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: ["msg-b"],
            effectiveToolIds: [],
            createdAt: 2,
            summary: "b",
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "completed",
                            input: {},
                            output: "done",
                            title: "",
                            metadata: {},
                            time: { start: 410, end: 500 },
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "completed",
                            input: {},
                            output: "done",
                            title: "",
                            metadata: {},
                            time: { start: 325, end: 500 },
                        },
                    },
                },
            },
        })
    } finally {
        Date.now = originalNow
    }

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 225)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 310)
})

test("event hook falls back to completed runtime when running duration missing", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(state, new Logger(false))

    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "call-3",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-3",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 500, end: 940 },
                    },
                },
            },
        },
    })

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 440)
})

test("event hook queues duration updates until the matching session is loaded", async () => {
    const logger = new Logger(false)
    const targetSessionId = `session-target-${process.pid}-${Date.now()}`
    const otherSessionId = `session-other-${process.pid}-${Date.now()}`
    const persistedState = createSessionState()
    persistedState.sessionId = targetSessionId
    persistedState.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "call-remote",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })
    await saveSessionState(persistedState, logger)

    const liveState = createSessionState()
    liveState.sessionId = otherSessionId
    const handler = createEventHandler(liveState, logger)

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                sessionID: targetSessionId,
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-remote",
                    messageID: "message-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 100,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                sessionID: targetSessionId,
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-remote",
                    messageID: "message-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 350, end: 500 },
                    },
                },
            },
        },
    })

    assert.equal(liveState.compressionTiming.pendingByCallId.has("message-1:call-remote"), true)
    assert.equal(liveState.compressionTiming.startsByCallId.has("message-1:call-remote"), false)

    await ensureSessionInitialized(
        {
            session: {
                get: async () => ({ data: { parentID: null } }),
            },
        } as any,
        liveState,
        targetSessionId,
        logger,
        [
            {
                info: {
                    id: "msg-user-1",
                    role: "user",
                    sessionID: targetSessionId,
                    agent: "assistant",
                    time: { created: 1 },
                } as WithParts["info"],
                parts: [],
            },
        ],
        false,
    )

    assert.equal(liveState.prune.messages.blocksById.get(1)?.durationMs, 250)
    assert.equal(liveState.compressionTiming.pendingByCallId.has("message-1:call-remote"), false)
})

test("event hook keeps same call id distinct across message ids", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(state, new Logger(false))

    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "shared-call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })
    state.prune.messages.blocksById.set(2, {
        blockId: 2,
        runId: 2,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "two",
        batchTopic: "two",
        startId: "m0002",
        endId: "m0002",
        anchorMessageId: "msg-b",
        compressMessageId: "message-2",
        compressCallId: "shared-call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-b"],
        effectiveToolIds: [],
        createdAt: 2,
        summary: "b",
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 100,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-2",
                    sessionID: "session-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 200,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-2",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 350, end: 500 },
                    },
                },
            },
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 450, end: 700 },
                    },
                },
            },
        },
    })

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 350)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 150)
})
