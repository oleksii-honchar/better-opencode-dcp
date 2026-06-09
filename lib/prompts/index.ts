import type { RuntimePrompts } from "./store"
export type { PromptStore, RuntimePrompts } from "./store"

export function renderSystemPrompt(
    prompts: RuntimePrompts,
    protectedToolsExtension?: string,
    manual?: boolean,
    subagent?: boolean,
    overMinLimit?: boolean,
): string {
    const extensions: string[] = []

    if (protectedToolsExtension) {
        extensions.push(protectedToolsExtension.trim())
    }

    if (manual) {
        extensions.push(prompts.manualExtension.trim())
    }

    if (subagent) {
        extensions.push(prompts.subagentExtension.trim())
    }

    // Add below-threshold extension when explicitly below the minimum
    if (overMinLimit !== undefined && !overMinLimit) {
        extensions.push(prompts.belowThresholdExtension.trim())
    }

    return [prompts.system.trim(), ...extensions]
        .filter(Boolean)
        .join("\n\n")
        .replace(/\n([ \t]*\n)+/g, "\n\n")
        .trim()
}
