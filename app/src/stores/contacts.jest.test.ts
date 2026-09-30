/**
 * Unit tests for `stores/contacts.ts`'s rewiring onto `ActiveChain` (ticket #42). Mocks
 * `activeChain.fetchProfile` (the seam #42 is scoped to use), not the underlying HTTP/Monad
 * identity module (`monad-identity.ts`'s `fetchMonadProfile`, already tested by ticket #41).
 * `activeChain.parseAddress`/`formatAddress` run for real (pure, no network).
 *
 * `contacts.ts` imports `chats.ts` (for `deleteContact`/`addDefaultContact`); see
 * `chats.jest.test.ts`'s own header for why `../adapters/level-message-store` and
 * `../utils/notifications` need mocking here too.
 */
import { createPinia, setActivePinia } from 'pinia'

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* no persisted Lotus-era messages in tests */
    },
  }),
}))
jest.mock('../utils/notifications', () => ({
  desktopNotify: jest.fn(),
}))

// Only the wallet handle is faked; the real own-address.ts (lazy import, parse/format) runs.
const mockUseActiveWallet = jest.fn()
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: () => mockUseActiveWallet(),
}))

import { useChatStore } from './chats'
import {
  isBlankName,
  omitSessionCuratedDefaults,
  rehydrateContacts,
  useContactStore,
} from './contacts'
import type { ContactState } from './contacts'
import { activeChain } from '@frank/wallet/chain'

import { toChainDisplayAddress as toDisplay } from '../utils/chain-address'

const ADDRESS = '0x3e3e3e3e3e3E3E3E3e3e3E3E3e3e3E3E3e3E3E3e'
const ADDRESS_LOWERCASE = ADDRESS.toLowerCase()

// A syntactically valid 33-byte compressed secp256k1 public key (the generator point).
const PUB_KEY_HEX =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const PUB_KEY_BYTES = Uint8Array.from(Buffer.from(PUB_KEY_HEX, 'hex'))

describe('stores/contacts.ts (ticket #42)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    mockUseActiveWallet.mockReset()
    mockUseActiveWallet.mockRejectedValue(new Error('wallet not initialized'))
  })

  describe('fetchAndAddContact', () => {
    it('resolves a profile via activeChain.fetchProfile and stores it under the canonical address', async () => {
      const contacts = useContactStore()
      const fetchProfileSpy = jest
        .spyOn(activeChain, 'fetchProfile')
        .mockResolvedValue({
          address: { raw: ADDRESS },
          pubKey: PUB_KEY_BYTES,
        })

      await contacts.fetchAndAddContact({
        address: ADDRESS_LOWERCASE,
        contact: undefined as unknown as Partial<ContactState>,
      })

      expect(fetchProfileSpy).toHaveBeenCalledWith({ raw: ADDRESS })
      expect(contacts.isContact(ADDRESS)).toBe(true)
      const contact = contacts.getContact(ADDRESS)
      expect(contact.relayURL).toBeNull()
      expect(contact.profile.pubKey).not.toBeNull()
    })

    it('records the bot marker of the signed profile (#310 gate); unmarked profiles are not bots', async () => {
      const contacts = useContactStore()
      const spy = jest.spyOn(activeChain, 'fetchProfile')
      spy.mockResolvedValue({
        address: { raw: ADDRESS },
        pubKey: PUB_KEY_BYTES,
        bot: true,
      })
      await contacts.fetchAndAddContact({
        address: ADDRESS,
        contact: undefined as unknown as Partial<ContactState>,
      })
      expect(contacts.getContact(ADDRESS).profile.isBot).toBe(true)

      const other = '0x4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f'
      spy.mockResolvedValue({ address: { raw: other }, pubKey: PUB_KEY_BYTES })
      await contacts.fetchAndAddContact({
        address: other,
        contact: undefined as unknown as Partial<ContactState>,
      })
      expect(contacts.getContact(other).profile.isBot).toBe(false)
    })

    it('a contact added by route navigation (empty contact) is refreshed so its bot marker is resolved', async () => {
      const contacts = useContactStore()
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: ADDRESS },
        pubKey: PUB_KEY_BYTES,
        bot: true,
      })
      await contacts.fetchAndAddContact({ address: ADDRESS, contact: {} })
      await new Promise(r => setTimeout(r, 0))
      expect(contacts.getContact(ADDRESS).profile.isBot).toBe(true)
    })

    it('refresh picks up the bot marker for a contact whose marker was never looked up', async () => {
      const contacts = useContactStore()
      contacts.addContact({
        address: ADDRESS,
        contact: {
          lastUpdateTime: Date.now(),
          profile: { name: 'Dealer', bio: '', avatar: 'x', pubKey: null },
        },
      })
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: ADDRESS },
        pubKey: PUB_KEY_BYTES,
        bot: true,
      })
      await contacts.refresh(ADDRESS)
      expect(contacts.getContact(ADDRESS).profile.isBot).toBe(true)
    })

    it('does not add a contact when activeChain.fetchProfile finds nothing registered', async () => {
      const contacts = useContactStore()
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue(undefined)

      await contacts.fetchAndAddContact({
        address: ADDRESS,
        contact: undefined as unknown as Partial<ContactState>,
      })

      expect(contacts.isContact(ADDRESS)).toBe(false)
    })

    it.each([ADDRESS, ADDRESS_LOWERCASE])(
      'refuses to add the current identity as its own contact (%s)',
      async spelling => {
        const contacts = useContactStore()
        mockUseActiveWallet.mockResolvedValue({
          identity: { address: { raw: ADDRESS } },
        })
        const fetchProfileSpy = jest.spyOn(activeChain, 'fetchProfile')

        await contacts.fetchAndAddContact({ address: spelling, contact: {} })

        expect(contacts.isContact(ADDRESS)).toBe(false)
        expect(fetchProfileSpy).not.toHaveBeenCalled()
      },
    )

    it('is a no-op when the address is already a contact', async () => {
      const contacts = useContactStore()
      contacts.addContact({
        address: ADDRESS,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })
      const fetchProfileSpy = jest.spyOn(activeChain, 'fetchProfile')

      await contacts.fetchAndAddContact({
        address: ADDRESS,
        contact: undefined as unknown as Partial<ContactState>,
      })

      expect(fetchProfileSpy).not.toHaveBeenCalled()
    })
  })

  describe('refresh', () => {
    it('re-resolves an existing contact profile via activeChain.fetchProfile', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      contacts.addContact({
        address: ADDRESS,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: ADDRESS },
        pubKey: PUB_KEY_BYTES,
      })

      await contacts.refresh(ADDRESS_LOWERCASE)

      const contact = contacts.getContact(ADDRESS)
      expect(contact.profile.pubKey).not.toBeNull()
      // Existing display fields are preserved (activeChain.fetchProfile has no name/bio/avatar).
      expect(contact.profile.name).toBe('Bob')
    })

    it('replaces the Loading... placeholder once a profile exists, even without a display name (#317)', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      contacts.addLoadingContact({
        address: ADDRESS,
        pubKey: undefined as never,
      })
      expect(contacts.getContactProfile(ADDRESS).name).toBe('Loading...')
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: ADDRESS },
        pubKey: PUB_KEY_BYTES,
      })

      await contacts.refresh(ADDRESS)

      expect(contacts.getContactProfile(ADDRESS).name).toBe('0x3e3e\u20263E3e')
    })

    it('shows a curated default bot immediately, then its registered name, bio and avatar (#317)', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      await contacts.addDefaultContact({
        address: ADDRESS,
        name: 'Picture Shop',
      })
      // Before any profile lookup: the curated name, never the placeholder.
      expect(contacts.getContactProfile(ADDRESS).name).toBe('Picture Shop')
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: ADDRESS },
        pubKey: PUB_KEY_BYTES,
        name: 'Picture Shop',
        bio: 'Automated store',
        avatar: 'data:image/png;base64,AQID',
        bot: true,
      })

      await contacts.refreshContacts()

      const profile = contacts.getContactProfile(ADDRESS)
      expect(profile).toMatchObject({
        name: 'Picture Shop',
        bio: 'Automated store',
        avatar: 'data:image/png;base64,AQID',
      })
    })

    it.each([
      ['empty', ''],
      ['whitespace', '   \t '],
      ['zero-width only', '\u200b\u200c\u200d\u2060\ufeff'],
      ['bidi controls only', '\u202e\u200f\u2066\u2069'],
    ])(
      'treats a %s profile name as unnamed, not as a name (#317)',
      async (_label, blank) => {
        const contacts = useContactStore()
        contacts.setUpdateInterval(0)
        contacts.addLoadingContact({
          address: ADDRESS,
          pubKey: undefined as never,
        })
        jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
          address: { raw: ADDRESS },
          pubKey: PUB_KEY_BYTES,
          name: blank,
        })

        await contacts.refresh(ADDRESS)

        expect(contacts.getContactProfile(ADDRESS).name).toBe(
          '0x3e3e\u20263E3e',
        )
      },
    )

    it('keeps a name the user already has when the profile name is blank, and never rewrites a visible name', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      contacts.addContact({
        address: ADDRESS,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })
      const spy = jest.spyOn(activeChain, 'fetchProfile')
      spy.mockResolvedValue({
        address: { raw: ADDRESS },
        pubKey: PUB_KEY_BYTES,
        name: '\u200b',
      })
      await contacts.refresh(ADDRESS)
      expect(contacts.getContactProfile(ADDRESS).name).toBe('Bob')
      const visible = 'Al\u200bice'
      spy.mockResolvedValue({
        address: { raw: ADDRESS },
        pubKey: PUB_KEY_BYTES,
        name: visible,
      })
      await contacts.refresh(ADDRESS)
      expect(contacts.getContactProfile(ADDRESS).name).toBe(visible)
    })

    it('isBlankName only flags names with nothing visible', () => {
      expect(isBlankName(null)).toBe(true)
      expect(isBlankName(undefined)).toBe(true)
      expect(isBlankName('a')).toBe(false)
      expect(isBlankName('\u200bA\u200b')).toBe(false)
    })

    it('logs and does not throw when activeChain.fetchProfile finds nothing', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      contacts.addContact({
        address: ADDRESS,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue(undefined)
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)

      await expect(contacts.refresh(ADDRESS)).resolves.toBeUndefined()
      expect(consoleErrorSpy).toHaveBeenCalled()
    })
  })

  describe('curated default contacts (#317)', () => {
    const DEFAULTS = [
      { address: `0x${'01'.repeat(20)}`, name: 'Blackjack Dealer' },
      { address: `0x${'02'.repeat(20)}`, name: 'Raffle' },
      { address: `0x${'03'.repeat(20)}`, name: 'Picture Shop' },
      { address: `0x${'04'.repeat(20)}`, name: 'Qwen' },
    ]
    const addAll = async (
      contacts: ReturnType<typeof useContactStore>,
      list = DEFAULTS,
    ) => {
      for (const contact of list) await contacts.addDefaultContact(contact)
    }

    it('first run: shows all four in the configured order and opens no chat', async () => {
      const contacts = useContactStore()
      const chats = useChatStore()
      await addAll(contacts)
      expect(
        Object.values(contacts.getContacts).map(c => c?.profile.name),
      ).toEqual(DEFAULTS.map(d => d.name))
      expect(chats.activeChatAddr).toBeNull()
    })

    it('a newly added default does not steal focus from the chat the user has open', async () => {
      const contacts = useContactStore()
      const chats = useChatStore()
      await addAll(contacts)
      chats.activeChatAddr = DEFAULTS[1].address
      await contacts.addDefaultContact({
        address: `0x${'05'.repeat(20)}`,
        name: 'Fifth',
      })
      expect(chats.activeChatAddr).toBe(DEFAULTS[1].address)
      expect(Object.keys(contacts.getContacts)).toHaveLength(5)
    })

    it('does not bring back a default the user deleted, across a save/restore', async () => {
      const contacts = useContactStore()
      await addAll(contacts)
      await contacts.deleteContact(DEFAULTS[2].address)
      expect(contacts.isContact(DEFAULTS[2].address)).toBe(false)
      const restored = await rehydrateContacts(
        JSON.parse(JSON.stringify(contacts.$state)),
      )
      expect(restored.dismissedDefaults).toEqual([
        toDisplay(DEFAULTS[2].address),
      ])
      // next launch: same curated list is offered again
      setActivePinia(createPinia())
      const relaunched = useContactStore()
      relaunched.$patch({ dismissedDefaults: restored.dismissedDefaults })
      await addAll(relaunched)
      expect(
        Object.values(relaunched.getContacts).map(c => c?.profile.name),
      ).toEqual(['Blackjack Dealer', 'Raffle', 'Qwen'])
    })

    it('keeps relay provenance only in this session and drops it on save/restore (#425)', async () => {
      const contacts = useContactStore()
      contacts.replaceCuratedDefaults([
        { address: DEFAULTS[0].address, name: 'Blackjack Dealer' },
        { address: 'not-an-address', name: 'Bad' },
      ])
      expect(contacts.curatedDefaults).toEqual([
        { address: toDisplay(DEFAULTS[0].address), name: 'Blackjack Dealer' },
      ])
      const saved = omitSessionCuratedDefaults(contacts.$state)
      expect(saved).not.toHaveProperty('curatedDefaults')
      const restored = await rehydrateContacts(
        JSON.parse(
          JSON.stringify({
            ...contacts.$state,
            curatedDefaults: contacts.curatedDefaults,
          }),
        ),
      )
      expect(restored.curatedDefaults).toEqual([])
      contacts.clearCuratedDefaults()
      expect(contacts.curatedDefaults).toEqual([])
    })

    it('rehydrates an old persisted state that has no dismissed list', async () => {
      const restored = await rehydrateContacts({
        contacts: {},
        updateInterval: 1,
      })
      expect(restored.dismissedDefaults).toEqual([])
    })

    it('never adds the user as their own default contact', async () => {
      mockUseActiveWallet.mockResolvedValue({
        identity: { address: activeChain.parseAddress(DEFAULTS[0].address) },
      })
      const contacts = useContactStore()
      await addAll(contacts)
      expect(
        Object.values(contacts.getContacts).map(c => c?.profile.name),
      ).toEqual(['Raffle', 'Picture Shop', 'Qwen'])
    })

    it('ignores an invalid curated address without breaking the rest of the list', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const contacts = useContactStore()
      await addAll(contacts, [
        { address: 'not-an-address', name: 'Bad' },
        ...DEFAULTS,
      ])
      expect(Object.keys(contacts.getContacts)).toHaveLength(4)
    })
  })

  describe('store-key consistency (decision 2)', () => {
    it('keys contacts by activeChain.formatAddress regardless of input case', () => {
      const contacts = useContactStore()
      // addContact itself normalizes via toChainDisplayAddress (as every other action/getter in
      // this file now does), so a contact added under any case is reachable under any other case.
      contacts.addContact({
        address: ADDRESS_LOWERCASE,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })

      expect(contacts.isContact(ADDRESS_LOWERCASE)).toBe(true)
      expect(contacts.isContact(ADDRESS)).toBe(true)
      expect(Object.keys(contacts.getContacts)).toEqual([ADDRESS])
    })
  })
})
