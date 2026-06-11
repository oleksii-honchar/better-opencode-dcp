import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createTextCompleteHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { injectMessageIds } from "../lib/messages/inject/inject"
import { applyAnchoredNudges } from "../lib/messages/inject/utils"
import { prune } from "../lib/messages/prune"
import { buildPriorityMap } from "../lib/messages/priority"
import { stripHallucinationsFromString } from "../lib/messages/utils"
import { createSessionState, type WithParts } from "../lib/state"

function buildConfig(mode: "message" | "range" = "message"): PluginConfig {
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
            mode,
            permission: "allow",
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
    output: string,
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool: toolName,
        callID,
        state: {
            status: "completed" as const,
            input: { description: "demo" },
            output,
        },
    }
}

function buildMessage(
    id: string,
    role: "user" | "assistant",
    sessionID: string,
    text: string,
    created: number,
): WithParts {
    const info =
        role === "user"
            ? {
                  id,
                  role,
                  sessionID,
                  agent: "assistant",
                  model: {
                      providerID: "anthropic",
                      modelID: "claude-test",
                  },
                  time: { created },
              }
            : {
                  id,
                  role,
                  sessionID,
                  agent: "assistant",
                  time: { created },
              }

    return {
        info: info as WithParts["info"],
        parts: [textPart(id, sessionID, `${id}-part`, text)],
    }
}

function repeatedWord(word: string, count: number): string {
    return Array.from({ length: count }, () => word).join(" ")
}

test("injectMessageIds injects ID into every tool output for assistant messages", () => {
    const sessionID = "ses_message_priority_tags"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-1",
                    sessionID,
                    "msg-user-1-part-1",
                    repeatedWord("investigate", 6000),
                ),
                textPart("msg-user-1", sessionID, "msg-user-1-part-2", "Trailing note."),
            ],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-1",
                    sessionID,
                    "msg-assistant-1-part-1",
                    "Short follow-up note.",
                ),
                toolPart("msg-assistant-1", sessionID, "call-task-1", "task", "task output body"),
                textPart(
                    "msg-assistant-1",
                    sessionID,
                    "msg-assistant-1-part-2",
                    "Second text chunk.",
                ),
                toolPart(
                    "msg-assistant-1",
                    sessionID,
                    "call-task-2",
                    "bash",
                    "second tool output body",
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig()

    assignMessageRefs(state, messages)
    const compressionPriorities = buildPriorityMap(config, state, messages)

    injectMessageIds(state, config, messages)

    assert.equal(messages[0]?.parts.length, 2)
    assert.equal(messages[1]?.parts.length, 4)

    const userTextOne = messages[0]?.parts[0]
    const userTextTwo = messages[0]?.parts[1]
    const assistantTextOne = messages[1]?.parts[0]
    const assistantToolOne = messages[1]?.parts[1]
    const assistantTextTwo = messages[1]?.parts[2]
    const assistantToolTwo = messages[1]?.parts[3]

    assert.equal(userTextOne?.type, "text")
    assert.equal(userTextTwo?.type, "text")
    assert.equal(assistantTextOne?.type, "text")
    assert.equal(assistantToolOne?.type, "tool")
    assert.equal(assistantTextTwo?.type, "text")
    assert.equal(assistantToolTwo?.type, "tool")
    // User messages: still injected into all text parts (no priority attribute)
    assert.match(
        (userTextOne as any).text,
        /\n\n<dcp-message-id>m0001<\/dcp-message-id>/,
    )
    assert.match(
        (userTextTwo as any).text,
        /\n\n<dcp-message-id>m0001<\/dcp-message-id>/,
    )
    // Assistant messages: ID injected into every tool output
    assert.doesNotMatch((assistantTextOne as any).text, /dcp-message-id/)
    assert.match((assistantToolOne as any).state.output, /m0002<\/dcp-message-id>/)
    assert.doesNotMatch((assistantTextTwo as any).text, /dcp-message-id/)
    assert.match((assistantToolTwo as any).state.output, /m0002<\/dcp-message-id>/)
})

test("injectMessageIds marks every protected user text part as BLOCKED in message mode", () => {
    const sessionID = "ses_message_blocked_user_tags"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-1",
                    sessionID,
                    "msg-user-1-part-1",
                    repeatedWord("investigate", 6000),
                ),
                textPart("msg-user-1", sessionID, "msg-user-1-part-2", "Trailing note."),
            ],
        },
        buildMessage("msg-assistant-1", "assistant", sessionID, "Short follow-up note.", 2),
    ]
    const state = createSessionState()
    const config = buildConfig()
    config.compress.protectUserMessages = true

    assignMessageRefs(state, messages)
    const compressionPriorities = buildPriorityMap(config, state, messages)

    injectMessageIds(state, config, messages)

    const userTextOne = messages[0]?.parts[0]
    const userTextTwo = messages[0]?.parts[1]
    const assistantText = messages[1]?.parts[0]

    assert.equal(userTextOne?.type, "text")
    assert.equal(userTextTwo?.type, "text")
    assert.equal(assistantText?.type, "text")
    assert.match((userTextOne as any).text, /\n\n<dcp-message-id>BLOCKED<\/dcp-message-id>/)
    assert.match((userTextTwo as any).text, /\n\n<dcp-message-id>BLOCKED<\/dcp-message-id>/)
    assert.doesNotMatch((userTextOne as any).text, /priority=/)
    assert.doesNotMatch((userTextTwo as any).text, /priority=/)
    assert.match(
        (assistantText as any).text,
        /\n\n<dcp-message-id>m0002<\/dcp-message-id>/,
    )
})

test("injectMessageIds injects ID into every tool output in range mode", () => {
    const sessionID = "ses_range_message_id_tags"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("investigate", 6000), 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part-1", "First chunk."),
                toolPart("msg-assistant-1", sessionID, "call-task-range-1", "task", "first output"),
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part-2", "Second chunk."),
                toolPart(
                    "msg-assistant-1",
                    sessionID,
                    "call-task-range-2",
                    "bash",
                    "second output",
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    injectMessageIds(state, config, messages)

    const assistantTextOne = messages[1]?.parts[0]
    const assistantToolOne = messages[1]?.parts[1]
    const assistantTextTwo = messages[1]?.parts[2]
    const assistantToolTwo = messages[1]?.parts[3]

    // Every tool output gets the ID
    assert.doesNotMatch((assistantTextOne as any).text, /dcp-message-id/)
    assert.match((assistantToolOne as any).state.output, /m0002<\/dcp-message-id>/)
    assert.doesNotMatch((assistantTextTwo as any).text, /dcp-message-id/)
    assert.match((assistantToolTwo as any).state.output, /m0002<\/dcp-message-id>/)
})

test("message mode marks compress tool messages as high priority even when short", () => {
    const sessionID = "ses_message_compress_high_priority"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Please compress this chunk.", 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part-1", "Done."),
                toolPart(
                    "msg-assistant-1",
                    sessionID,
                    "call-compress-1",
                    "compress",
                    "[Compressed conversation section]",
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig()

    assignMessageRefs(state, messages)
    const compressionPriorities = buildPriorityMap(config, state, messages)

    assert.equal(compressionPriorities.get("msg-assistant-1")?.priority, "high")

    injectMessageIds(state, config, messages)

    const assistantText = messages[1]?.parts[0]
    const assistantTool = messages[1]?.parts[1]

    // ID injected into tool output, not the text part
    assert.doesNotMatch((assistantText as any).text, /dcp-message-id/)
    assert.match((assistantTool as any).state.output, /m0002<\/dcp-message-id>/)
    assert.match(
        (assistantTool as any).state.output,
        /<dcp-message-id>m0002<\/dcp-message-id>/,
    )
})

test("message-mode nudges append to existing text parts and list only earlier visible high-priority message IDs", () => {
    const sessionID = "ses_message_priority_nudges"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("alpha", 6000), 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, repeatedWord("beta", 6000), 2),
        buildMessage("msg-user-2", "user", sessionID, repeatedWord("gamma", 6000), 3),
        buildMessage("msg-assistant-2", "assistant", sessionID, repeatedWord("delta", 6000), 4),
    ]
    const state = createSessionState()
    const config = buildConfig()

    assignMessageRefs(state, messages)
    state.prune.messages.byMessageId.set("msg-assistant-1", {
        tokenCount: 999,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.nudges.contextLimitAnchors.add("msg-user-2")

    const compressionPriorities = buildPriorityMap(config, state, messages)

    applyAnchoredNudges(
        state,
        config,
        messages,
        {
            system: "",
            compressRange: "",
            compressMessage: "",
            contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
            turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
            iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
        },
        compressionPriorities,
    )

    assert.equal(messages[2]?.parts.length, 1)

    const injectedNudge = messages[2]?.parts[0]
    assert.equal(injectedNudge?.type, "text")
    assert.match((injectedNudge as any).text, /\n\n<dcp-system-reminder>Base context nudge/)
    assert.match((injectedNudge as any).text, /Message priority context:/)
    assert.match((injectedNudge as any).text, /High-priority message IDs before this point: m0001/)
    assert.doesNotMatch((injectedNudge as any).text, /m0002/)
    assert.doesNotMatch((injectedNudge as any).text, /m0003/)
    assert.doesNotMatch((injectedNudge as any).text, /m0004/)
})

test("message-mode nudges exclude protected user messages from priority guidance", () => {
    const sessionID = "ses_message_blocked_priority_nudges"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("alpha", 6000), 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, repeatedWord("beta", 6000), 2),
        buildMessage("msg-user-2", "user", sessionID, repeatedWord("gamma", 6000), 3),
    ]
    const state = createSessionState()
    const config = buildConfig()
    config.compress.protectUserMessages = true

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-user-2")

    const compressionPriorities = buildPriorityMap(config, state, messages)

    applyAnchoredNudges(
        state,
        config,
        messages,
        {
            system: "",
            compressRange: "",
            compressMessage: "",
            contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
            turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
            iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
        },
        compressionPriorities,
    )

    const injectedNudge = messages[2]?.parts[0]
    assert.equal(injectedNudge?.type, "text")
    assert.match((injectedNudge as any).text, /High-priority message IDs before this point: m0002/)
    assert.doesNotMatch((injectedNudge as any).text, /m0001/)
})

test("range-mode nudges append to existing text parts before tool outputs", () => {
    const sessionID = "ses_range_nudge_injection"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("alpha", 6000), 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part", "Working summary."),
                toolPart("msg-assistant-1", sessionID, "call-task-2", "task", "task output body"),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.prune.messages.activeBlockIds.add(7)
    state.nudges.contextLimitAnchors.add("msg-assistant-1")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
        turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
        iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
    })

    assert.equal(messages[1]?.parts.length, 2)

    const injectedNudge = messages[1]?.parts[0]
    const toolOutput = messages[1]?.parts[1]
    assert.equal(injectedNudge?.type, "text")
    assert.equal(toolOutput?.type, "tool")
    assert.match((injectedNudge as any).text, /\n\n<dcp-system-reminder>Base context nudge/)
    assert.match((injectedNudge as any).text, /Compressed block context:/)
    assert.match((injectedNudge as any).text, /Active compressed blocks in this session: 1 \(b7\)/)
    assert.equal((toolOutput as any).state.output, "task output body")
})

test("range-mode nudges inject only once for assistant messages with multiple text parts", () => {
    const sessionID = "ses_range_nudge_multi_text"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "assistant-text-1", "First chunk."),
                textPart("msg-assistant-1", sessionID, "assistant-text-2", "Second chunk."),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-assistant-1")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
        turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
        iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
    })

    assert.match((messages[1]?.parts[0] as any).text, /Base context nudge/)
    assert.doesNotMatch((messages[1]?.parts[1] as any).text, /Base context nudge/)
})

test("range-mode nudges skip empty assistant messages to avoid prefill (issue #463)", () => {
    const sessionID = "ses_range_nudge_empty_assistant"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-empty",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-assistant-empty")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
        turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
        iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
    })

    assert.equal(messages[1]?.parts.length, 0)
})

test("range-mode nudges skip assistant with only pending tool parts (issue #463)", () => {
    const sessionID = "ses_range_nudge_pending_tool"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-pending",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                {
                    id: "pending-tool-part",
                    messageID: "msg-assistant-pending",
                    sessionID,
                    type: "tool" as const,
                    tool: "bash",
                    callID: "call-pending-1",
                    state: {
                        status: "pending" as const,
                        input: { command: "ls" },
                    },
                } as any,
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-assistant-pending")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
        turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
        iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
    })

    assert.equal(messages[1]?.parts.length, 1)
    assert.equal(messages[1]?.parts[0]?.type, "tool")
})

test("range-mode nudges skip assistant messages with only empty text parts (issue #463)", () => {
    const sessionID = "ses_range_nudge_empty_text"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-empty-text",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-empty-text", sessionID, "empty-text-part", "")],
        },
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-assistant-empty-text")

    applyAnchoredNudges(state, config, messages, {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "",
        turnNudge: "",
        iterationNudge: "",
    })

    // Empty text parts should not receive nudge injection
    assert.equal(messages[1]?.parts.length, 1)
    assert.equal((messages[1]?.parts[0] as any).text, "")
})

test("message-mode rendered compressed summaries mark block IDs as BLOCKED", () => {
    const sessionID = "ses_message_blocked_blocks"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Original request", 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, "Follow-up", 2),
    ]
    const state = createSessionState()
    const config = buildConfig("message")
    const logger = new Logger(false)

    state.prune.messages.byMessageId.set("msg-user-1", {
        tokenCount: 20,
        allBlockIds: [7],
        activeBlockIds: [7],
    })
    state.prune.messages.blocksById.set(7, {
        blockId: 7,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        mode: "range",
        topic: "Earlier notes",
        batchTopic: "Earlier notes",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-user-1",
        compressMessageId: "msg-origin",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-user-1"],
        directToolIds: [],
        effectiveMessageIds: ["msg-user-1"],
        effectiveToolIds: [],
        createdAt: 1,
        summary:
            "[Compressed conversation section]\nEarlier summary\n\n<dcp-message-id>b7</dcp-message-id>",
    })
    state.prune.messages.activeBlockIds.add(7)
    state.prune.messages.activeByAnchorMessageId.set("msg-user-1", 7)

    prune(state, logger, config, messages)

    const summaryText = (messages[0]?.parts[0] as any)?.text || ""
    assert.match(summaryText, /<dcp-message-id>BLOCKED<\/dcp-message-id>/)
    assert.doesNotMatch(summaryText, /<dcp-message-id>b7<\/dcp-message-id>/)
})

test("range-mode rendered compressed summaries keep block IDs", () => {
    const sessionID = "ses_range_visible_blocks"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Original request", 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, "Follow-up", 2),
    ]
    const state = createSessionState()
    const config = buildConfig("range")
    const logger = new Logger(false)

    state.prune.messages.byMessageId.set("msg-user-1", {
        tokenCount: 20,
        allBlockIds: [7],
        activeBlockIds: [7],
    })
    state.prune.messages.blocksById.set(7, {
        blockId: 7,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        mode: "range",
        topic: "Earlier notes",
        batchTopic: "Earlier notes",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-user-1",
        compressMessageId: "msg-origin",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-user-1"],
        directToolIds: [],
        effectiveMessageIds: ["msg-user-1"],
        effectiveToolIds: [],
        createdAt: 1,
        summary:
            "[Compressed conversation section]\nEarlier summary\n\n<dcp-message-id>b7</dcp-message-id>",
    })
    state.prune.messages.activeBlockIds.add(7)
    state.prune.messages.activeByAnchorMessageId.set("msg-user-1", 7)

    prune(state, logger, config, messages)

    const summaryText = (messages[0]?.parts[0] as any)?.text || ""
    assert.match(summaryText, /<dcp-message-id>b7<\/dcp-message-id>/)
    assert.doesNotMatch(summaryText, /<dcp-message-id>BLOCKED<\/dcp-message-id>/)
})

test("hallucination stripping removes all dcp-prefixed XML tags including variants", async () => {
    const text =
        "alpha" +
        '<dcp-message-id priority="low">m0008</dcp-message-id>' +
        '<dcp-message-id-extra priority="high">m0008</dcp-message-id-extra>' +
        "<dcp-system-reminder>strip this</dcp-system-reminder>" +
        "<dcp-system-reminder-extra>strip this too</dcp-system-reminder-extra>" +
        "omega"

    assert.equal(stripHallucinationsFromString(text), "alphaomega")

    const handler = createTextCompleteHandler()
    const output = { text }
    await handler({ sessionID: "session", messageID: "message", partID: "part" }, output)
    assert.equal(output.text, "alphaomega")
})

test("hallucination stripping removes colon and underscore dcp tag variants", async () => {
    assert.equal(stripHallucinationsFromString("beforeafter"), "beforeafter")
    assert.equal(stripHallucinationsFromString("startend"), "startend")
})

test("hallucination stripping removes orphan opening tags", async () => {
    assert.equal(
        stripHallucinationsFromString("narration\n\n<dcp:function_calls>\n\n"),
        "narration\n\n\n\n",
    )
    assert.equal(stripHallucinationsFromString('text <dcp:invoke name="edit"> more'), "text  more")
})

test("hallucination stripping removes orphan closing tags", async () => {
    assert.equal(stripHallucinationsFromString("text</dcp:function_calls> more"), "text more")
    assert.equal(stripHallucinationsFromString("before</dcp-message-id>after"), "beforeafter")
})

test("hallucination stripping handles nested dcp tags", async () => {
    assert.equal(
        stripHallucinationsFromString(
            'before<dcp:function_calls>\n<dcp:invoke name="edit">content</dcp:invoke>\n</dcp:function_calls>after',
        ),
        "before\nafter",
    )
})

test("hallucination stripping handles mixed paired and orphan tags", async () => {
    assert.equal(
        stripHallucinationsFromString(
            'text\n<dcp-message-id priority="low">m0045</dcp-message-id>\n<dcp:function_calls>\n',
        ),
        "text\n\n\n",
    )
})

test("hallucination stripping does not affect non-dcp tags", async () => {
    assert.equal(
        stripHallucinationsFromString("<div>hello</div> <system-reminder>keep</system-reminder>"),
        "<div>hello</div> <system-reminder>keep</system-reminder>",
    )
})

test("injectMessageIds skips empty assistant messages to avoid prefill (issue #463)", () => {
    const sessionID = "ses_empty_assistant"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-empty",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [],
        },
        buildMessage("msg-user-2", "user", sessionID, "continue", 3),
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    injectMessageIds(state, config, messages)

    const emptyAssistant = messages[1]!
    assert.equal(emptyAssistant.parts.length, 0, "empty assistant should get no synthetic parts")
})

test("injectMessageIds skips assistant with only pending tool parts (issue #463)", () => {
    const sessionID = "ses_pending_tool_assistant"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-pending",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                {
                    id: "pending-tool-part",
                    messageID: "msg-assistant-pending",
                    sessionID,
                    type: "tool" as const,
                    tool: "bash",
                    callID: "call-pending-1",
                    state: {
                        status: "pending" as const,
                        input: { command: "ls" },
                    },
                } as any,
            ],
        },
        buildMessage("msg-user-2", "user", sessionID, "continue", 3),
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    injectMessageIds(state, config, messages)

    const pendingAssistant = messages[1]!
    assert.equal(
        pendingAssistant.parts.length,
        1,
        "assistant with only pending tools should not get a synthetic text part",
    )
    assert.equal(pendingAssistant.parts[0]!.type, "tool")
})

test("injectMessageIds skips assistant with empty text part (issue #463)", () => {
    const sessionID = "ses_empty_text_assistant"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-empty-text",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-empty-text", sessionID, "empty-text-part", "")],
        },
        buildMessage("msg-user-2", "user", sessionID, "continue", 3),
    ]
    const state = createSessionState()
    const config = buildConfig("range")

    assignMessageRefs(state, messages)
    injectMessageIds(state, config, messages)

    const emptyTextAssistant = messages[1]!
    assert.equal(emptyTextAssistant.parts.length, 1, "should not add a synthetic part")
    assert.equal(
        (emptyTextAssistant.parts[0] as any).text,
        "",
        "empty text part should remain untouched",
    )
})

test("applyAnchoredNudges is idempotent — message nudged at most once per session", () => {
    const sessionID = "ses_nudge_idempotent"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, repeatedWord("alpha", 6000), 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, repeatedWord("beta", 6000), 2),
        buildMessage("msg-user-2", "user", sessionID, repeatedWord("gamma", 6000), 3),
    ]
    const state = createSessionState()
    const config = buildConfig()

    assignMessageRefs(state, messages)
    state.nudges.contextLimitAnchors.add("msg-user-2")

    const prompts = {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "<dcp-system-reminder>Base context nudge</dcp-system-reminder>",
        turnNudge: "<dcp-system-reminder>Base turn nudge</dcp-system-reminder>",
        iterationNudge: "<dcp-system-reminder>Base iteration nudge</dcp-system-reminder>",
    }

    const compressionPriorities = buildPriorityMap(config, state, messages)

    // First invocation — nudge should be injected
    applyAnchoredNudges(state, config, messages, prompts, compressionPriorities)

    const firstText = (messages[2]?.parts[0] as any).text
    assert.match(firstText, /Base context nudge/, "first invocation should inject nudge")

    // Count how many times the nudge appears after first invocation
    const firstMatches = firstText.match(/Base context nudge/g)
    const firstCount = firstMatches ? firstMatches.length : 0

    // Second invocation — should NOT inject again
    applyAnchoredNudges(state, config, messages, prompts, compressionPriorities)

    const secondText = (messages[2]?.parts[0] as any).text
    const secondMatches = secondText.match(/Base context nudge/g)
    const secondCount = secondMatches ? secondMatches.length : 0

    assert.equal(
        secondCount,
        firstCount,
        "second invocation must not add additional nudge text",
    )

    // The message ID should be tracked
    assert.ok(
        state.nudges.nudgedMessageIds.has("msg-user-2"),
        "nudged message ID should be tracked",
    )
})

test("injectMessageIds produces stable tags across invocations — no priority attribute (DCP cache stability)", () => {
    const sessionID = "ses_stable_tags"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        buildMessage("msg-assistant-1", "assistant", sessionID, "Hi there", 2),
    ]
    const state = createSessionState()
    const config = buildConfig()

    assignMessageRefs(state, messages)

    // First invocation
    injectMessageIds(state, config, messages)
    const firstTag = (messages[0]?.parts[0] as any).text

    // Reset parts to original text and re-inject (simulating a second LLM request)
    messages[0]!.parts = [textPart("msg-user-1", sessionID, "msg-user-1-part", "Hello")]
    messages[1]!.parts = [textPart("msg-assistant-1", sessionID, "msg-assistant-1-part", "Hi there")]

    // Second invocation — tag must be identical
    injectMessageIds(state, config, messages)
    const secondTag = (messages[0]?.parts[0] as any).text

    // Tags must be identical across invocations
    assert.equal(firstTag, secondTag, "tags must be identical across invocations")

    // No priority attribute in the tag — it would cause cache invalidation
    assert.doesNotMatch(firstTag, /priority=/, "tag must not contain priority attribute")

    // Tag format: <dcp-message-id>m0001</dcp-message-id> (no attributes)
    assert.match(firstTag, /<dcp-message-id>m0001<\/dcp-message-id>/)
})

// --- Idempotent Prune Tests ---

const PRUNED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]"
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"
const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"

function toolPartWithStatus(
    messageID: string,
    sessionID: string,
    callID: string,
    toolName: string,
    output: string,
    status: "completed" | "error",
    input: Record<string, unknown> = { description: "demo" },
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool: toolName,
        callID,
        state: {
            status,
            input,
            output: status === "completed" ? output : undefined,
        },
    }
}

test("prune is idempotent — running twice produces identical output", () => {
    const sessionID = "ses_prune_idempotent"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID, "Hello", 1),
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "msg-assistant-1-part", "Working..."),
                toolPartWithStatus(
                    "msg-assistant-1",
                    sessionID,
                    "call-bash-1",
                    "bash",
                    "original output content",
                    "completed",
                    { command: "ls" },
                ),
                toolPartWithStatus(
                    "msg-assistant-1",
                    sessionID,
                    "call-question-1",
                    "question",
                    "user answered",
                    "completed",
                    { questions: "What would you like to do?" },
                ),
                toolPartWithStatus(
                    "msg-assistant-1",
                    sessionID,
                    "call-failed-1",
                    "bash",
                    undefined,
                    "error",
                    { command: "failing command", filePath: "/some/path" },
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig()
    const logger = new Logger(false)

    // Mark all callIDs for pruning
    state.prune.tools.set("call-bash-1", 1)
    state.prune.tools.set("call-question-1", 2)
    state.prune.tools.set("call-failed-1", 3)

    // First prune
    prune(state, logger, config, messages)

    // Capture state after first prune
    const afterFirst = JSON.parse(JSON.stringify(messages))

    // Second prune — should produce identical output
    prune(state, logger, config, messages)

    const afterSecond = JSON.parse(JSON.stringify(messages))

    assert.deepStrictEqual(
        afterFirst,
        afterSecond,
        "prune must be idempotent — second run produces identical output",
    )

    // Verify the actual replacements happened
    const assistantMsg = afterSecond[1]
    const bashPart = assistantMsg.parts[1]
    const questionPart = assistantMsg.parts[2]
    const failedPart = assistantMsg.parts[3]

    assert.equal(
        bashPart.state.output,
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
        "tool output must be pruned",
    )
    assert.equal(
        questionPart.state.input.questions,
        PRUNED_QUESTION_INPUT_REPLACEMENT,
        "question input must be pruned",
    )
    assert.equal(
        failedPart.state.input.command,
        PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
        "error tool input must be pruned",
    )
    assert.equal(
        failedPart.state.input.filePath,
        PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
        "error tool filePath must be pruned",
    )
})

test("pruneToolOutputs skips already-pruned output — no re-assignment", () => {
    const sessionID = "ses_prune_output_skip"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                toolPartWithStatus(
                    "msg-assistant-1",
                    sessionID,
                    "call-bash-1",
                    "bash",
                    PRUNED_TOOL_OUTPUT_REPLACEMENT,
                    "completed",
                    { command: "ls" },
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig()
    const logger = new Logger(false)

    state.prune.tools.set("call-bash-1", 1)

    // The output is already the pruned replacement — prune should skip it
    prune(state, logger, config, messages)

    // Output should still be the placeholder (unchanged)
    const output = (messages[0]?.parts[0] as any).state.output
    assert.equal(output, PRUNED_TOOL_OUTPUT_REPLACEMENT)
})

test("pruneToolInputs skips already-pruned question input — no re-assignment", () => {
    const sessionID = "ses_prune_question_skip"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                toolPartWithStatus(
                    "msg-assistant-1",
                    sessionID,
                    "call-question-1",
                    "question",
                    "user answered",
                    "completed",
                    { questions: PRUNED_QUESTION_INPUT_REPLACEMENT },
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig()
    const logger = new Logger(false)

    state.prune.tools.set("call-question-1", 1)

    // The questions field is already the pruned replacement — prune should skip it
    prune(state, logger, config, messages)

    const questions = (messages[0]?.parts[0] as any).state.input.questions
    assert.equal(questions, PRUNED_QUESTION_INPUT_REPLACEMENT)
})

test("pruneToolErrors skips already-pruned error inputs — no re-assignment", () => {
    const sessionID = "ses_prune_error_skip"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                toolPartWithStatus(
                    "msg-assistant-1",
                    sessionID,
                    "call-failed-1",
                    "bash",
                    undefined,
                    "error",
                    {
                        command: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
                        filePath: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
                    },
                ),
            ],
        },
    ]
    const state = createSessionState()
    const config = buildConfig()
    const logger = new Logger(false)

    state.prune.tools.set("call-failed-1", 1)

    // All string inputs are already the pruned replacement — prune should skip them
    prune(state, logger, config, messages)

    const input = (messages[0]?.parts[0] as any).state.input
    assert.equal(input.command, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT)
    assert.equal(input.filePath, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT)
})
