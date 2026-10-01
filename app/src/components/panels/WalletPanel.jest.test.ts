/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick, ref } from 'vue'

const balance = {
  formattedBalance: ref('1 MON'),
  loaded: ref(true),
  hasError: ref(false),
}
const openPage = jest.fn()

jest.mock('../../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('src/composables/useBalance', () => ({
  useBalance: () => balance,
}))
jest.mock('src/utils/routes', () => ({
  openPage: (...args: unknown[]) => openPage(...args),
}))
jest.mock('../dialogs/SeedPhraseDialog.vue', () => ({
  template: '<div data-test="seed-phrase-dialog" />',
}))

import WalletPanel from './WalletPanel.vue'
import SeedConfirmDialog from '../dialogs/SeedConfirmDialog.vue'
import { useProfileStore } from 'src/stores/my-profile'
import { useWalletStore } from 'src/stores/wallet'

const SEED = 'test test test test test test test test test test test junk'

const QDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  emits: ['update:modelValue', 'hide'],
  watch: {
    modelValue(value: boolean, old: boolean) {
      if (old && !value) this.$emit('hide')
    },
  },
  template: '<div v-if="modelValue"><slot /></div>',
})

function mountPanel() {
  return shallowMount(WalletPanel, {
    attachTo: document.body,
    global: {
      mocks: {
        $t: (key: string, params?: { balance?: string }) =>
          params?.balance ? `${key}:${params.balance}` : key,
        $router: {},
      },
      stubs: {
        QDialog: QDialogStub,
        SeedConfirmDialog: true,
        BackupReminder: true,
        QScrollArea: { template: '<div><slot /></div>' },
        QList: { template: '<div><slot /></div>' },
        QItem: {
          template: '<button><slot /></button>',
        },
        QItemLabel: { template: '<span><slot /></span>' },
        QItemSection: { template: '<span><slot /></span>' },
        QIcon: true,
        QSeparator: true,
      },
      directives: { ripple: {} },
    },
  })
}

describe('WalletPanel (#399)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useWalletStore().seedPhrase = SEED
    useProfileStore().profile = { name: 'Alice' }
    balance.formattedBalance.value = '1 MON'
    balance.loaded.value = true
    balance.hasError.value = false
    openPage.mockReset()
  })

  it('shows the active chain balance and keeps Send and Receive reachable', async () => {
    const wrapper = mountPanel()
    expect(wrapper.get('[data-test="wallet-balance"]').text()).toBe('1 MON')
    expect(
      wrapper.get('[data-test="wallet-balance"]').attributes(),
    ).toMatchObject({ 'role': 'status', 'aria-live': 'polite' })

    await wrapper.get('[data-test="wallet-send"]').trigger('click')
    await wrapper.get('[data-test="wallet-receive"]').trigger('click')
    expect(openPage).toHaveBeenNthCalledWith(1, expect.anything(), '/send')
    expect(openPage).toHaveBeenNthCalledWith(2, expect.anything(), '/receive')
  })

  it.each([
    [false, false, 'walletPanel.balanceLoading'],
    [false, true, 'walletPanel.balanceUnavailable'],
    [true, true, 'walletPanel.balanceStale:1 MON'],
  ])(
    'shows an explicit balance state for loaded=%s error=%s',
    async (loaded, error, text) => {
      balance.loaded.value = loaded
      balance.hasError.value = error
      const wrapper = mountPanel()
      await nextTick()
      expect(wrapper.get('[data-test="wallet-balance"]').text()).toBe(text)
    },
  )

  it('updates balance status live after the panel is mounted', async () => {
    const wrapper = mountPanel()
    const value = () => wrapper.get('[data-test="wallet-balance"]').text()

    expect(value()).toBe('1 MON')
    balance.hasError.value = true
    await nextTick()
    expect(value()).toBe('walletPanel.balanceStale:1 MON')

    balance.loaded.value = false
    await nextTick()
    expect(value()).toBe('walletPanel.balanceUnavailable')

    balance.formattedBalance.value = '2 MON'
    balance.loaded.value = true
    balance.hasError.value = false
    await nextTick()
    expect(value()).toBe('2 MON')
  })

  it('closes recovery confirmation and returns focus to the Wallet panel', async () => {
    const wrapper = mountPanel()
    const vm = wrapper.vm as unknown as { seedConfirmOpen: boolean }
    vm.seedConfirmOpen = true
    await nextTick()
    wrapper.findComponent(SeedConfirmDialog).vm.$emit('confirmed')
    await nextTick()
    await nextTick()
    expect(vm.seedConfirmOpen).toBe(false)
    expect(document.activeElement).toBe(
      wrapper.get('[data-test="wallet-panel"]').element,
    )
  })

  it('does not steal focus when recovery confirmation is cancelled', async () => {
    const caller = document.createElement('button')
    document.body.appendChild(caller)
    caller.focus()
    const wrapper = mountPanel()
    const vm = wrapper.vm as unknown as { seedConfirmOpen: boolean }

    vm.seedConfirmOpen = true
    await nextTick()
    vm.seedConfirmOpen = false
    await nextTick()
    await nextTick()

    expect(document.activeElement).toBe(caller)
    caller.remove()
  })
})
