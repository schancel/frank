/** @jest-environment jsdom */

import { mount, VueWrapper } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, nextTick } from 'vue'

import enUS from 'src/i18n/en-us'
import frFR from 'src/i18n/fr-fr'
import { activeChain } from '@frank/wallet/chain'
import { peerOffersDealerTable } from 'src/utils/blackjack-bet'
import { openChat } from 'src/utils/routes'
import AddContact from './AddContact.vue'

const mockAddContactToStore = jest.fn()
jest.mock('src/stores/contacts', () => ({
  defaultRelayData: { profile: { name: '', bio: '', avatar: '' } },
  useContactStore: () => ({ addContact: mockAddContactToStore }),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    parseAddress: jest.fn(),
    formatAddress: jest.fn(),
    fetchProfile: jest.fn(),
  },
}))
jest.mock('bitcore-lib-xpi', () => ({
  PublicKey: { fromBuffer: jest.fn(() => ({ kind: 'public-key' })) },
}))
jest.mock('src/utils/routes', () => ({ openChat: jest.fn() }))
const mockOwnAddress = jest.fn()
jest.mock('src/utils/own-address', () => ({
  getOwnCanonicalAddress: () => mockOwnAddress(),
}))

type ChainAddress = { raw: string }
type ProfileInfo = {
  address: ChainAddress
  name?: string
  bot?: boolean
  pubKey: Uint8Array
}
type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

const DEBOUNCE_MS = 250
const ADDRESS_A = 'canonical:a'
const ADDRESS_B = 'canonical:b'
const ADDRESS_C = 'canonical:c'
const ADDRESS_OWN = 'canonical:own'
// Different spellings of the same canonical address ('A' is a re-cased 'a').
const parsedAddresses: Record<string, ChainAddress> = {
  a: { raw: ADDRESS_A },
  A: { raw: ADDRESS_A },
  [ADDRESS_A]: { raw: ADDRESS_A },
  b: { raw: ADDRESS_B },
  c: { raw: ADDRESS_C },
  // Checksum, lowercase and padded spellings of the user's own address.
  OWN: { raw: ADDRESS_OWN },
  own: { raw: ADDRESS_OWN },
}
const chain = activeChain as unknown as {
  parseAddress: jest.Mock
  formatAddress: jest.Mock
  fetchProfile: jest.Mock
}
const mockOpenChat = openChat as jest.Mock
const mockRouter = { go: jest.fn(), push: jest.fn() }

function translate(key: string, params: Record<string, unknown> = {}): string {
  const value = key
    .split('.')
    .reduce<any>((node, part) => node?.[part], enUS as any)
  return typeof value === 'string'
    ? value.replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k]))
    : key
}

// Quasar's real components render nothing under the SSR build Jest is aliased to, so each Q*
// element becomes a plain element that keeps the attributes/listeners/slots the page puts on it.
function passthrough(tag: string) {
  return defineComponent({
    props: { modelValue: null, label: null },
    setup(props, { slots }) {
      return () =>
        h(tag, [props.label as string | undefined, slots.default?.()])
    },
  })
}
const QInputStub = defineComponent({
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h('input', {
        value: props.modelValue,
        onInput: (e: Event) =>
          emit('update:modelValue', (e.target as HTMLInputElement).value),
      })
  },
})
const QBtnStub = defineComponent({
  props: { label: String, disable: Boolean },
  setup(props) {
    return () => h('button', { disabled: props.disable }, props.label)
  },
})
const quasarStubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(name => /^Q[A-Z]/.test(name))
    .map(name => [name, passthrough('div')]),
)
quasarStubs.QInput = QInputStub
quasarStubs.QBtn = QBtnStub

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function profile(address: string, name: string): ProfileInfo {
  return { address: { raw: address }, name, pubKey: Uint8Array.from([2]) }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
  await nextTick()
}

function mountPage(): VueWrapper {
  return mount(AddContact, {
    global: {
      components: quasarStubs,
      mocks: { $t: translate, $router: mockRouter },
    },
  })
}

// Types into the address field and lets the watcher run (the lookup itself is still debounced).
async function type(wrapper: VueWrapper, value: string): Promise<void> {
  await wrapper.find('input').setValue(value)
  await settle()
}
// Types, waits out the debounce so the lookup fires, and lets it reach the (deferred) fetch.
async function typeAndFire(wrapper: VueWrapper, value: string): Promise<void> {
  await type(wrapper, value)
  jest.advanceTimersByTime(DEBOUNCE_MS)
  await settle()
}

const addButton = (w: VueWrapper) =>
  w.findAll('button').find(b => b.text() === 'Add')!
const isBusy = (w: VueWrapper) => w.find('input').attributes('aria-busy')
const status = (w: VueWrapper) => w.find('[role="status"]').text()
const skeletons = (w: VueWrapper) => w.findAll('[aria-hidden="true"]')
const notFoundCard = (w: VueWrapper) => w.find('[name="error"]')

describe('AddContact latest lookup', () => {
  let wrapper: VueWrapper

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
    mockAddContactToStore.mockReset()
    mockOpenChat.mockReset()
    mockRouter.go.mockReset()
    mockRouter.push.mockReset()
    chain.parseAddress.mockReset()
    chain.formatAddress.mockReset()
    chain.fetchProfile.mockReset()
    mockOwnAddress.mockReset()
    mockOwnAddress.mockResolvedValue(ADDRESS_OWN)
    chain.parseAddress.mockImplementation(input => parsedAddresses[input])
    chain.formatAddress.mockImplementation(address => address.raw)
    wrapper = mountPage()
  })

  afterEach(() => {
    wrapper.unmount()
    jest.useRealTimers()
  })

  it('canonicalizes the lookup, fetches once, and commits the exact accepted pair', async () => {
    chain.fetchProfile.mockResolvedValue(profile(ADDRESS_A, 'Alice'))

    await typeAndFire(wrapper, '  a  ')

    expect(chain.parseAddress).toHaveBeenCalledWith('a')
    expect(chain.fetchProfile).toHaveBeenCalledTimes(1)
    expect(chain.fetchProfile).toHaveBeenCalledWith(parsedAddresses.a)
    expect(status(wrapper)).toContain('Alice')
    expect(addButton(wrapper).attributes('disabled')).toBeUndefined()

    await addButton(wrapper).trigger('click')

    expect(mockAddContactToStore).toHaveBeenCalledTimes(1)
    expect(mockAddContactToStore).toHaveBeenCalledWith({
      address: ADDRESS_A,
      contact: {
        profile: expect.objectContaining({
          name: 'Alice',
          bio: '',
          avatar: '',
        }),
      },
    })
    // The canonical resolved address, not the raw '  a  ' the user typed.
    expect(mockOpenChat).toHaveBeenCalledTimes(1)
    expect(mockOpenChat).toHaveBeenCalledWith(mockRouter, ADDRESS_A)
  })

  it('commits dealer signed-name provenance from the first validated fetch', async () => {
    chain.fetchProfile.mockResolvedValue({
      ...profile(ADDRESS_A, 'Blackjack Dealer'),
      bot: true,
    })

    await typeAndFire(wrapper, 'a')
    await addButton(wrapper).trigger('click')

    expect(chain.fetchProfile).toHaveBeenCalledTimes(1)
    const storedProfile = mockAddContactToStore.mock.calls[0][0].contact.profile
    expect(storedProfile.signedName).toBe('Blackjack Dealer')
    expect(
      peerOffersDealerTable(storedProfile, ADDRESS_A, [
        { address: ADDRESS_A, name: 'Blackjack Dealer' },
      ]),
    ).toBe(true)
  })

  it.each([
    ['blank', ''],
    ['missing', undefined],
  ])(
    'keeps a %s signed name fail-closed after the first validated fetch',
    async (_description, name) => {
      chain.fetchProfile.mockResolvedValue({
        address: { raw: ADDRESS_A },
        name,
        bot: true,
        pubKey: Uint8Array.from([2]),
      })

      await typeAndFire(wrapper, 'a')
      await addButton(wrapper).trigger('click')

      expect(chain.fetchProfile).toHaveBeenCalledTimes(1)
      const storedProfile =
        mockAddContactToStore.mock.calls[0][0].contact.profile
      expect(storedProfile.signedName).toBe(name ?? null)
      expect(
        peerOffersDealerTable(storedProfile, ADDRESS_A, [
          { address: ADDRESS_A, name: 'Blackjack Dealer' },
        ]),
      ).toBe(false)
    },
  )

  it('adds through the Enter key only when a lookup was accepted', async () => {
    chain.fetchProfile.mockResolvedValue(profile(ADDRESS_A, 'Alice'))
    await wrapper.find('input').trigger('keydown.enter')
    expect(mockAddContactToStore).not.toHaveBeenCalled()

    await type(wrapper, 'a')
    await wrapper.find('input').trigger('keydown.enter')
    expect(mockOpenChat).toHaveBeenCalledWith(mockRouter, ADDRESS_A)
  })

  describe('leading-edge debounce', () => {
    const pending = () => new Promise<undefined>(() => undefined)

    it('fetches a valid paste immediately, with no timer advanced', async () => {
      chain.fetchProfile.mockReturnValue(pending())

      await type(wrapper, 'a')

      expect(chain.fetchProfile).toHaveBeenCalledTimes(1)
      expect(chain.fetchProfile).toHaveBeenCalledWith(parsedAddresses.a)
      expect(isBusy(wrapper)).toBe('true')
    })

    it('debounces a second edit made while the first lookup is in flight', async () => {
      chain.fetchProfile.mockReturnValue(pending())

      await type(wrapper, 'a')
      await type(wrapper, 'b')
      expect(chain.fetchProfile).toHaveBeenCalledTimes(1)
      expect(isBusy(wrapper)).toBe('true')
      jest.advanceTimersByTime(DEBOUNCE_MS - 1)
      await settle()
      expect(chain.fetchProfile).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(1)
      await settle()

      expect(chain.fetchProfile).toHaveBeenCalledTimes(2)
      expect(chain.fetchProfile).toHaveBeenLastCalledWith(parsedAddresses.b)
    })

    it('debounces an edit shortly after a lookup that already finished', async () => {
      chain.fetchProfile.mockResolvedValue(profile(ADDRESS_A, 'Alice'))

      await type(wrapper, 'a')
      await settle()
      await type(wrapper, 'b')
      expect(chain.fetchProfile).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(DEBOUNCE_MS)
      await settle()
      expect(chain.fetchProfile).toHaveBeenCalledTimes(2)
    })

    it('fetches immediately again once the window has passed and nothing is in flight', async () => {
      chain.fetchProfile.mockResolvedValue(profile(ADDRESS_A, 'Alice'))

      await type(wrapper, 'a')
      await settle()
      jest.advanceTimersByTime(DEBOUNCE_MS)
      await type(wrapper, 'b')

      expect(chain.fetchProfile).toHaveBeenCalledTimes(2)
    })

    it('issues one further fetch, for the last value, after a rapid burst', async () => {
      chain.fetchProfile.mockReturnValue(pending())

      await type(wrapper, 'a')
      await type(wrapper, 'b')
      jest.advanceTimersByTime(DEBOUNCE_MS - 1)
      await type(wrapper, 'A')
      jest.advanceTimersByTime(DEBOUNCE_MS - 1)
      await type(wrapper, 'c')
      expect(chain.fetchProfile).toHaveBeenCalledTimes(1)

      jest.advanceTimersByTime(DEBOUNCE_MS)
      await settle()

      expect(chain.fetchProfile).toHaveBeenCalledTimes(2)
      expect(chain.fetchProfile).toHaveBeenLastCalledWith(parsedAddresses.c)
    })

    it('drops the scheduled lookup when the input becomes empty or unparseable', async () => {
      chain.fetchProfile.mockReturnValue(pending())

      await type(wrapper, 'a')
      await type(wrapper, 'b')
      await type(wrapper, '')
      expect(isBusy(wrapper)).toBe('false')
      await type(wrapper, 'c')
      await type(wrapper, 'not-an-address')
      jest.advanceTimersByTime(DEBOUNCE_MS * 2)
      await settle()

      expect(chain.fetchProfile).toHaveBeenCalledTimes(1)
      expect(isBusy(wrapper)).toBe('false')
    })

    it('cancels the scheduled lookup on unmount', async () => {
      chain.fetchProfile.mockReturnValue(pending())
      const other = mountPage()
      await other.find('input').setValue('a')
      await settle()
      await other.find('input').setValue('b')
      await settle()
      expect(chain.fetchProfile).toHaveBeenCalledTimes(1)
      other.unmount()
      jest.advanceTimersByTime(DEBOUNCE_MS * 2)
      await settle()

      expect(chain.fetchProfile).toHaveBeenCalledTimes(1)
    })
  })

  describe('own address (#276)', () => {
    const ownMessage = translate('newContactDialog.ownAddress')
    const ownFr = frFR.newContactDialog.ownAddress

    it.each(['OWN', 'own', '  own  '])(
      'blocks Add and explains for the own-address spelling %j',
      async spelling => {
        chain.fetchProfile.mockResolvedValue(profile(ADDRESS_OWN, 'Alice'))

        await typeAndFire(wrapper, spelling)

        expect(addButton(wrapper).attributes('disabled')).toBeDefined()
        expect(status(wrapper)).toBe(ownMessage)
        expect(wrapper.text()).toContain(ownMessage)
        expect(isBusy(wrapper)).toBe('false')
        // Own address is never looked up.
        expect(chain.fetchProfile).not.toHaveBeenCalled()
        await wrapper.find('input').trigger('keydown.enter')
        await addButton(wrapper).trigger('click')
        expect(mockAddContactToStore).not.toHaveBeenCalled()
        expect(mockOpenChat).not.toHaveBeenCalled()
      },
    )

    it('has the message in both locales', () => {
      expect(ownMessage).not.toBe('newContactDialog.ownAddress')
      expect(ownFr).toBeTruthy()
      expect(ownFr).not.toBe(ownMessage)
    })

    it("leaves someone else's address unaffected", async () => {
      chain.fetchProfile.mockResolvedValue(profile(ADDRESS_B, 'Bob'))

      await typeAndFire(wrapper, 'b')

      expect(addButton(wrapper).attributes('disabled')).toBeUndefined()
      expect(status(wrapper)).toContain('Bob')
      expect(wrapper.text()).not.toContain(ownMessage)
    })

    it('clears the message when the address changes', async () => {
      chain.fetchProfile.mockResolvedValue(profile(ADDRESS_B, 'Bob'))
      await typeAndFire(wrapper, 'own')
      expect(wrapper.text()).toContain(ownMessage)

      await typeAndFire(wrapper, 'b')
      expect(wrapper.text()).not.toContain(ownMessage)
      expect(status(wrapper)).toContain('Bob')

      await typeAndFire(wrapper, 'own')
      await type(wrapper, '')
      expect(wrapper.text()).not.toContain(ownMessage)
    })

    it('never enables Add for own after a rapid retype between own and another', async () => {
      const lookupB = deferred<ProfileInfo | undefined>()
      const ownOwner = deferred<string | null>()
      chain.fetchProfile.mockImplementation(() => lookupB.promise)
      // The own-address lookup is slow: B is typed, then own, and B resolves last.
      mockOwnAddress.mockImplementation(() => ownOwner.promise)

      await typeAndFire(wrapper, 'b')
      await typeAndFire(wrapper, 'own')
      ownOwner.resolve(ADDRESS_OWN)
      await settle()
      lookupB.resolve(profile(ADDRESS_B, 'Bob'))
      await settle()

      expect(wrapper.text()).toContain(ownMessage)
      expect(addButton(wrapper).attributes('disabled')).toBeDefined()
    })

    it('does not let a stale own-address verdict override a newer address', async () => {
      const ownOwner = deferred<string | null>()
      mockOwnAddress
        .mockImplementationOnce(() => ownOwner.promise)
        .mockResolvedValue(ADDRESS_OWN)
      chain.fetchProfile.mockResolvedValue(profile(ADDRESS_B, 'Bob'))

      await typeAndFire(wrapper, 'own')
      await typeAndFire(wrapper, 'b')
      ownOwner.resolve(ADDRESS_OWN)
      await settle()

      expect(wrapper.text()).not.toContain(ownMessage)
      expect(status(wrapper)).toContain('Bob')
      expect(addButton(wrapper).attributes('disabled')).toBeUndefined()
    })
  })

  it('keeps B when B resolves before an older A lookup', async () => {
    const lookupA = deferred<ProfileInfo | undefined>()
    const lookupB = deferred<ProfileInfo | undefined>()
    chain.fetchProfile
      .mockImplementationOnce(() => lookupA.promise)
      .mockImplementationOnce(() => lookupB.promise)

    await typeAndFire(wrapper, 'a')
    await typeAndFire(wrapper, 'b')
    lookupB.resolve(profile(ADDRESS_B, 'Bob'))
    await settle()
    expect(status(wrapper)).toContain('Bob')

    lookupA.resolve(profile(ADDRESS_A, 'Alice'))
    await settle()
    expect(status(wrapper)).toContain('Bob')

    await addButton(wrapper).trigger('click')
    expect(mockAddContactToStore).toHaveBeenCalledWith({
      address: ADDRESS_B,
      contact: { profile: expect.objectContaining({ name: 'Bob' }) },
    })
    expect(mockOpenChat).toHaveBeenCalledWith(mockRouter, ADDRESS_B)
  })

  it('ignores a stale rejection and a stale not-found completion', async () => {
    const staleRejection = deferred<ProfileInfo | undefined>()
    const currentB = deferred<ProfileInfo | undefined>()
    const staleNotFound = deferred<ProfileInfo | undefined>()
    const currentA = deferred<ProfileInfo | undefined>()
    chain.fetchProfile
      .mockImplementationOnce(() => staleRejection.promise)
      .mockImplementationOnce(() => currentB.promise)
      .mockImplementationOnce(() => staleNotFound.promise)
      .mockImplementationOnce(() => currentA.promise)

    await typeAndFire(wrapper, 'a')
    await typeAndFire(wrapper, 'b')
    currentB.resolve(profile(ADDRESS_B, 'Bob'))
    await settle()
    staleRejection.reject(new Error('old lookup failed'))
    await settle()
    expect(status(wrapper)).toContain('Bob')

    await typeAndFire(wrapper, 'c')
    await typeAndFire(wrapper, 'a')
    currentA.resolve(profile(ADDRESS_A, 'Alice'))
    await settle()
    staleNotFound.resolve(undefined)
    await settle()
    expect(status(wrapper)).toContain('Alice')
  })

  it('ignores A settling while B is pending and refuses Add', async () => {
    const lookupA = deferred<ProfileInfo | undefined>()
    const lookupB = deferred<ProfileInfo | undefined>()
    chain.fetchProfile
      .mockImplementationOnce(() => lookupA.promise)
      .mockImplementationOnce(() => lookupB.promise)

    await typeAndFire(wrapper, 'a')
    await typeAndFire(wrapper, 'b')
    lookupA.resolve(profile(ADDRESS_A, 'Alice'))
    await settle()

    expect(isBusy(wrapper)).toBe('true')
    expect(addButton(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.find('input').trigger('keydown.enter')
    expect(mockAddContactToStore).not.toHaveBeenCalled()
    expect(mockOpenChat).not.toHaveBeenCalled()
  })

  it('keeps the current lookup pending when a stale lookup rejects', async () => {
    const staleRejection = deferred<ProfileInfo | undefined>()
    const currentB = deferred<ProfileInfo | undefined>()
    chain.fetchProfile
      .mockImplementationOnce(() => staleRejection.promise)
      .mockImplementationOnce(() => currentB.promise)

    await typeAndFire(wrapper, 'a')
    await typeAndFire(wrapper, 'b')
    staleRejection.reject(new Error('old lookup failed'))
    await settle()

    expect(isBusy(wrapper)).toBe('true')
    expect(skeletons(wrapper)).toHaveLength(3)
    expect(status(wrapper)).toBe(translate('newContactDialog.loading'))

    currentB.resolve(profile(ADDRESS_B, 'Bob'))
    await settle()
    expect(isBusy(wrapper)).toBe('false')
    expect(status(wrapper)).toContain('Bob')
  })

  it('clears pending when the current lookup itself rejects', async () => {
    chain.fetchProfile.mockRejectedValue(new Error('offline'))

    await typeAndFire(wrapper, 'a')

    expect(isBusy(wrapper)).toBe('false')
    expect(addButton(wrapper).attributes('disabled')).toBeDefined()
  })

  describe('retyping the same address in a different case', () => {
    // 'a' and 'A' canonicalize to the same address, so only the lookup generation can tell the
    // older request from the newer one.
    it('does not let the older lookup overwrite the newer one when it resolves last', async () => {
      const older = deferred<ProfileInfo | undefined>()
      const newer = deferred<ProfileInfo | undefined>()
      chain.fetchProfile
        .mockImplementationOnce(() => older.promise)
        .mockImplementationOnce(() => newer.promise)

      await typeAndFire(wrapper, 'a')
      await typeAndFire(wrapper, 'A')
      newer.resolve(profile(ADDRESS_A, 'Newer'))
      await settle()
      older.resolve(profile(ADDRESS_A, 'Older'))
      await settle()

      expect(status(wrapper)).toContain('Newer')
      await addButton(wrapper).trigger('click')
      expect(mockAddContactToStore).toHaveBeenCalledWith({
        address: ADDRESS_A,
        contact: { profile: expect.objectContaining({ name: 'Newer' }) },
      })
    })

    it('does not accept the older lookup while the newer one is still pending', async () => {
      const older = deferred<ProfileInfo | undefined>()
      const newer = deferred<ProfileInfo | undefined>()
      chain.fetchProfile
        .mockImplementationOnce(() => older.promise)
        .mockImplementationOnce(() => newer.promise)

      await typeAndFire(wrapper, 'a')
      await typeAndFire(wrapper, 'A')
      older.resolve(profile(ADDRESS_A, 'Older'))
      await settle()

      expect(isBusy(wrapper)).toBe('true')
      expect(addButton(wrapper).attributes('disabled')).toBeDefined()
      expect(status(wrapper)).toBe(translate('newContactDialog.loading'))
    })
  })

  it('invalidates an accepted lookup when the input is cleared or changed', async () => {
    chain.fetchProfile.mockResolvedValue(profile(ADDRESS_A, 'Alice'))

    await typeAndFire(wrapper, 'a')
    expect(addButton(wrapper).attributes('disabled')).toBeUndefined()
    await type(wrapper, '')
    expect(addButton(wrapper).attributes('disabled')).toBeDefined()

    await typeAndFire(wrapper, 'a')
    expect(addButton(wrapper).attributes('disabled')).toBeUndefined()
    await type(wrapper, 'not-an-address')
    expect(addButton(wrapper).attributes('disabled')).toBeDefined()

    await typeAndFire(wrapper, 'a')
    expect(addButton(wrapper).attributes('disabled')).toBeUndefined()
    await type(wrapper, 'b') // valid, lookup not yet fired
    expect(addButton(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.find('input').trigger('keydown.enter')
    expect(mockAddContactToStore).not.toHaveBeenCalled()
  })

  it('rejects a profile whose returned address does not match the requested address', async () => {
    chain.fetchProfile.mockResolvedValue(profile(ADDRESS_B, 'Impostor'))

    await typeAndFire(wrapper, 'a')

    expect(addButton(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.find('input').trigger('keydown.enter')
    expect(mockAddContactToStore).not.toHaveBeenCalled()
    expect(mockOpenChat).not.toHaveBeenCalled()
  })

  describe('not-found state', () => {
    it('shows the card and announces it for a non-empty unresolvable address', async () => {
      await type(wrapper, 'not-an-address')

      expect(notFoundCard(wrapper).exists()).toBe(true)
      expect(status(wrapper)).toBe(translate('newContactDialog.notFound'))
    })

    it.each(['   ', '\t'])(
      'shows neither the card nor an announcement for whitespace-only input %j',
      async value => {
        await type(wrapper, 'not-an-address')
        await type(wrapper, value)

        expect(notFoundCard(wrapper).exists()).toBe(false)
        expect(status(wrapper)).toBe('')
      },
    )

    it('shows the card for a resolved-but-missing profile once loading ends', async () => {
      chain.fetchProfile.mockResolvedValue(undefined)

      await typeAndFire(wrapper, 'a')

      expect(notFoundCard(wrapper).exists()).toBe(true)
      expect(status(wrapper)).toBe(translate('newContactDialog.notFound'))
    })
  })

  it('has a persistent localized status region and bounded decorative skeletons', async () => {
    expect(wrapper.find('[role="status"][aria-live="polite"]').exists()).toBe(
      true,
    )
    expect(skeletons(wrapper)).toHaveLength(0)
    expect(isBusy(wrapper)).toBe('false')

    chain.fetchProfile.mockReturnValue(new Promise(() => undefined))
    await typeAndFire(wrapper, 'a')

    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    expect(skeletons(wrapper)).toHaveLength(3)
    expect(status(wrapper)).toBe(enUS.newContactDialog.loading)
    expect(enUS.newContactDialog.found).toContain('{name}')
    expect(frFR.newContactDialog.loading).toBeTruthy()
    expect(frFR.newContactDialog.found).toContain('{name}')
  })
})
