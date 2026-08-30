/**
 * Two different questions about a hydration in progress, deliberately kept
 * apart.
 *
 * `inFlight` spans the whole operation, request included. It is what holds
 * eviction off: a chat whose page is still in the air must not have its slot
 * replaced under the fetch.
 *
 * `justApplied` spans only the stretch in which hydration is writing what it
 * fetched into the live objects -- the splice and the tick that settles it. It
 * is what stops hydration's own writes from being read back as user edits.
 *
 * Conflating the two is what turned a page load into silent data loss. Dirty
 * marking asked `isHydrationActive`, which is true for the whole request, and
 * dropped every mark made while it was true. But during the request hydration
 * has not touched the chat at all -- the chat is exactly as the user left it --
 * so there is nothing there to protect, and the only marks in that window are
 * genuine user edits. A reply that arrived while an older page was being
 * fetched lost its mark, was never committed, and was gone on the next load,
 * with nothing logged. Suppression must read {@link isHydrationApplying}, never
 * {@link isHydrationActive}.
 */
const inFlight = new Map<string, number>();
const justApplied = new Map<string, number>();

/**
 * Work parked because hydration was mid-apply when it was requested.
 *
 * Parked, not dropped. Nothing in hydration marks anything dirty, so every
 * action that lands here belongs to some other caller -- a message being
 * edited, a reply arriving -- and running it a moment later is right where
 * dropping it is silent loss. The apply window is one synchronous splice plus a
 * tick, so the delay is not observable.
 *
 * Each entry carries the condition that parked it rather than waiting on the
 * whole map. Parking a chat's mark behind an unrelated chat's apply window
 * would hide it from `isSqlMessageDirty`, and that predicate is what residency
 * trimming and `loadNewestChatMessages` ask before releasing a message from
 * memory -- a mark invisible there is an edit released and never written.
 */
type DeferredApply = { blocked: () => boolean; action: () => void };
const deferredUntilApplied: DeferredApply[] = [];

export function beginHydration(key: string): void {
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
}

export function endHydration(key: string): void {
  const remaining = (inFlight.get(key) ?? 1) - 1;
  if (remaining > 0) inFlight.set(key, remaining);
  else inFlight.delete(key);
}

export function beginHydrationApply(key: string): void {
  justApplied.set(key, (justApplied.get(key) ?? 0) + 1);
}

export function endHydrationApply(key: string): void {
  const remaining = (justApplied.get(key) ?? 1) - 1;
  if (remaining > 0) justApplied.set(key, remaining);
  else justApplied.delete(key);
  drainDeferredApplies();
}

export function isHydrationActive(key: string): boolean {
  return inFlight.has(key) || justApplied.has(key);
}

/** Message mutation APIs carry a chat id, while hydration owns character/chat keys. */
export function isChatHydrationActive(chatId: string): boolean {
  const suffix = `/${chatId}`;
  return [...inFlight.keys(), ...justApplied.keys()].some(key => key.endsWith(suffix));
}

/**
 * True only while hydration is writing fetched data into the live objects.
 *
 * This -- not {@link isHydrationActive} -- is the window in which a write to a
 * chat may have come from hydration itself. Callers that suppress on it must
 * defer rather than discard; see {@link deferUntilHydrationApplied}.
 */
export function isHydrationApplying(key: string): boolean {
  return justApplied.has(key);
}

/** Chat-id form of {@link isHydrationApplying}, for the message mutation APIs. */
export function isChatHydrationApplying(chatId: string): boolean {
  const suffix = `/${chatId}`;
  return [...justApplied.keys()].some(key => key === chatId || key.endsWith(suffix));
}

/**
 * Run `action` as soon as `blocked` stops being true, and immediately when it
 * is already false.
 *
 * `blocked` is re-read on every apply that closes, so an entry is released the
 * moment its own gate opens rather than waiting for the map to empty.
 */
export function deferUntilHydrationApplied(blocked: () => boolean, action: () => void): void {
  if (!blocked()) {
    action();
    return;
  }
  deferredUntilApplied.push({ blocked, action });
}

function drainDeferredApplies(): void {
  if (deferredUntilApplied.length === 0) return;
  // Removed from the queue before running: an action that re-enters -- a mark
  // that re-marks itself -- must not find its own entry still parked.
  const ready: DeferredApply[] = [];
  for (let index = deferredUntilApplied.length - 1; index >= 0; index -= 1) {
    if (deferredUntilApplied[index].blocked()) continue;
    ready.unshift(...deferredUntilApplied.splice(index, 1));
  }
  for (const entry of ready) {
    try {
      entry.action();
    } catch (error) {
      console.error("[hydration] a deferred post-apply action failed", error);
    }
  }
}
