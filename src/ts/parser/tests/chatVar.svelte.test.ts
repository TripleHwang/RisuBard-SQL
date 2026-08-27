import fc from 'fast-check'
import { writable } from 'svelte/store'
import { beforeEach, expect, test, vi } from 'vitest'
import { DBState } from '../../stores.svelte'
import { getChatVar, getGlobalChatVar, setChatVar, setGlobalChatVar } from '../chatVar.svelte'
import { resetChatVariables } from './cbs/lib'

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
    DBState: {
      db: {
        characters: [
          {
            chatPage: 0,
            chats: [
              {
                scriptstate: {},
              },
            ],
            defaultVariables: '',
          },
        ],
        globalChatVariables: {},
        templateDefaultVariables: '',
      },
    },
    selIdState: {
      selId: 0,
    },
    selectedCharID: writable(0),
  } as typeof import('../../stores.svelte')
})

//#endregion

const anyValidDefaultVarKey = fc.string({ minLength: 1, unit: 'grapheme' }).filter((s) => !/[=\n]/.test(s))
const anyValidDefaultVarValue = fc
  .anything()
  .map(JSON.stringify)
  .filter((s) => s !== undefined && !/[=\n]/.test(s))

beforeEach(() => {
  vi.resetAllMocks()
  resetChatVariables()
})

test('can get a character default variable', () => {
  fc.assert(
    fc.property(anyValidDefaultVarKey, anyValidDefaultVarValue, (key, value) => {
      DBState.db.characters[0].defaultVariables = `${key}=${value}`
      expect(getChatVar(key)).toBe(value)
    })
  )
})

test('can get a template default variable', () => {
  fc.assert(
    fc.property(anyValidDefaultVarKey, anyValidDefaultVarValue, (key, value) => {
      DBState.db.templateDefaultVariables = `${key}=${value}`
      expect(getChatVar(key)).toBe(value)
    })
  )
})

test('can set and get a chat variable', () => {
  fc.assert(
    fc.property(
      fc.string({ unit: 'grapheme' }),
      fc
        .anything()
        .filter((v) => v !== undefined)
        .map(JSON.stringify),
      (key, value) => {
        setChatVar(key, value)
        expect(getChatVar(key)).toBe(value)
      }
    )
  )
})

test('can set a chat variable over its default value', () => {
  DBState.db.characters[0].defaultVariables = 'char=default'
  DBState.db.templateDefaultVariables = 'template=default'

  setChatVar('char', 'overridden')
  setChatVar('template', 'overridden')

  expect(getChatVar('char')).toBe('overridden')
  expect(getChatVar('template')).toBe('overridden')
})

test('can get a global chat variable', () => {
  fc.assert(
    fc.property(
      fc.string({ unit: 'grapheme' }),
      fc
        .anything()
        .filter((v) => v !== undefined)
        .map(JSON.stringify),
      (key, value) => {
        DBState.db.globalChatVariables[`toggle_${key}`] = value

        expect(getGlobalChatVar(`toggle_${key}`)).toBe(value)
      }
    )
  )
})

test('reports whether setting a chat variable changed its stored value', () => {
  expect(setChatVar('scene', 'rain')).toBe(true)
  expect(setChatVar('scene', 'rain')).toBe(false)
  expect(setChatVar('scene', 'sun')).toBe(true)
  expect(getChatVar('scene')).toBe('sun')
})

test('uses an own per-chat override even when its value is empty', () => {
  const chat = DBState.db.characters[0].chats[0] as typeof DBState.db.characters[0]['chats'][0] & {
    useLocallySetGlobalVariables?: boolean
    GLGlobalVariables?: Record<string, string>
  }
  DBState.db.globalChatVariables.toggle_weather = 'sunny'
  chat.useLocallySetGlobalVariables = true
  chat.GLGlobalVariables = { toggle_weather: '' }

  expect(getGlobalChatVar('toggle_weather')).toBe('')
})

test('falls back to the global value when the pinned chat has no own override', () => {
  const chat = DBState.db.characters[0].chats[0] as typeof DBState.db.characters[0]['chats'][0] & {
    useLocallySetGlobalVariables?: boolean
    GLGlobalVariables?: Record<string, string>
  }
  DBState.db.globalChatVariables.toggle_weather = 'sunny'
  chat.useLocallySetGlobalVariables = true
  chat.GLGlobalVariables = {}

  expect(getGlobalChatVar('toggle_weather')).toBe('sunny')
})

test('writes global variables into the current chat only while local overrides are enabled', () => {
  const chat = DBState.db.characters[0].chats[0] as typeof DBState.db.characters[0]['chats'][0] & {
    useLocallySetGlobalVariables?: boolean
    GLGlobalVariables?: Record<string, string>
  }
  DBState.db.globalChatVariables.toggle_weather = 'sunny'
  chat.useLocallySetGlobalVariables = true

  setGlobalChatVar('toggle_weather', 'rainy')

  expect(chat.GLGlobalVariables).toEqual({ toggle_weather: 'rainy' })
  expect(DBState.db.globalChatVariables.toggle_weather).toBe('sunny')

  chat.useLocallySetGlobalVariables = false
  setGlobalChatVar('toggle_weather', 'cloudy')

  expect(DBState.db.globalChatVariables.toggle_weather).toBe('cloudy')
})

test('ignores per-chat overrides while toggle binding is globally disabled', () => {
  const chat = DBState.db.characters[0].chats[0] as typeof DBState.db.characters[0]['chats'][0] & {
    useLocallySetGlobalVariables?: boolean
    GLGlobalVariables?: Record<string, string>
  }
  DBState.db.globalChatVariables.toggle_weather = 'global'
  DBState.db.disableToggleBinding = true
  chat.useLocallySetGlobalVariables = true
  chat.GLGlobalVariables = { toggle_weather: 'local' }

  expect(getGlobalChatVar('toggle_weather')).toBe('global')
  setGlobalChatVar('toggle_weather', 'updated-global')
  expect(DBState.db.globalChatVariables.toggle_weather).toBe('updated-global')
  expect(chat.GLGlobalVariables.toggle_weather).toBe('local')

  DBState.db.disableToggleBinding = false
})

test('returns "null" for undefined variables', () => {
  fc.assert(
    fc.property(fc.string({ unit: 'grapheme' }), (key) => {
      expect(getChatVar(key)).toBe('null')
      expect(getGlobalChatVar(`toggle_${key}`)).toBe('null')
    })
  )
})
