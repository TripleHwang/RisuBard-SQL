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
