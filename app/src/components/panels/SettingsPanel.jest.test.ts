/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'

jest.mock('../../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(() =>
    Promise.resolve({ identity: { displayAddress: '0x0' } }),
  ),
}))
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({ deleteMessage: jest.fn() }),
}))
jest.mock('./ContactCard.vue', () => ({ template: '<div />' }))
jest.mock('../dialogs/ContactBookDialog.vue', () => ({ template: '<div />' }))
jest.mock('../dialogs/SeedPhraseDialog.vue', () => ({ template: '<div />' }))
jest.mock('../../utils/routes', () => ({
  openChat: jest.fn(),
  openPage: jest.fn(),
}))

import SettingsPanel from './SettingsPanel.vue'
import SeedConfirmDialog from '../dialogs/SeedConfirmDialog.vue'
import { useWalletStore } from 'src/stores/wallet'
import { useProfileStore } from 'src/stores/my-profile'

const SEED = 'test test test test test test test test test test test junk'

// q-dialog: render its slot only while modelValue is true, and expose @hide.
const QDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  emits: ['update:modelValue', 'hide'],
  watch: {
    modelValue(v: boolean, old: boolean) {
      if (old && !v) this.$emit('hide')
    },
  },
  template: '<div v-if="modelValue"><slot /></div>',
})

function mountPanel() {
  return shallowMount(SettingsPanel, {
    attachTo: document.body,
    global: {
      mocks: { $t: (k: string) => k, $router: {} },
      stubs: {
        QDialog: QDialogStub,
        SeedConfirmDialog: true,
        BackupReminder: true,
        QScrollArea: true,
        QList: true,
        QItem: true,
        QIcon: true,
        QItemSection: true,
        QSeparator: true,
      },
      directives: { ripple: {} },
    },
  })
}

describe('SettingsPanel confirm dialog (#284)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useWalletStore().seedPhrase = SEED
    useProfileStore().profile = { name: 'Alice' }
  })

  it('closes the dialog after a successful confirmation and returns focus to the panel', async () => {
    const w = mountPanel()
    const vm = w.vm as unknown as { seedConfirmOpen: boolean }
    vm.seedConfirmOpen = true
    await nextTick()
    const dialog = w.findComponent(SeedConfirmDialog)
    expect(dialog.exists()).toBe(true)

    dialog.vm.$emit('confirmed')
    await nextTick()
    await nextTick()

    expect(vm.seedConfirmOpen).toBe(false)
    expect(w.findComponent(SeedConfirmDialog).exists()).toBe(false)
    const root = w.get('[data-test="settings-panel"]')
    expect(root.attributes('aria-label')).toBe('SettingPanel.panelLabel')
    expect(root.attributes('role')).toBe('region')
    expect(document.activeElement).toBe(
      w.get('[data-test="settings-panel"]').element,
    )
    w.unmount()
  })

  it('closing without confirming does not steal focus', async () => {
    const w = mountPanel()
    const vm = w.vm as unknown as { seedConfirmOpen: boolean }
    vm.seedConfirmOpen = true
    await nextTick()
    vm.seedConfirmOpen = false
    await nextTick()
    await nextTick()
    expect(document.activeElement).not.toBe(
      w.get('[data-test="settings-panel"]').element,
    )
    w.unmount()
  })
})
