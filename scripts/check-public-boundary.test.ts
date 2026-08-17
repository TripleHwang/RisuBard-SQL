import { describe, expect, test } from 'vitest'
import { collectPublicBoundaryViolations } from './check-public-boundary.mjs'

describe('public source boundary', () => {
    test('contains no private novelist implementation or direct imports', () => {
        expect(collectPublicBoundaryViolations()).toEqual([])
    })

    test('contains no private workspace protocol identifiers', () => {
        expect(collectPublicBoundaryViolations()
            .filter((violation) => violation.startsWith('private-identifier:'))
        ).toEqual([])
    })
})
