import type {
    recordRequestLog,
    RequestLogSource,
} from 'src/ts/requestLog'
import type { RequestPurpose } from 'src/ts/requestPurpose'
import type { RequestInjectionManifest } from 'src/ts/status/requestStatus'

interface PluginRequestEvidenceInput {
    startedAt: number
    source: RequestLogSource
    purpose?: RequestPurpose
    sessionChatId?: string
    generationId: string
    model: string
    provider: string
    injectionManifest?: RequestInjectionManifest
}

interface PluginRequestEvidenceFinish {
    success: boolean
    aborted?: boolean
    streaming: boolean
    output?: string
    errorMessage?: string
}

interface PluginRequestEvidenceDependencies {
    now?(): number
    countTokens(text: string): Promise<number>
    record(entry: Parameters<typeof recordRequestLog>[0]): void
}

export function createPluginRequestEvidenceRecorder(
    input: PluginRequestEvidenceInput,
    dependencies: PluginRequestEvidenceDependencies,
) {
    const now = dependencies.now ?? (() => Date.now())
    const record = dependencies.record
    let firstTokenAt: number | undefined
    let finished = false
    return {
        markFirstToken(timestamp = now()) {
            firstTokenAt ??= timestamp
        },
        async finish(result: PluginRequestEvidenceFinish): Promise<void> {
            if (finished) return
            finished = true
            let outputTokens: number | undefined
            if (result.output) {
                try {
                    outputTokens = await dependencies.countTokens(result.output)
                } catch {
                    // Evidence collection must never affect the provider result.
                }
            }
            record({
                timestamp: input.startedAt,
                category: 'llm',
                source: input.source,
                purpose: input.purpose,
                chatId: input.generationId,
                sessionChatId: input.sessionChatId,
                generationId: input.generationId,
                model: input.model,
                provider: input.provider,
                url: `plugin://${encodeURIComponent(input.provider)}`,
                method: 'PLUGIN',
                success: result.success,
                aborted: result.aborted,
                streaming: result.streaming,
                durationMs: Math.max(0, now() - input.startedAt),
                ...(firstTokenAt === undefined ? {} : {
                    firstTokenMs: Math.max(0, firstTokenAt - input.startedAt),
                }),
                inputTokens: input.injectionManifest?.totalTokens,
                outputTokens,
                injectionManifest: input.injectionManifest,
                errorMessage: result.errorMessage,
            })
        },
    }
}
