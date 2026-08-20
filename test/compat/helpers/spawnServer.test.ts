import { describe, expect, test } from 'vitest'
import { isFetchBlockedPort } from './spawnServer.js'

describe('compat server port selection', () => {
  test('rejects Fetch-blocked ports without rejecting normal test ports', () => {
    expect(isFetchBlockedPort(6000)).toBe(true)
    expect(isFetchBlockedPort(6667)).toBe(true)
    expect(isFetchBlockedPort(10080)).toBe(true)
    expect(isFetchBlockedPort(3000)).toBe(false)
    expect(isFetchBlockedPort(49152)).toBe(false)
  })
})
