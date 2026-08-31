/**
 * The same-device single-writer handoff, as a state machine with no DOM in it.
 *
 * Two tabs on one device coordinate over a `BroadcastChannel`: whoever writes
 * says so, and a tab that hears somebody else write surrenders -- it stops
 * being the writer, tells the user, and reloads.
 *
 * The part worth isolating is the one rule that is easy to lose when the
 * protocol is spread across a channel callback, an event listener and a commit
 * hook: **a tab that has surrendered must never announce again.** In the legacy
 * path that rule was implicit in control flow, because the surrender check and
 * the channel post lived three lines apart in `triggerSave`:
 *
 *     if (gotChannel) { await sleep(1000); return 'noop' }   // surrendered: no write
 *     if (channel && !skipBroadcast) channel.postMessage(sessionID)
 *
 * Wire the announcement to a different trigger -- "every commit that reached
 * storage", which is what SQL mode has -- and the two come apart. Then the tab
 * that just surrendered keeps announcing its own commits, the tab it
 * surrendered TO hears them and surrenders in turn, and one edit evicts both
 * tabs instead of one. Keeping the flag and the announcement in the same object
 * is what makes that impossible rather than merely fixed.
 */
export interface WriterHandoff {
  /** True once another tab or device has taken over writing. */
  readonly surrendered: boolean
  /** A message from the channel. Own-session messages are ignored. */
  receive(data: unknown): void
  /** Give up the writer role for a reason other than the channel (e.g. HTTP 423). */
  surrender(): void
  /**
   * Announce a local write, unless this tab has already surrendered.
   * `post` is called with this session's id at most once per call.
   */
  announce(post: (sessionId: string) => void): void
}

export function createWriterHandoff(
  sessionId: string,
  onSurrender: () => void,
): WriterHandoff {
  let surrendered = false

  const give = () => {
    // Surrender exactly once: `onSurrender` shows a blocking modal and reloads,
    // and both the channel and the 423 listener can fire repeatedly.
    if (surrendered) return
    surrendered = true
    onSurrender()
  }

  return {
    get surrendered() {
      return surrendered
    },
    receive(data: unknown) {
      if (data === sessionId) return
      give()
    },
    surrender: give,
    announce(post: (sessionId: string) => void) {
      if (surrendered) return
      post(sessionId)
    },
  }
}
