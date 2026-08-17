import { describe, expect, test } from 'vitest'
import { bindPluginRequestStatusStorage, resolvePluginRequestStatus } from './providerRequestStatus'

describe('resolvePluginRequestStatus', () => {
    test('keeps plugin request status disabled unless the provider opts in', () => {
        expect(resolvePluginRequestStatus(undefined)).toBe(false)
        expect(resolvePluginRequestStatus({})).toBe(false)
    })

    test('supports a live provider-owned status selector', () => {
        let enabled = false
        const options = { hostRequestStatus: () => enabled }

        expect(resolvePluginRequestStatus(options)).toBe(false)
        enabled = true
        expect(resolvePluginRequestStatus(options)).toBe(true)
    })

    test('contains provider selector failures', () => {
        expect(resolvePluginRequestStatus({
            hostRequestStatus: () => { throw new Error('broken option') },
        })).toBe(false)
    })

    test('binds a serializable plugin storage key to a live host selector', () => {
        let value: unknown = 'provider'
        const options = bindPluginRequestStatusStorage({
            hostRequestStatusStorageKey: 'provider-manager:status-path',
        }, () => value)

        expect(resolvePluginRequestStatus(options)).toBe(false)
        value = 'risubard'
        expect(resolvePluginRequestStatus(options)).toBe(true)
    })
})
