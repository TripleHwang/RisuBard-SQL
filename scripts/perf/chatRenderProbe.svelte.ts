/**
 * Reactive fixtures for `measure-chat-render.bench.ts`.
 *
 * Separate because it needs runes: the chat screen is handed `chat.message`,
 * which in the app is a `$state` proxy that storage splices pages into. A plain
 * array would let the component mount and then never re-render, and a
 * measurement of a component that does not re-render is a measurement of
 * nothing.
 */
import { koreanText } from './koreanFixture'

export function reactiveMessages(count: number): any[] {
    const messages = $state(Array.from({ length: count }, (_, index) => ({
        chatId: `m-${index}`,
        role: index % 2 === 0 ? 'user' : 'char',
        data: `메시지 ${index} 입니다. 이것은 한국어 본문입니다.`,
    })))
    return messages
}

/**
 * The same, with bodies the length a real chat carries. `syllables` is Hangul
 * characters per message, so the fixture is two-byte in memory and off
 * `JSON.stringify`'s one-byte fast path -- which is the part an ASCII benchmark
 * cannot see.
 */
export function reactiveKoreanMessages(count: number, syllables: number): any[] {
    // Deterministic, so two runs of the same size are comparable.
    let seed = 20_260_904
    const random = () => {
        seed ^= seed << 13; seed >>>= 0
        seed ^= seed >>> 17
        seed ^= seed << 5; seed >>>= 0
        return seed / 0x1_0000_0000
    }
    const messages = $state(Array.from({ length: count }, (_, index) => ({
        chatId: `m-${index}`,
        role: index % 2 === 0 ? 'user' : 'char',
        data: koreanText(syllables, random),
        time: 1_700_000_000_000 + index * 60_000,
        ...(index % 2 ? {
            generationInfo: {
                model: 'claude-sonnet-4', generationId: `gen-${index}`,
                inputTokens: 4_000 + index, outputTokens: 300 + (index % 200), maxContext: 200_000,
            },
        } : {}),
    })))
    return messages
}
