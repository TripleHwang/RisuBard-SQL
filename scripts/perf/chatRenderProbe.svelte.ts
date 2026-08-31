/**
 * Reactive fixtures for `measure-chat-render.bench.ts`.
 *
 * Separate because it needs runes: the chat screen is handed `chat.message`,
 * which in the app is a `$state` proxy that storage splices pages into. A plain
 * array would let the component mount and then never re-render, and a
 * measurement of a component that does not re-render is a measurement of
 * nothing.
 */
export function reactiveMessages(count: number): any[] {
    const messages = $state(Array.from({ length: count }, (_, index) => ({
        chatId: `m-${index}`,
        role: index % 2 === 0 ? 'user' : 'char',
        data: `메시지 ${index} 입니다. 이것은 한국어 본문입니다.`,
    })))
    return messages
}
