// @vitest-environment happy-dom
/**
 * What the message-parse path pays for a large asset list.
 *
 * Hydration is a one-off. This is the one that repeats: `ParseMarkdown` runs
 * `parseAdditionalAssets` once or twice for every message rendered, and that
 * function has three distinct costs hiding in it:
 *
 *   1. `resetAssetsCache` -- O(assets), run once per character switch from the
 *      `$effect`, and again inside `parseAdditionalAssets` whenever the cached
 *      character id does not match. Over a `$state` proxy every tuple element
 *      read also creates a reactive source, so this is not the same price as
 *      the same loop over a plain array.
 *   2. The hit path -- one hash lookup per `{{asset::name}}` in the message.
 *      Independent of list size.
 *   3. `getClosestMatch` -- a Levenshtein scan over the WHOLE
 *      `char.additionalAssets` for a name that missed the hash. O(assets) per
 *      miss. Through v0.3.23 it memoised under `closest` rather than under the
 *      queried `name`, so the same missing name re-scanned on every parse; it
 *      now memoises under the query, so the scan is once per list generation.
 *
 * (3) is the one that would make this a per-message cost rather than a
 * per-open cost, so it gets measured against a real message body.
 *
 * Run with:
 *   npx vitest run --config vitest.config.perf.ts scripts/perf/measure-asset-parse.svelte.bench.ts
 */
import isEqual from 'lodash/isEqual'
import { describe, it } from 'vitest'

import { getClosestMatch, getDistance, resetAssetsCache } from '../../src/ts/parser/parser.svelte'
import { DBState } from '../../src/ts/stores.svelte'
import { koreanText } from './koreanFixture'

function makeRandom(seed: number): () => number {
    let state = seed >>> 0 || 1
    return () => {
        state ^= state << 13; state >>>= 0
        state ^= state >>> 17
        state ^= state << 5; state >>>= 0
        return state / 0x1_0000_0000
    }
}

const POSES = ['smile', 'sad', 'angry', 'blush', 'shy', 'surprise', 'wink', 'cry', 'laugh', 'neutral']
const OUTFITS = ['casual', 'uniform', 'swimsuit', 'pajama', 'formal', 'winter', 'summer']
const EXTS = ['png', 'webp', 'gif', 'mp4', 'mp3']

function assetTuples(count: number, random: () => number): [string, string, string][] {
    return Array.from({ length: count }, (_unused, index) => {
        const ext = EXTS[Math.floor(random() * EXTS.length)]
        const name = index % 4 === 0
            ? `${koreanText(5, random)}_${index}.${ext}`
            : `char_${OUTFITS[index % OUTFITS.length]}_${POSES[index % POSES.length]}_${String(index).padStart(4, '0')}.${ext}`
        const hex = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('')
        return [name, `assets/${hex}.${ext}`, ext] as [string, string, string]
    })
}

function emotionTuples(count: number, random: () => number): [string, string][] {
    return Array.from({ length: count }, (_unused, index) => {
        const hex = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('')
        return [`${POSES[index % POSES.length]}${index}`, `assets/${hex}.png`] as [string, string]
    })
}

/** `trimmer` in parser.svelte.ts, copied so the scan below scores what it scores. */
function trimmer(str: string) {
    const ext = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'webm', 'avi', 'm4p', 'm4v', 'mp3', 'wav', 'ogg']
    for (const e of ext) {
        if (str.endsWith('.' + e)) str = str.substring(0, str.length - e.length - 1)
    }
    return str.trim().replace(/[_ \-.]/g, '')
}

/**
 * `getClosestMatch`'s loop exactly as it stood at v0.3.23, over the real
 * exported `getDistance`, kept as the baseline the shipped function is measured
 * against. Everything expensive in it is here: `trimmer` per asset, and one
 * `getDistance` per asset, which allocated an `Int16Array(h*w)` each time.
 */
function closestMatchScan(assets: readonly (readonly string[])[], name: string): number {
    let closestDist = 999_999
    const trimmedName = trimmer(name)
    for (const asset of assets) {
        const key = asset[0].toLocaleLowerCase()
        const dist = getDistance(trimmedName, trimmer(key))
        if (dist < closestDist) closestDist = dist
    }
    return closestDist
}

const SIZES = [6, 500, 2_000, 4_000, 8_000]

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
}

function row(text: string) { process.stdout.write(`  ${text}\n`) }

describe('the per-message asset parse path', () => {
    it('rebuilds the asset cache in this long, plain array vs $state proxy', () => {
        row('')
        row('resetAssetsCache runs once per character switch, from the $effect in')
        row('parser.svelte.ts, and again inside parseAdditionalAssets whenever the')
        row('cached character id does not match the one being rendered.')
        row('')
        row('assets   plain ms   proxy COLD ms   proxy warm ms   JSON.parse of the hydration payload ms')
        for (const size of SIZES) {
            const random = makeRandom(11)
            const plainAssets = assetTuples(size, random)
            const plainEmos = emotionTuples(Math.max(1, size / 10), random)

            const plain: number[] = []
            for (let pass = 0; pass < 12; pass++) {
                const start = performance.now()
                resetAssetsCache(plainAssets, plainEmos, [], `plain-${pass}`)
                plain.push(performance.now() - start)
            }

            // The application never holds a plain array here: `setDatabase`
            // wraps the whole database in a `$state` proxy, so the character
            // the `$effect` reads is proxied and every tuple element read below
            // creates a reactive source on first touch and reads one after.
            const holder = $state({
                assets: assetTuples(size, makeRandom(11)),
                emos: emotionTuples(Math.max(1, size / 10), makeRandom(12)),
            })
            const coldStart = performance.now()
            resetAssetsCache(holder.assets, holder.emos, [], 'proxy-cold')
            const cold = performance.now() - coldStart
            const proxied: number[] = []
            for (let pass = 0; pass < 12; pass++) {
                const start = performance.now()
                resetAssetsCache(holder.assets, holder.emos, [], `proxy-${pass}`)
                proxied.push(performance.now() - start)
            }

            // What the client does with the hydration response before any of
            // the above: parse it off the wire.
            const payload = JSON.stringify({
                additionalAssets: plainAssets, emotionImages: plainEmos,
            })
            const parses: number[] = []
            for (let pass = 0; pass < 12; pass++) {
                const start = performance.now()
                JSON.parse(payload)
                parses.push(performance.now() - start)
            }

            row(
                `${String(size).padStart(6)}   ${median(plain).toFixed(3).padStart(8)}   ` +
                `${cold.toFixed(3).padStart(13)}   ${median(proxied).toFixed(3).padStart(13)}   ` +
                `${median(parses).toFixed(3).padStart(37)}`,
            )
        }
    })

    it('costs this much for ONE fuzzy miss, which is per name per parse', () => {
        row('')
        row('A name that is not in the list at all -- a typo, a renamed asset, a')
        row('{{asset::...}} the author never uploaded.')
        row('')
        row('v0.3.23 re-ran the whole scan on every parse, because the memo was')
        row('keyed by the match rather than by the name that was asked for, and the')
        row('match was already in the table. The columns are: that loop, the shipped')
        row('getClosestMatch on a COLD memo, and the shipped one on a repeat parse.')
        row('')
        row('"cold" is the first miss against a freshly reset list, so it pays for the')
        row('trimmed-key table as well. "2nd name" is a different missing name against')
        row('the same list, which is what the rest of a screen actually looks like.')
        row('')
        row('assets   v0.3.23 scan ms   cold ms   2nd name ms   repeat ms   v0.3.23 screen ms   now screen ms')
        DBState.db.assetMaxDifference = 4
        for (const size of SIZES) {
            const assets = assetTuples(size, makeRandom(11))
            const name = 'char_casual_smiel_9999'
            const char = { type: 'simple', chaId: 'bench', customscript: [], additionalAssets: assets } as never

            closestMatchScan(assets, name)
            const legacy: number[] = []
            for (let pass = 0; pass < 9; pass++) {
                const start = performance.now()
                closestMatchScan(assets, name)
                legacy.push(performance.now() - start)
            }

            // resetAssetsCache is what a character switch does, and it drops the
            // memo -- so each pass below is a genuinely cold first miss.
            const cold: number[] = []
            for (let pass = 0; pass < 9; pass++) {
                resetAssetsCache([], [], [], '')
                const paths = {}
                const start = performance.now()
                getClosestMatch(char, name, paths)
                cold.push(performance.now() - start)
            }

            // A second, different missing name against the same list: the
            // trimmed-key table is already built, so this is the scan alone.
            const second: number[] = []
            for (let pass = 0; pass < 9; pass++) {
                const paths = {}
                getClosestMatch(char, name, paths)
                const start = performance.now()
                getClosestMatch(char, `char_uniform_saad_${pass}999`, paths)
                second.push(performance.now() - start)
            }

            // Every parse after the first, which is the one that used to be free
            // of any cache and is now the whole point.
            const paths = {}
            getClosestMatch(char, name, paths)
            const repeat: number[] = []
            for (let pass = 0; pass < 9; pass++) {
                const start = performance.now()
                for (let call = 0; call < 20; call++) getClosestMatch(char, name, paths)
                repeat.push((performance.now() - start) / 20)
            }

            const legacyOne = median(legacy)
            const repeatOne = median(repeat)
            row(
                `${String(size).padStart(6)}   ${legacyOne.toFixed(3).padStart(14)}   ` +
                `${median(cold).toFixed(3).padStart(7)}   ${median(second).toFixed(3).padStart(11)}   ` +
                `${repeatOne.toFixed(5).padStart(9)}   ` +
                `${(legacyOne * 20).toFixed(2).padStart(17)}   ` +
                `${(median(cold) + repeatOne * 19).toFixed(3).padStart(13)}`,
            )
        }
    })

    it('costs this much in ChatBody\'s isEqual guard, per parse', () => {
        row('')
        row("ChatBody's markParsing opens with isEqual(lastCharArg, charArg) over a")
        row('simpleCharacterArgument that carries additionalAssets whole. Chats.svelte')
        row('freezes props at mount and remounts a row rather than updating it, so')
        row('within one row instance charArg is the SAME reference every time -- which')
        row('lodash short-circuits. Both are printed, because the difference is the')
        row('whole argument for whether this matters.')
        row('')
        row('assets   same reference ms   equal-but-distinct object ms')
        for (const size of SIZES) {
            const assets = assetTuples(size, makeRandom(11))
            const emos = emotionTuples(Math.max(1, size / 10), makeRandom(12))
            const a = { type: 'simple', chaId: 'c', customscript: [], additionalAssets: assets, emotionImages: emos }
            const b = {
                type: 'simple', chaId: 'c', customscript: [],
                additionalAssets: assetTuples(size, makeRandom(11)),
                emotionImages: emotionTuples(Math.max(1, size / 10), makeRandom(12)),
            }
            const same: number[] = []
            const distinct: number[] = []
            for (let pass = 0; pass < 9; pass++) {
                let start = performance.now()
                isEqual(a, a)
                same.push(performance.now() - start)
                start = performance.now()
                isEqual(a, b)
                distinct.push(performance.now() - start)
            }
            row(`${String(size).padStart(6)}   ${median(same).toFixed(4).padStart(17)}   ${median(distinct).toFixed(3).padStart(27)}`)
        }
    })

    it('costs this much to answer {{chardisplayasset}} / {{assetlist}}', () => {
        row('')
        row('These CBS functions enumerate the whole list and JSON-stringify the names.')
        row('They run per prompt build, per parse of any text that uses them.')
        row('')
        row('assets   assetlist ms   chardisplayasset ms   JSON bytes injected')
        for (const size of SIZES) {
            const holder = $state({ assets: assetTuples(size, makeRandom(11)) })
            const excludes: string[] = []
            const listSamples: number[] = []
            const displaySamples: number[] = []
            let bytes = 0
            for (let pass = 0; pass < 9; pass++) {
                let start = performance.now()
                const names = JSON.stringify(holder.assets.map((f) => f[0]))
                listSamples.push(performance.now() - start)
                bytes = names.length
                start = performance.now()
                JSON.stringify(holder.assets.filter((f) => !excludes.includes(f[1])).map((f) => f[0]))
                displaySamples.push(performance.now() - start)
            }
            row(
                `${String(size).padStart(6)}   ${median(listSamples).toFixed(3).padStart(12)}   ` +
                `${median(displaySamples).toFixed(3).padStart(19)}   ${String(bytes).padStart(19)}`,
            )
        }
    })

    it('costs this much for a HIT, which is the common case', () => {
        row('')
        row('assets   1,000 hash hits ms')
        for (const size of SIZES) {
            const assets = assetTuples(size, makeRandom(11))
            resetAssetsCache(assets, [], [], 'hit-bench')
            // The lookup the parser makes is `assetPaths[name]` on the object
            // `resetAssetsCache` built. Rebuild the same object here so the
            // measurement is of the lookup and not of module-private state.
            const paths: Record<string, unknown> = {}
            for (const asset of assets) paths[asset[0].toLocaleLowerCase()] ??= { srcPaths: [asset[1]], ext: asset[2] }
            const names = Array.from({ length: 1_000 }, (_unused, index) =>
                assets[index % assets.length][0].toLocaleLowerCase())
            const samples: number[] = []
            for (let pass = 0; pass < 9; pass++) {
                const start = performance.now()
                let seen = 0
                for (const n of names) if (paths[n]) seen++
                samples.push(performance.now() - start)
                void seen
            }
            row(`${String(size).padStart(6)}   ${median(samples).toFixed(4).padStart(18)}`)
        }
    })
})
