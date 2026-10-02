/** @jest-environment jsdom */

import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useTranslate } from './useTranslate'
import { translateMessage } from 'src/i18n'
import { useAppearanceStore } from 'src/stores/appearance'

describe('useTranslate composable and translateMessage', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('delegates to the component instance $t when mounted with mock $t', () => {
    let capturedT: ReturnType<typeof useTranslate> | undefined
    const mockT = jest.fn((key: string) => `mocked:${key}`)

    const TestComponent = defineComponent({
      setup() {
        capturedT = useTranslate()
        return {}
      },
      template: '<div />',
    })

    mount(TestComponent, {
      global: {
        mocks: {
          $t: mockT,
        },
      },
    })

    expect(capturedT).toBeDefined()
    expect(capturedT?.('test.key')).toBe('mocked:test.key')
    expect(mockT).toHaveBeenCalledWith('test.key', undefined)
  })

  it('translates messages via translateMessage in default en-us locale', () => {
    const t = useTranslate()
    expect(t('agree')).toBe('Agree')
    expect(t('walletPanel.monad')).toBe('Monad')
  })

  it('translates messages via translateMessage in active fr-fr locale', () => {
    const store = useAppearanceStore()
    store.locale = 'fr-fr'
    const t = useTranslate()
    expect(t('agree')).toBe("D'accord")
    expect(t('walletPanel.mainWallet')).toBe('Portefeuille principal')
  })

  it('returns key if key is missing', () => {
    const t = useTranslate()
    expect(t('nonexistent.key.xyz')).toBe('nonexistent.key.xyz')
  })

  it('translateMessage supports direct locale override', () => {
    expect(translateMessage('agree', 'en-us')).toBe('Agree')
    expect(translateMessage('agree', 'fr-fr')).toBe("D'accord")
  })
})
