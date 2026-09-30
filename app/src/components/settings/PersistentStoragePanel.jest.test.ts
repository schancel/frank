/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'

import enUS from 'src/i18n/en-us'
import PersistentStoragePanel from './PersistentStoragePanel.vue'

const mockWallet = jest.requireActual('vue').reactive({
  seedPhrase: null as string | null,
  seedConfirmedAt: null as number | null,
})
jest.mock('src/stores/wallet', () => ({ useWalletStore: () => mockWallet }))
jest.mock('../dialogs/SeedConfirmDialog.vue', () => ({
  emits: ['confirmed'],
  template:
    '<button data-test="seed-confirm-dialog" @click="$emit(\'confirmed\')" />',
}))

const $t = (key: string) =>
  key
    .split('.')
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown>)?.[k],
      enUS,
    ) as string

const QBtn = defineComponent({
  props: { label: String },
  setup(props, { attrs }) {
    return () => h('button', { ...attrs, type: 'button' }, props.label)
  },
})
const QDialog = defineComponent({
  props: { modelValue: Boolean },
  emits: ['hide'],
  watch: {
    modelValue(open: boolean) {
      if (!open) this.$emit('hide')
    },
  },
  setup(props, { slots }) {
    return () =>
      props.modelValue
        ? h('div', { 'data-test': 'dialog-open' }, slots.default?.())
        : null
  },
})

function setManager(value: unknown) {
  Object.defineProperty(navigator, 'storage', { configurable: true, value })
}

async function render(
  opts: { seed?: string | null; confirmedAt?: number | null } = {},
) {
  setActivePinia(createPinia())
  const wallet = mockWallet
  wallet.seedPhrase = opts.seed === undefined ? 'a seed phrase' : opts.seed
  wallet.seedConfirmedAt = opts.confirmedAt ?? null
  const w = mount(PersistentStoragePanel, {
    global: { mocks: { $t }, stubs: { QBtn, QDialog } },
  })
  await flushPromises()
  return w
}

describe('Settings > Storage (ticket #370)', () => {
  afterEach(() => setManager(undefined))

  it('granted: says granted, explains, and offers no retry', async () => {
    setManager({ persisted: async () => true, persist: jest.fn() })
    const w = await render()
    expect(w.find('[data-test="persistent-storage-status"]').text()).toBe(
      'Persistent storage: granted',
    )
    expect(
      w.find('[data-test="persistent-storage-explanation"]').text(),
    ).toContain('still the only backup')
    expect(w.find('[data-test="persistent-storage-request"]').exists()).toBe(
      false,
    )
  })

  it('not granted: says so plainly, mentions Safari and the recovery phrase, and lets the user ask again', async () => {
    const persist = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    setManager({ persisted: async () => false, persist })
    const w = await render()
    expect(w.find('[data-test="persistent-storage-status"]').text()).toBe(
      'Persistent storage: not granted',
    )
    const explanation = w
      .find('[data-test="persistent-storage-explanation"]')
      .text()
    expect(explanation).toContain('Safari')
    expect(explanation).toContain('7 days')
    expect(explanation).toContain('Home Screen')
    expect(explanation).toContain('recovery phrase is the only backup')

    await w.find('[data-test="persistent-storage-request"]').trigger('click')
    await flushPromises()
    expect(persist).toHaveBeenCalledTimes(1)
    // (persisted() still says false in this fake: the panel reports the persist() answer.)
    await w.find('[data-test="persistent-storage-request"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="persistent-storage-status"]').text()).toBe(
      'Persistent storage: granted',
    )
    expect(w.find('[data-test="persistent-storage-request"]').exists()).toBe(
      false,
    )
  })

  it('unsupported: says so, explains the risk, and has nothing to ask', async () => {
    setManager(undefined)
    const w = await render()
    expect(w.find('[data-test="persistent-storage-status"]').text()).toBe(
      'Persistent storage: unavailable',
    )
    expect(
      w.find('[data-test="persistent-storage-explanation"]').text(),
    ).toContain('recovery phrase is the only backup')
    expect(w.find('[data-test="persistent-storage-request"]').exists()).toBe(
      false,
    )
  })

  it('offers the Confirm my recovery phrase shortcut until the phrase is confirmed', async () => {
    setManager({ persisted: async () => false, persist: async () => false })
    const w = await render({ confirmedAt: null })
    const button = w.find('[data-test="persistent-storage-confirm-seed"]')
    expect(button.text()).toBe('Confirm my recovery phrase')
    expect(w.find('[data-test="seed-confirm-dialog"]').exists()).toBe(false)

    await button.trigger('click')
    expect(w.find('[data-test="seed-confirm-dialog"]').exists()).toBe(true)
  })

  it('after confirming in the dialog, focus lands on the panel, not on the removed button', async () => {
    setManager({ persisted: async () => false, persist: async () => false })
    const w = await render({ confirmedAt: null })
    w.unmount()
    setActivePinia(createPinia())
    mockWallet.seedPhrase = 'a seed phrase'
    mockWallet.seedConfirmedAt = null
    const attached = mount(PersistentStoragePanel, {
      attachTo: document.body,
      global: { mocks: { $t }, stubs: { QBtn, QDialog } },
    })
    await flushPromises()
    await attached
      .find('[data-test="persistent-storage-confirm-seed"]')
      .trigger('click')
    mockWallet.seedConfirmedAt = Date.now() // the dialog's confirmation writes the marker
    await attached.find('[data-test="seed-confirm-dialog"]').trigger('click')
    await flushPromises()

    expect(document.activeElement).toBe(
      attached.find('[data-test="persistent-storage"]').element,
    )
    attached.unmount()
  })

  it('closing the dialog without confirming does not move focus', async () => {
    setManager({ persisted: async () => false, persist: async () => false })
    const w = mount(PersistentStoragePanel, {
      attachTo: document.body,
      global: { mocks: { $t }, stubs: { QBtn, QDialog } },
    })
    mockWallet.seedPhrase = 'x'
    mockWallet.seedConfirmedAt = null
    await flushPromises()
    const before = document.activeElement
    ;(w.vm as unknown as { seedConfirmOpen: boolean }).seedConfirmOpen = true
    await flushPromises()
    ;(w.vm as unknown as { seedConfirmOpen: boolean }).seedConfirmOpen = false
    await flushPromises()
    expect(document.activeElement).toBe(before)
    w.unmount()
  })

  it('a confirmed phrase shows a confirmation instead of the shortcut', async () => {
    setManager({ persisted: async () => false, persist: async () => false })
    const w = await render({ confirmedAt: Date.now() })
    expect(
      w.find('[data-test="persistent-storage-confirm-seed"]').exists(),
    ).toBe(false)
    expect(
      w.find('[data-test="persistent-storage-seed-confirmed"]').exists(),
    ).toBe(true)
  })

  it('has no shortcut when there is no stored phrase', async () => {
    setManager({ persisted: async () => false, persist: async () => false })
    const w = await render({ seed: null })
    expect(
      w.find('[data-test="persistent-storage-confirm-seed"]').exists(),
    ).toBe(false)
    expect(
      w.find('[data-test="persistent-storage-seed-confirmed"]').exists(),
    ).toBe(false)
  })
})
