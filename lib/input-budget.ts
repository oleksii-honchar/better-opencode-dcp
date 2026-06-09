/**
 * Compute the input token budget for a model — the value DCP percentage
 * thresholds (`maxContextLimit`, `minContextLimit`) should resolve against.
 *
 * Two cases:
 *   1. `limit.input` defined (OpenAI GPT-5 line):
 *      use it directly. The provider enforces it as a hard input ceiling.
 *   2. `limit.input` undefined (shared-pool models):
 *      subtract `limit.output` from `limit.context`.
 *      This guarantees `input + worst-case output ≤ limit.context`.
 */
export function computeInputBudget(limit: {
    context: number
    input?: number
    output?: number
}): number {
    if (!limit.context) return 0
    return limit.input ?? Math.max(0, limit.context - (limit.output ?? 0))
}
