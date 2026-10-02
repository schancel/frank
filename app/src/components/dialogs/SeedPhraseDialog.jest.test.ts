/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const TEST_SEED =
  'apple banana cherry dinosaur elephant fox grape hat ice joke kite lemon'

const mockNotify = jest.fn()
const mockCopyToClipboard = jest.fn(() => Promise.resolve())

jest.mock('quasar', () => ({
  useQuasar: () => ({
    notify: mockNotify,
    lang: {
      getLocale: () => 'en-US',
    },
  }),
  copyToClipboard: (...args: unknown[]) => mockCopyToClipboard(...args),
}))

import { useWalletStore } from 'src/stores/wallet'
import SeedPhraseDialog from './SeedPhraseDialog.vue'

describe('SeedPhraseDialog disclosure protection (#536)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.clearAllMocks()
    const walletStore = useWalletStore()
    walletStore.seedPhrase = TEST_SEED
  })

  function mountDialog() {
    return mount(SeedPhraseDialog, {
      global: {
        mocks: {
          $t: (key: string) => key,
        },
        stubs: {
          QCard: { template: '<div><slot /></div>' },
          QCardSection: { template: '<div><slot /></div>' },
          QCardActions: { template: '<div><slot /></div>' },
          QBanner: {
            template:
              '<div class="banner"><slot name="avatar" /><slot /></div>',
          },
          QIcon: { template: '<i />' },
          QBtn: {
            template:
              '<button :data-test="$attrs[\'data-test\']" @click="$emit(\'click\')"><slot /></button>',
          },
          QInput: {
            template:
              '<input :value="$attrs[\'model-value\']" :data-test="$attrs[\'data-test\']" readonly />',
          },
        },
        directives: {
          closePopup: () => undefined,
        },
      },
    })
  }

  it('proves the phrase is absent from the DOM before disclosure', () => {
    const wrapper = mountDialog()

    // Plaintext is NOT rendered initially
    expect(wrapper.html()).not.toContain(TEST_SEED)
    expect(wrapper.find('[data-test="seed-phrase-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="copy-seed-btn"]').exists()).toBe(false)

    // Disclosure and warning must be visible
    expect(wrapper.find('[data-test="disclosure-banner"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="disclosure-text"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="reveal-seed-btn"]').exists()).toBe(true)
  })

  it('reveals plaintext only after clicking the explicit reveal button', async () => {
    const wrapper = mountDialog()

    expect(wrapper.html()).not.toContain(TEST_SEED)

    await wrapper.find('[data-test="reveal-seed-btn"]').trigger('click')
    await nextTick()

    // Plaintext is now visible in the input
    expect(wrapper.html()).toContain(TEST_SEED)
    const input = wrapper.find('[data-test="seed-phrase-input"]')
    expect(input.exists()).toBe(true)
    expect(input.attributes('value')).toBe(TEST_SEED)

    // Copy and hide buttons are now available
    expect(wrapper.find('[data-test="copy-seed-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="hide-seed-btn"]').exists()).toBe(true)
  })

  it('copies the phrase on deliberate user action and provides feedback', async () => {
    const wrapper = mountDialog()

    await wrapper.find('[data-test="reveal-seed-btn"]').trigger('click')
    await nextTick()

    await wrapper.find('[data-test="copy-seed-btn"]').trigger('click')
    await nextTick()

    expect(mockCopyToClipboard).toHaveBeenCalledWith(TEST_SEED)
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Recovery phrase copied to clipboard',
        color: 'positive',
      }),
    )
  })

  it('clears the rendered phrase from component and DOM on hide or reset', async () => {
    const wrapper = mountDialog()

    // Reveal
    await wrapper.find('[data-test="reveal-seed-btn"]').trigger('click')
    await nextTick()
    expect(wrapper.html()).toContain(TEST_SEED)

    // Hide
    await wrapper.find('[data-test="hide-seed-btn"]').trigger('click')
    await nextTick()

    expect(wrapper.html()).not.toContain(TEST_SEED)
    expect(wrapper.find('[data-test="seed-phrase-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="disclosure-banner"]').exists()).toBe(true)
  })

  it('reset() method clears rendered phrase and resets revealed state', async () => {
    const wrapper = mountDialog()

    await wrapper.find('[data-test="reveal-seed-btn"]').trigger('click')
    await nextTick()
    expect(wrapper.html()).toContain(TEST_SEED)

    // Call reset() as called on dialog hide
    const vm = wrapper.vm as unknown as { reset: () => void; revealed: boolean }
    vm.reset()
    await nextTick()

    expect(vm.revealed).toBe(false)
    expect(wrapper.html()).not.toContain(TEST_SEED)
    expect(wrapper.find('[data-test="seed-phrase-input"]').exists()).toBe(false)
  })
})
