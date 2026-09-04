import fc from 'fast-check'
import { writable } from 'svelte/store'
import { beforeEach, expect, test, vi } from 'vitest'
import { getClosestMatch, getDistance, resetAssetsCache } from '../parser.svelte'
import { DBState } from '../../stores.svelte'

//#region module mocks

vi.mock(
  import('../../storage/database.svelte'),
  () =>
    ({
      appVer: '1234.5.67',
      getCurrentCharacter: () => ({}),
      getDatabase: () => ({}),
    } as typeof import('../../storage/database.svelte'))
)

vi.mock(import('../../globalApi.svelte'), () => ({
  aiWatermarkingLawApplies: () => false,
  getFileSrc: () => Promise.resolve(''),
}))

vi.mock(import('../../stores.svelte'), () => {
  return {
    // selId -1 keeps the module-level $effect from touching a character; every
    // test here drives getClosestMatch directly.
    DBState: { db: { characters: [], assetMaxDifference: 4 } },
    selIdState: { selId: -1 },
    selectedCharID: writable(-1),
  } as typeof import('../../stores.svelte')
})

//#endregion

type Tuple = [string, string, string]
type AssetPaths = Record<string, { srcPaths: string[]; ext?: string }>

/**
 * `trimmer` in parser.svelte.ts, copied so the reference below scores what it
 * scored. The hyphen in the character class is UNESCAPED on purpose: that is
 * what the shipped `trimmer` has, and it makes the class a range 0x20-0x2E --
 * space through full stop, so `!"#$%&'()*+,-.` all get stripped as well as `_`
 * and the space. Escaping it here would quietly narrow the reference to four
 * characters and stop this file from scoring what production scores.
 */
function trimmer(str: string) {
  const ext = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'webm', 'avi', 'm4p', 'm4v', 'mp3', 'wav', 'ogg']
  for (const e of ext) {
    if (str.endsWith('.' + e)) str = str.substring(0, str.length - e.length - 1)
  }
  return str.trim().replace(/[_ -.]/g, '')
}

/**
 * `getClosestMatch` exactly as it stood at v0.3.23, over the same exported
 * `getDistance`. The optimised implementation must agree with this on every
 * input -- a divergence is an asset reference that used to resolve and stops.
 */
function referenceClosestMatch(assets: Tuple[] | undefined, name: string, assetPaths: AssetPaths) {
  if (!assets) return null

  let closest = ''
  let closestDist = 999999
  let targetPath = ''
  let targetExt = ''

  const trimmedName = trimmer(name)
  for (const asset of assets) {
    const key = asset[0].toLocaleLowerCase()
    const dist = getDistance(trimmedName, trimmer(key))
    if (dist < closestDist) {
      closest = key
      closestDist = dist
      targetPath = asset[1]
      targetExt = asset[2]
    }
  }

  if (closestDist > DBState.db.assetMaxDifference) return null

  assetPaths[closest] = { srcPaths: [targetPath], ext: targetExt }
  return assetPaths[closest]
}

const POSES = ['smile', 'sad', 'angry', 'blush', 'shy', 'surprise', 'wink', 'cry', 'laugh', 'neutral']
const OUTFITS = ['casual', 'uniform', 'swimsuit', 'pajama', 'formal', 'winter', 'summer']
const EXTS = ['png', 'webp', 'gif', 'mp4', 'mp3']

function assets(count: number): Tuple[] {
  return Array.from({ length: count }, (_unused, index) => {
    const ext = EXTS[index % EXTS.length]
    const base = index % 4 === 0
      ? `캐릭터_표정_${index}.${ext}`
      : `char_${OUTFITS[index % OUTFITS.length]}_${POSES[index % POSES.length]}_${String(index).padStart(4, '0')}.${ext}`
    // Every third name carries capitals. `getClosestMatch` lowercases each key
    // before scoring it, and the queried name arrives already lowercased from
    // `parseAdditionalAssets`; an all-lowercase fixture cannot tell whether
    // that lowercasing is still happening.
    const name = index % 3 === 1 ? base.toUpperCase() : base
    return [name, `assets/${String(index).padStart(64, '0')}.${ext}`, ext]
  })
}

/**
 * Wraps every tuple in a counting Proxy. `getClosestMatch` cannot read an asset
 * name, path or extension without going through this, so the counter is an
 * exact measure of how much of the list a call walked.
 */
function counted(tuples: Tuple[]) {
  const state = { reads: 0 }
  const wrapped = tuples.map((tuple) => new Proxy(tuple, {
    get(target, prop, receiver) {
      if (prop === '0' || prop === '1' || prop === '2') state.reads++
      return Reflect.get(target, prop, receiver)
    },
  })) as Tuple[]
  return { state, wrapped }
}

const asChar = (additionalAssets: Tuple[] | undefined) =>
  ({ type: 'simple', chaId: 'c', customscript: [], additionalAssets } as never)

beforeEach(() => {
  DBState.db.assetMaxDifference = 4
  // Drops any memo left by a previous test, the way a character switch does.
  resetAssetsCache([], [], [], '')
})

test('a fuzzy miss is scanned once, not on every parse', () => {
  const { state, wrapped } = counted(assets(600))
  const paths: AssetPaths = {}
  const char = asChar(wrapped)

  const first = getClosestMatch(char, 'char_casual_smile_0035', paths)
  expect(first).not.toBeNull()
  expect(state.reads).toBeGreaterThan(0)

  // Every subsequent parse of the same message asks again. Before the memo was
  // keyed by the queried name, this re-walked the whole list every time: the
  // function wrote `assetPaths[closest]`, which `getAssetSrc` had already put
  // there, so the caller's `assetPaths[name]` lookup kept missing.
  const readsAfterFirst = state.reads
  for (let parse = 0; parse < 5; parse++) {
    expect(getClosestMatch(char, 'char_casual_smile_0035', paths)).toEqual(first)
  }
  expect(state.reads).toBe(readsAfterFirst)
})

test('a name with no match at all is scanned once, not on every parse', () => {
  // The tuple read counter cannot see this one. A losing scan never touches a
  // tuple: the trimmed keys are built once per list, and a negative answer
  // never reaches `assets[closestIndex]`. So the only thing separating a
  // memoised "no" from a re-scanned one is the Levenshtein work itself, and the
  // only handle on that is the clock. The margin makes up for the crudeness --
  // without the memo each repeat costs a full scan, so thirty of them cost
  // thirty scans, and the assertion below is that they cost less than one.
  const list = assets(6000)
  const paths: AssetPaths = {}
  const char = asChar(list)
  // Twenty characters, which is inside `assetMaxDifference` of the trimmed
  // length of every ASCII name in the fixture, so the length prune cannot throw
  // the list away and every one of them is actually scored. A query whose
  // length is nowhere near the list is the easy case; this is the expensive one,
  // and it is also the realistic one, since a model emitting a slightly wrong
  // asset name emits something the right sort of length.
  const missing = 'q'.repeat(20)

  // Warm up: builds the trimmed-key table, so it is not charged to the scan.
  expect(getClosestMatch(char, 'w'.repeat(20), paths)).toBeNull()

  const beforeFirst = performance.now()
  expect(getClosestMatch(char, missing, paths)).toBeNull()
  const oneScan = performance.now() - beforeFirst
  expect(oneScan).toBeGreaterThan(0)

  const beforeRepeats = performance.now()
  for (let parse = 0; parse < 30; parse++) {
    expect(getClosestMatch(char, missing, paths)).toBeNull()
  }
  const thirtyRepeats = performance.now() - beforeRepeats

  expect(thirtyRepeats, `one scan ${oneScan.toFixed(3)}ms, thirty repeats ${thirtyRepeats.toFixed(3)}ms`)
    .toBeLessThan(oneScan)
})

test('a memo hit plants the matched key in assetPaths, as a re-scan did', () => {
  // The uncached path ends by writing `assetPaths[closest]`, overwriting
  // whatever `getAssetSrc` put there. A later `{{asset::<closest>}}` reads that
  // entry by exact name, so a memo hit that skipped the write would hand out a
  // different source than the same parse did before the memo existed.
  const list: Tuple[] = [
    ['sunset_beach.png', 'assets/first.png', 'png'],
    ['sunset_beach.png', 'assets/second.png', 'png'],
  ]
  const char = asChar(list)

  const cold: AssetPaths = { 'sunset_beach.png': { srcPaths: ['assets/first.png', 'assets/second.png'], ext: 'png' } }
  const first = getClosestMatch(char, 'sunsetbeahc', cold)
  expect(first).not.toBeNull()

  const warm: AssetPaths = { 'sunset_beach.png': { srcPaths: ['assets/first.png', 'assets/second.png'], ext: 'png' } }
  const second = getClosestMatch(char, 'sunsetbeahc', warm)

  expect(second).toEqual(first)
  expect(warm).toEqual(cold)
  expect(warm['sunset_beach.png'].srcPaths).toEqual(['assets/first.png'])
})

test('the memo survives only its own list: an asset added later still resolves', () => {
  const list = assets(200)
  const paths: AssetPaths = {}
  const char = asChar(list)

  // Asked for before it exists: no match, and that answer gets cached.
  expect(getClosestMatch(char, 'brand_new_costume_9999', paths)).toBeNull()
  expect(getClosestMatch(char, 'brand_new_costume_9999', paths)).toBeNull()

  // The user uploads it. A cached "no" that outlived this would be exactly the
  // silent-missing-asset defect.
  list.push(['brand_new_costume_9999.png', 'assets/new.png', 'png'])
  const found = getClosestMatch(char, 'brand_new_costume_9999', paths)
  expect(found).not.toBeNull()
  expect(found!.srcPaths).toEqual(['assets/new.png'])

  // ...and removing it goes back to no match.
  list.pop()
  expect(getClosestMatch(char, 'brand_new_costume_9999', paths)).toBeNull()
})

test('the memo does not leak between characters', () => {
  const paths: AssetPaths = {}
  const a = asChar([['alpha_pose.png', 'assets/a.png', 'png']])
  const b = asChar([['alpha_pose.png', 'assets/b.png', 'png']])

  expect(getClosestMatch(a, 'alpha_pose', paths)!.srcPaths).toEqual(['assets/a.png'])
  expect(getClosestMatch(b, 'alpha_pose', paths)!.srcPaths).toEqual(['assets/b.png'])
  expect(getClosestMatch(a, 'alpha_pose', paths)!.srcPaths).toEqual(['assets/a.png'])
})

test('resetAssetsCache drops the memo', () => {
  const list = assets(50)
  const paths: AssetPaths = {}
  const char = asChar(list)

  expect(getClosestMatch(char, 'renamed_target', paths)).toBeNull()
  // A rename keeps the length and the identity, so only the $effect ->
  // resetAssetsCache path can invalidate it. That path must actually work.
  list[0][0] = 'renamed_target.png'
  resetAssetsCache(list, [], [], 'c')
  const found = getClosestMatch(char, 'renamed_target', paths)
  expect(found).not.toBeNull()
  expect(found!.srcPaths).toEqual([list[0][1]])
})

test('changing assetMaxDifference takes effect immediately', () => {
  const paths: AssetPaths = {}
  const char = asChar([['sunset_beach.png', 'assets/s.png', 'png']])

  // The same query, either side of the threshold. The memo is not keyed by the
  // threshold, so it has to be thrown away when the setting moves.
  DBState.db.assetMaxDifference = 4
  expect(getClosestMatch(char, 'sunsetbeahc', paths)).not.toBeNull()

  DBState.db.assetMaxDifference = 0
  expect(getClosestMatch(char, 'sunsetbeahc', paths)).toBeNull()

  DBState.db.assetMaxDifference = 4
  expect(getClosestMatch(char, 'sunsetbeahc', paths)).not.toBeNull()
})

test('matches the v0.3.23 implementation exactly, over every threshold', () => {
  const list = assets(400)
  const names = [
    // exact, modulo case and extension
    'char_casual_smile_0035', 'CHAR_UNIFORM_SAD_0036', '캐릭터_표정_40',
    // one to four edits away
    'char_casual_smiel_0035', 'char_casual_smile_003', 'char_casual_smile_00355',
    'chr_casual_smile_0035', 'char_cazual_smiel_0035', '캐릭터_표졍_40',
    // separators and extensions, which trimmer eats
    'char casual smile 0035', 'char-casual-smile-0035.png', 'char.casual.smile.0035.webp',
    // far away, and degenerate
    'nothing_like_this', '', 'x', 'a'.repeat(80),
    // a prefix of a real name, and a name longer than anything in the list
    'char_casual', 'char_casual_smile_0035_extra_extra_long_tail',
    // punctuation the real trimmer eats along with `_`, space and `.`
    "char's (casual) smile!", 'char,casual+smile*0035', '#char$casual%smile',
  ]

  // The fractional thresholds are not hypothetical: Asset Max Difference is a
  // bare `type="number"` with no min, max or step, so 3.5 is one keystroke
  // away, and a fractional band width indexes an Int16Array at a fractional
  // index -- a silent no-op that used to make the whole scan return nothing.
  for (const threshold of [0, 1, 2, 4, 10, 400, 0.5, 1.5, 3.5, 4.5, -1, -0.5]) {
    DBState.db.assetMaxDifference = threshold
    for (const name of names) {
      const referencePaths: AssetPaths = {}
      const reference = referenceClosestMatch(list, name, referencePaths)

      resetAssetsCache([], [], [], '')
      DBState.db.assetMaxDifference = threshold
      const actualPaths: AssetPaths = {}
      const actual = getClosestMatch(asChar(list), name, actualPaths)

      expect(actual, `name=${JSON.stringify(name)} threshold=${threshold}`).toEqual(reference)
      expect(actualPaths, `paths for name=${JSON.stringify(name)} threshold=${threshold}`)
        .toEqual(referencePaths)
    }
  }
})

test('matches the v0.3.23 implementation on arbitrary names and lists', () => {
  // The scan is banded and early-abandoning now, and every one of those skips
  // is only sound because of an argument about what the loop does with a
  // distance. This is the argument, checked.
  // Capitals, punctuation inside trimmer's 0x20-0x2E range, and an astral pair,
  // because keys are lowercased before scoring and distances are counted in
  // UTF-16 code units.
  const word = fc.string({
    minLength: 0,
    maxLength: 30,
    unit: fc.constantFrom(
      'a', 'b', 'c', 'z', 'A', 'B', 'Z', '0', '9', '_', ' ', '-', '.',
      ',', '!', '(', ')', "'", '+', '*', '#', '$', '%', '&', '"',
      '가', '힣', '표', '정', '😀',
    ),
  })
  fc.assert(
    fc.property(
      fc.array(fc.tuple(word, fc.constant('p'), fc.constantFrom('png', 'webp', 'mp4', 'jpeg')), { maxLength: 30 }),
      word,
      fc.constantFrom(0, 1, 2, 3, 4, 8, -1, 2.5),
      // A near-miss of an entry already in the list is the realistic query, and
      // it is also the one that exercises the band edges.
      fc.tuple(fc.nat(), fc.nat(), fc.constantFrom('', 'x', 'xy', 'xyz'), fc.boolean()),
      (tuples, freeName, threshold, [pick, cut, tail, useFree]) => {
        const list = tuples.map(([n, p, e], index) => [n, `${p}${index}`, e] as Tuple)
        const base = list.length > 0 ? list[pick % list.length][0] : ''
        const name = useFree || list.length === 0
          ? freeName
          : base.slice(0, base.length - (cut % (base.length + 1))) + tail
        DBState.db.assetMaxDifference = threshold

        const referencePaths: AssetPaths = {}
        const reference = referenceClosestMatch(list, name, referencePaths)

        resetAssetsCache([], [], [], '')
        const actualPaths: AssetPaths = {}
        const actual = getClosestMatch(asChar(list), name, actualPaths)

        expect(actual).toEqual(reference)
        expect(actualPaths).toEqual(referencePaths)
      }
    ),
    { numRuns: 2000 }
  )
})

test('a one-asset list pins the banded distance at every cap', () => {
  // With a single candidate the scan is `boundedDistance` and nothing else, so
  // a disagreement here is a band bug rather than a pruning bug. Sweeping the
  // threshold past the length of both strings covers the band narrower than the
  // matrix, the band exactly at its edge, and the band wide enough that the
  // function hands off to the unbanded `getDistance`.
  const pairs: [string, string][] = [
    ['', ''], ['a', ''], ['', 'a'], ['abc', 'abd'],
    ['kitten', 'sitting'], ['flaw', 'lawn'], ['abcdefgh', 'hgfedcba'],
    ['abcdefgh', 'axcxexgx'], ['aaaaaaaaaa', 'aaaaa'], ['aaaaa', 'aaaaaaaaaa'],
    ['캐릭터표정', '캐릭터표졍'], ['캐릭터표정', '표정캐릭터'],
    ['prefix', 'prefixsuffix'], ['x', 'xxxxxxxxxxxxxxxxxxxx'],
    ['a'.repeat(40), 'b'.repeat(40)], ['a'.repeat(40), 'a'.repeat(41)],
  ]
  for (const [name, key] of pairs) {
    const list: Tuple[] = [[key, 'assets/only.png', 'png']]
    for (let threshold = 0; threshold <= 45; threshold++) {
      DBState.db.assetMaxDifference = threshold
      const referencePaths: AssetPaths = {}
      const reference = referenceClosestMatch(list, name, referencePaths)

      resetAssetsCache([], [], [], '')
      DBState.db.assetMaxDifference = threshold
      const actualPaths: AssetPaths = {}
      const actual = getClosestMatch(asChar(list), name, actualPaths)

      expect(actual, `${JSON.stringify(name)} vs ${JSON.stringify(key)} @${threshold}`).toEqual(reference)
      expect(actualPaths).toEqual(referencePaths)
    }
  }
})

test('the whole resolution loop, over repeated parses, resolves what v0.3.23 resolved', () => {
  // getClosestMatch is never called in isolation. `parseAdditionalAssets` looks
  // up `assetPaths[name]` first and only falls through on a miss, and the
  // fall-through writes back into that same long-lived `assetPaths` -- so the
  // table an asset reference is resolved against is one the previous references
  // in the same chat have already been editing. This replays that: one shared
  // table per implementation, the same names in the same order, five parses of
  // the screen, and every single resolution compared.

  /** `getAssetSrc` in parser.svelte.ts, which is what builds the real table. */
  function buildPaths(assetArr: Tuple[]): AssetPaths {
    const assetPaths: AssetPaths = {}
    for (const asset of assetArr) {
      const key = asset[0].toLocaleLowerCase()
      assetPaths[key] ??= { srcPaths: [], ext: asset[2] }
      if (assetPaths[key].ext === asset[2]) assetPaths[key].srcPaths.push(asset[1])
    }
    return assetPaths
  }

  const list = assets(300)
  // Names a model would actually emit: exact ones, near misses, wrong case,
  // extensions it invented, and a few that are simply not there. Lowercased,
  // because `parseAdditionalAssets` lowercases before it looks anything up.
  const screen = [
    list[7][0], list[8][0], list[12][0], list[0][0],
    'char_casual_smile_0035', 'char_casual_smiel_0035', 'chr_uniform_sad_0036',
    '캐릭터_표정_40', '캐릭터_표졍_40', 'char_swimsuit_angry_0002.png',
    'char-formal-blush-0011', 'char formal blush 0011', 'char_formal_blush_0011.webp',
    'absent_thing', 'another_absent_thing', '', 'x',
    list[7][0], 'char_casual_smiel_0035', 'absent_thing',
  ].map((n) => n.toLocaleLowerCase())

  for (const threshold of [0, 2, 4, 9]) {
    DBState.db.assetMaxDifference = threshold

    const referencePaths = buildPaths(list)
    const reference: (string | null)[] = []

    resetAssetsCache([], [], [], '')
    DBState.db.assetMaxDifference = threshold
    const actualPaths = buildPaths(list)
    const actual: (string | null)[] = []
    const char = asChar(list)

    for (let parse = 0; parse < 5; parse++) {
      for (const name of screen) {
        const ref = referencePaths[name] ?? referenceClosestMatch(list, name, referencePaths)
        reference.push(ref ? `${ref.srcPaths.join('|')}#${ref.ext}` : null)

        const act = actualPaths[name] ?? getClosestMatch(char, name, actualPaths)
        actual.push(act ? `${act.srcPaths.join('|')}#${act.ext}` : null)
      }
    }

    expect(actual, `threshold ${threshold}`).toEqual(reference)
    // The tables themselves have to end up identical too: a later exact-name
    // reference reads whatever an earlier fuzzy one planted here.
    expect(actualPaths, `paths at threshold ${threshold}`).toEqual(referencePaths)
    // ...and something must actually have resolved, or this proves nothing.
    expect(actual.filter((entry) => entry !== null).length).toBeGreaterThan(0)
  }
})

test('an empty asset list behaves as it did', () => {
  const paths: AssetPaths = {}
  expect(getClosestMatch(asChar([]), 'anything', paths)).toBeNull()
  expect(paths).toEqual({})
  expect(getClosestMatch(asChar(undefined), 'anything', paths)).toBeNull()
})

test('getDistance is still correct when its scratch buffer is reused', () => {
  // The buffer is shared and grows; a stale cell surviving into a smaller
  // problem would show up here as a wrong distance.
  const cases: [string, string, number][] = [
    ['', '', 0],
    ['a', '', 1],
    ['', 'abc', 3],
    ['kitten', 'sitting', 3],
    ['flaw', 'lawn', 2],
    ['캐릭터표정', '캐릭터표졍', 1],
    ['a'.repeat(120), 'a'.repeat(120), 0],
    ['a'.repeat(120), 'b'.repeat(120), 120],
    ['x', 'x', 0],
    ['kitten', 'sitting', 3],
    ['abcdef', 'abcdef', 0],
  ]
  // Forwards, then backwards, so every case runs both after a larger problem
  // and after a smaller one.
  for (const order of [cases, [...cases].reverse()]) {
    for (const [a, b, expected] of order) {
      expect(getDistance(a, b), `${a.slice(0, 8)}/${b.slice(0, 8)}`).toBe(expected)
    }
  }
})
