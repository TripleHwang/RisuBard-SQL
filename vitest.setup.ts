import { afterEach, vi } from 'vitest'

// Suppress warning
vi.mock(import('katex'), () => ({}))

vi.stubGlobal('safeStructuredClone', (v: unknown) => JSON.parse(JSON.stringify(v)))

// bits-ui intentionally restores dialog body-scroll locks on a 24 ms timer.
// Wait only after tests that actually held a lock, while happy-dom's document
// still exists, so the callback cannot escape into environment teardown.
afterEach(async () => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const style = document.body?.style
  if (style?.overflow !== 'hidden' && style?.pointerEvents !== 'none') return
  await new Promise<void>((resolveWait) => window.setTimeout(resolveWait, 30))
})
