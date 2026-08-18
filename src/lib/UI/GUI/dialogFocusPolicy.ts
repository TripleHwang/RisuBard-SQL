let lastInteractionWasKeyboard = true

if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', () => {
        lastInteractionWasKeyboard = false
    }, true)
    window.addEventListener('keydown', () => {
        lastInteractionWasKeyboard = true
    }, true)
}

export function handleDialogCloseAutoFocus(event: Event): void {
    if (!lastInteractionWasKeyboard) {
        event.preventDefault()
    }
}
