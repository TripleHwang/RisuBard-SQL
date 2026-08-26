export function isFirstMessageStudioManagedImage(image: Element): boolean {
    return Boolean(image.closest('[data-first-message-studio-compatible], [data-first-message-studio-chat]'))
}

export function clearGenericChatImageStyles(image: Element): void {
    for (const className of [...image.classList]) {
        if (className === 'root-loaded-image' || className.startsWith('root-loaded-image-')) {
            image.classList.remove(className)
        }
    }
}

/**
 * Share asset URL work between the mounted chat rows.  A chat page can mount
 * 40/60 messages at once, so resolving the same module image in every row
 * would otherwise repeatedly enter the storage/service-worker path.
 *
 * Successful URLs are safe to retain: asset paths are content-addressed in
 * normal saves.  Failed lookups are deliberately not cached so a transient
 * storage/service-worker failure can be retried on the next render.
 */
export function createChatAssetUrlResolver(load: (path: string) => Promise<string>) {
    const urls = new Map<string, Promise<string>>()

    return (path: string): Promise<string> => {
        const existing = urls.get(path)
        if (existing) return existing

        const result = load(path).then(
            (url) => {
                if (!url) urls.delete(path)
                return url
            },
            (error) => {
                urls.delete(path)
                throw error
            },
        )
        urls.set(path, result)
        return result
    }
}

/** True only while an async resolution still belongs to this image request. */
export function canApplyResolvedChatImage(image: HTMLImageElement, requestedSrc: string): boolean {
    return image.getAttribute('src')?.toLocaleLowerCase() === requestedSrc
}
