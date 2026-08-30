/**
 * Which message rows are currently mounted on screen.
 *
 * `Chats.svelte` mounts message components imperatively, keyed by
 * `message.chatId`, and the screen the user is looking at *is* that set of
 * mounted rows. Storage-side residency trimming therefore cannot choose what to
 * release from array indexes alone: an index says where a message sits in the
 * resident slice, not whether a component is currently drawing it. Releasing a
 * mounted row leaves a hole in the conversation that nothing repaints.
 *
 * So the view publishes what it has mounted and the trimmer reads it. This is a
 * one-way channel: nothing here mutates a chat, and an empty registry means
 * "no chat screen is mounted", which is the honest answer during tests, on
 * other screens, and before the first render.
 *
 * Publishers are keyed by an opaque token so two live screens cannot clobber
 * each other's set, and so one screen being destroyed cannot retract another's
 * rows. `isMessageMounted` answers over the union of every publisher.
 */

const publishers = new Map<object, ReadonlySet<string>>();

/**
 * Record the rows one screen currently has mounted.
 *
 * The set is copied: the caller's collection keeps changing as it mounts and
 * sweeps rows, and a trimmer reading a half-updated set would be reading a
 * screen state that was never on screen.
 */
export function publishMountedMessageIds(token: object, ids: Iterable<string>): void {
    publishers.set(token, new Set(ids));
}

/**
 * Drop one screen's published rows. Call on destroy; a screen that is gone is
 * not holding anything on screen, and leaving its ids behind would pin
 * messages resident for the rest of the session.
 */
export function releaseMountedMessageIds(token: object): void {
    publishers.delete(token);
}

/** True when some mounted screen is currently drawing this message. */
export function isMessageMounted(id: string | null | undefined): boolean {
    if (!id) return false;
    for (const ids of publishers.values()) if (ids.has(id)) return true;
    return false;
}

/** Total distinct rows mounted across every screen. Diagnostics and tests only. */
export function getMountedMessageCount(): number {
    const union = new Set<string>();
    for (const ids of publishers.values()) for (const id of ids) union.add(id);
    return union.size;
}

/** Test-only reset; production code releases per screen on destroy. */
export function resetMountedMessageRegistryForTesting(): void {
    publishers.clear();
}
