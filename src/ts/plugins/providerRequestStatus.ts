import type { PluginV2ProviderOptions } from './plugins.svelte'

export function bindPluginRequestStatusStorage(
    options: PluginV2ProviderOptions | undefined,
    getItem: (key: string) => unknown,
): PluginV2ProviderOptions {
    const bound = options ?? {}
    const key = bound.hostRequestStatusStorageKey
    return key ? {
        ...bound,
        hostRequestStatus: () => getItem(key) === 'risubard',
    } : bound
}

export function resolvePluginRequestStatus(options: PluginV2ProviderOptions | undefined): boolean {
    try {
        return typeof options?.hostRequestStatus === 'function'
            ? options.hostRequestStatus() === true
            : options?.hostRequestStatus === true
    } catch {
        return false
    }
}
