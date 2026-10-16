import { createPinia, setActivePinia } from 'pinia'
import { useAppearanceStore } from '../stores/appearance'
import { localeOptions, messages, translateMessage } from './index'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => jest.restoreAllMocks())

it.each(localeOptions)(
  'headless translation uses the complete $value catalog',
  ({ value }) => {
    useAppearanceStore().locale = value
    expect(translateMessage('settings.languageAutomatic')).toBe(
      messages[value].settings.languageAutomatic,
    )
    expect(translateMessage('missing.key')).toBe('missing.key')
  },
)

it('resolves automatic preference on every headless translation without rewriting it', () => {
  const languages = jest
    .spyOn(navigator, 'languages', 'get')
    .mockReturnValue(['fil'])
  const appearance = useAppearanceStore()
  expect(appearance.locale).toBe('auto')
  expect(translateMessage('settings.languageAutomatic')).toBe(
    messages['tl-ph'].settings.languageAutomatic,
  )
  languages.mockReturnValue(['zh-Hant-CN'])
  expect(translateMessage('settings.languageAutomatic')).toBe(
    messages['zh-tw'].settings.languageAutomatic,
  )
  expect(appearance.locale).toBe('auto')
  expect(translateMessage('settings.languageAutomatic', 'es-MX')).toBe(
    messages['es-es'].settings.languageAutomatic,
  )
})
