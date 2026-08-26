export const LIMITS = Object.freeze({
    firstInteractiveMedianMs: 5_000,
    firstInteractiveP95Ms: 8_000,
    chatSelectionP95Ms: 1_500,
    renderBatchP95Ms: 50,
    longTasksOver100MsPerMinute: 2,
    hydratedChats: 2,
    mountedMessages: 60,
})

function sorted(values) {
    return values.filter(Number.isFinite).sort((left, right) => left - right)
}

export function percentile95(values) {
    const list = sorted(values)
    return list[Math.max(0, Math.ceil(list.length * 0.95) - 1)] ?? 0
}

export function median(values) {
    const list = sorted(values)
    const middle = Math.floor(list.length / 2)
    return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2
}

function samples(report, name) {
    return Array.isArray(report?.durations?.[name]) ? report.durations[name] : []
}

export function evaluatePerformanceReport(report) {
    const failures = []
    if (report?.schemaVersion !== 1) failures.push('unsupported performance-report schema')
    const firstInteractive = samples(report, 'first-interactive')
    const chatSelection = samples(report, 'chat-selection')
    const renderBatch = samples(report, 'render-batch')
    const resources = Array.isArray(report?.resources) ? report.resources : []
    if (!firstInteractive.length) failures.push('missing first-interactive samples')
    if (!chatSelection.length) failures.push('missing chat-selection samples')
    if (!renderBatch.length) failures.push('missing render-batch samples')
    if (!resources.length) failures.push('missing resource samples')
    const longTasks = samples(report, 'long-task').filter((value) => Number.isFinite(value) && value > 100)
    if (firstInteractive.length && median(firstInteractive) > LIMITS.firstInteractiveMedianMs) failures.push('first-interactive median exceeds limit')
    if (firstInteractive.length && percentile95(firstInteractive) > LIMITS.firstInteractiveP95Ms) failures.push('first-interactive p95 exceeds limit')
    if (chatSelection.length && percentile95(chatSelection) > LIMITS.chatSelectionP95Ms) failures.push('chat-selection p95 exceeds limit')
    if (renderBatch.length && percentile95(renderBatch) > LIMITS.renderBatchP95Ms) failures.push('render-batch p95 exceeds limit')
    const minutes = Math.max(1, Number(report?.sessionDurationMs) / 60_000)
    if (longTasks.length / minutes > LIMITS.longTasksOver100MsPerMinute) failures.push('long-task rate exceeds limit')
    for (const resource of resources) {
        if (Number(resource?.hydratedChats) > LIMITS.hydratedChats) failures.push('hydratedChats exceeds limit')
        if (Number(resource?.mountedMessages) > LIMITS.mountedMessages) failures.push('mountedMessages exceeds limit')
    }
    return { ok: failures.length === 0, failures }
}

if (import.meta.main) {
    const reportPath = process.argv[2]
    if (!reportPath) throw new Error('Usage: node scripts/perf/check-performance-report.mjs <content-free-report.json>')
    const result = evaluatePerformanceReport(JSON.parse(await (await import('node:fs/promises')).readFile(reportPath, 'utf8')))
    if (!result.ok) {
        process.stderr.write(`${result.failures.join('\n')}\n`)
        process.exitCode = 1
    }
}
