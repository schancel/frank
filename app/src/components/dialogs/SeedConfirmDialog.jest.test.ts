/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'

jest.mock('../../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))

import SeedConfirmDialog from './SeedConfirmDialog.vue'
import { useWalletStore } from 'src/stores/wallet'

const SEED = 'test test test test test test test test test test test junk'
const Pass = defineComponent({ template: '<div><slot /></div>' })

function mountDialog() {
  return mount(SeedConfirmDialog, {
    global: {
      mocks: { $t: (k: string, p?: { n?: number }) => (p ? `${k}:${p.n}` : k) },
      stubs: {
        QCard: Pass,
        QCardSection: Pass,
        QCardActions: Pass,
        QBtn: true,
      },
      directives: { closePopup: {} },
    },
  })
}

async function submit(w: ReturnType<typeof mountDialog>, words: string[]) {
  const inputs = w.findAll('input')
  for (let i = 0; i < inputs.length; i++) await inputs[i].setValue(words[i])
  await w.find('form').trigger('submit')
  await nextTick()
}

describe('SeedConfirmDialog (stored seed, #284)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('asks about the STORED phrase and marks it confirmed without changing the seed', async () => {
    const wallet = useWalletStore()
    wallet.seedPhrase = SEED
    const w = mountDialog()
    const positions = w
      .findAll('label')
      .map(l => Number(l.text().split(':')[1]))
    expect(positions).toHaveLength(3)
    const words = SEED.split(' ')

    await submit(
      w,
      positions.map(p => words[p - 1]),
    )

    expect(wallet.seedPhrase).toBe(SEED)
    expect(wallet.seedConfirmedAt).toEqual(expect.any(Number))
    expect(w.emitted('confirmed')).toHaveLength(1)
  })

  it('wrong answers leave the account unconfirmed and the seed untouched', async () => {
    const wallet = useWalletStore()
    wallet.seedPhrase = SEED
    const w = mountDialog()

    await submit(w, ['nope', 'nope', 'nope'])

    expect(wallet.seedPhrase).toBe(SEED)
    expect(wallet.seedConfirmedAt).toBeNull()
    expect(w.emitted('confirmed')).toBeUndefined()
  })

  it('renders nothing to confirm when there is no stored seed, and writes nothing', () => {
    const wallet = useWalletStore()
    const w = mountDialog()
    expect(w.find('form').exists()).toBe(false)
    expect(wallet.seedPhrase).toBeNull()
    expect(wallet.seedConfirmedAt).toBeNull()
  })
})
