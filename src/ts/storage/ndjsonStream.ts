export function createIncrementalNdjsonParser(onValue: (value: unknown) => void) {
    let parsedIndex = 0
    let leftover = ''
    const parse = (line: string) => {
        if (!line.trim()) return
        try { onValue(JSON.parse(line)) } catch { /* malformed server event */ }
    }
    return {
        drain(responseText: string, final = false) {
            if (responseText.length > parsedIndex) {
                leftover += responseText.slice(parsedIndex)
                parsedIndex = responseText.length
            }
            let newline: number
            while ((newline = leftover.indexOf('\n')) >= 0) {
                parse(leftover.slice(0, newline))
                leftover = leftover.slice(newline + 1)
            }
            if (final && leftover) { parse(leftover); leftover = '' }
        },
        bufferedCharacters() { return leftover.length },
    }
}
