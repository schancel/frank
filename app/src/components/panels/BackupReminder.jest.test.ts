/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'

jest.mock('../../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))
let mockName: string | undefined
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({ profile: { name: mockName } }),
}))

import BackupReminder, {
  resetBackupReminderDismissal,
} from './BackupReminder.vue'
import { useWalletStore } from 'src/stores/wallet'

const SEED = 'test test test test test test test test test test test junk'
const QBannerStub = defineComponent({
  template: '<div><slot /><slot name="action" /></div>',
})
const QBtnStub = defineComponent({
  props: { label: { type: String, default: '' } },
  template: '<button>{{ label }}</button>',
})

function mountReminder() {
  return mount(BackupReminder, {
    global: {
      mocks: { $t: (k: string) => k },
      stubs: { QBanner: QBannerStub, QBtn: QBtnStub },
    },
  })
}

describe('BackupReminder (#284)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetBackupReminderDismissal()
    mockName = undefined
  })

  it('is offered to a completed account that never confirmed', () => {
    mockName = 'Alice'
    useWalletStore().seedPhrase = SEED
    expect(mountReminder().find('[data-test="backup-reminder"]').exists()).toBe(
      true,
    )
  })

  it.each([
    ['fresh (no seed)', undefined, null, null],
    ['affected-by-#267 (seed, no name)', undefined, SEED, null],
    ['confirmed', 'Alice', SEED, 5],
  ])('is not shown for %s', (_label, name, seed, at) => {
    mockName = name
    const wallet = useWalletStore()
    wallet.seedPhrase = seed
    wallet.seedConfirmedAt = at
    expect(mountReminder().find('[data-test="backup-reminder"]').exists()).toBe(
      false,
    )
  })

  it('is dismissible and does not block: dismissing changes no stored state', async () => {
    mockName = 'Alice'
    const wallet = useWalletStore()
    wallet.seedPhrase = SEED
    const w = mountReminder()
    await w.get('[data-test="backup-reminder-dismiss"]').trigger('click')
    await nextTick()
    expect(w.find('[data-test="backup-reminder"]').exists()).toBe(false)
    expect(wallet.seedPhrase).toBe(SEED)
    expect(wallet.seedConfirmedAt).toBeNull()
  })

  it('asks its parent to open the confirmation, changing nothing itself', async () => {
    mockName = 'Alice'
    const wallet = useWalletStore()
    wallet.seedPhrase = SEED
    const w = mountReminder()
    await w.get('[data-test="backup-reminder-confirm"]').trigger('click')
    expect(w.emitted('confirm')).toHaveLength(1)
    expect(wallet.seedConfirmedAt).toBeNull()
  })

  it('disappears once the phrase is confirmed', async () => {
    mockName = 'Alice'
    const wallet = useWalletStore()
    wallet.seedPhrase = SEED
    const w = mountReminder()
    wallet.setSeedPhrase(SEED, Date.now())
    await nextTick()
    expect(w.find('[data-test="backup-reminder"]').exists()).toBe(false)
  })
})
