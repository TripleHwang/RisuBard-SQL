export function invokeBrowserFetch(
    fetchImpl: typeof fetch,
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> {
    return Reflect.apply(fetchImpl, globalThis, [input, init])
}
