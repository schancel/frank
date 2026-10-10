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

// The relay's name store, the only source of a contact's @username.
const mockRelayHandleOf = jest.fn()
jest.mock('../utils/contact-username', () => ({
  relayHandleOf: (...args: unknown[]) => mockRelayHandleOf(...args),
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
    // By default the relay cannot be asked, so contacts keep whatever handle they had.
    mockRelayHandleOf.mockReset()
    mockRelayHandleOf.mockResolvedValue(undefined)
  })

  describe('usernames come from the relay name store only', () => {
    const OTHER = '0x4f4F4f4F4f4f4F4F4f4F4F4f4f4f4f4f4F4F4f4f'
    const profileClaiming = (username: string) =>
      ({
        address: { raw: ADDRESS },
        pubKey: PUB_KEY_BYTES,
        name: 'Qwen',
        username,
      } as Awaited<ReturnType<typeof activeChain.fetchProfile>>)

    it('a profile that claims a username it does not hold never gives the contact that handle', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      jest
        .spyOn(activeChain, 'fetchProfile')
        .mockResolvedValue(profileClaiming('qwen'))
      // The relay says this address holds no name.
      mockRelayHandleOf.mockResolvedValue({ username: null, reassigned: false })

      await contacts.fetchAndAddContact({
        address: ADDRESS,
        contact: undefined as unknown as Partial<ContactState>,
      })
      expect(contacts.getContact(ADDRESS).profile.name).toBe('Qwen')
      expect(contacts.getContact(ADDRESS).profile.username).toBeNull()

      await contacts.refresh(ADDRESS)
      expect(contacts.getContact(ADDRESS).profile.username).toBeNull()

      // Nor when the relay cannot be asked at all.
      mockRelayHandleOf.mockResolvedValue(undefined)
      await contacts.refresh(ADDRESS)
      expect(contacts.getContact(ADDRESS).profile.username).toBeNull()
    })

    it('a contact added from an address shows the name the relay says that address holds', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      jest
        .spyOn(activeChain, 'fetchProfile')
        .mockResolvedValue(profileClaiming('somebody-else'))
      mockRelayHandleOf.mockResolvedValue({
        username: 'alice',
        reassigned: false,
      })

      await contacts.fetchAndAddContact({
        address: ADDRESS,
        contact: undefined as unknown as Partial<ContactState>,
      })
      expect(contacts.getContact(ADDRESS).profile.username).toBe('alice')
      expect(mockRelayHandleOf).toHaveBeenCalledWith(ADDRESS)
    })

    it('a contact added by username stays its address when the name later goes to another account, and says so', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      // Added by @alice: resolved once to ADDRESS and stored under it.
      contacts.addContact({
        address: ADDRESS,
        contact: {
          profile: {
            name: 'Alice',
            username: 'alice',
            addedByUsername: 'alice',
            bio: '',
            avatar: '',
            pubKey: null,
          },
        },
      })
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: ADDRESS },
        pubKey: PUB_KEY_BYTES,
        name: 'Alice',
      })

      // While the address still holds the name nothing changes.
      mockRelayHandleOf.mockResolvedValue({
        username: 'alice',
        reassigned: false,
      })
      await contacts.refresh(ADDRESS)
      expect(mockRelayHandleOf).toHaveBeenLastCalledWith(ADDRESS, 'alice')
      expect(contacts.getContact(ADDRESS).profile.username).toBe('alice')
      expect(contacts.getContact(ADDRESS).profile.usernameReassigned).toBe(
        false,
      )

      // The holder renamed and another account took @alice.
      mockRelayHandleOf.mockResolvedValue({ username: null, reassigned: true })
      await contacts.refresh(ADDRESS)

      const pinned = contacts.getContact(ADDRESS)
      // Still the same contact at the same address...
      expect(contacts.isContact(ADDRESS)).toBe(true)
      expect(contacts.isContact(OTHER)).toBe(false)
      expect(Object.keys(contacts.contacts)).toEqual([toDisplay(ADDRESS)])
      expect(pinned.profile.name).toBe('Alice')
      // ...which no longer shows a handle it does not hold, and carries the notice.
      expect(pinned.profile.username).toBeNull()
      expect(pinned.profile.usernameReassigned).toBe(true)
      expect(pinned.profile.addedByUsername).toBe('alice')

      // A relay outage afterwards does not clear the notice or bring the handle back.
      mockRelayHandleOf.mockResolvedValue(undefined)
      await contacts.refresh(ADDRESS)
      expect(contacts.getContact(ADDRESS).profile.username).toBeNull()
      expect(contacts.getContact(ADDRESS).profile.usernameReassigned).toBe(true)
    })

    it("a username saved by an older build, copied from the contact's own profile, is dropped on load", async () => {
      const restored = await rehydrateContacts({
        updateInterval: 0,
        contacts: {
          [ADDRESS]: {
            lastUpdateTime: 1,
            notify: true,
            relayURL: null,
            // No usernameReassigned field: written before the relay was the only source.
            profile: {
              name: 'Qwen',
              username: 'qwen',
              bio: '',
              avatar: '',
              pubKey: null,
            },
            inbox: {},
          },
          [OTHER]: {
            lastUpdateTime: 1,
            notify: true,
            relayURL: null,
            profile: {
              name: 'Alice',
              username: 'alice',
              addedByUsername: 'alice',
              usernameReassigned: false,
              bio: '',
              avatar: '',
              pubKey: null,
            },
            inbox: {},
          },
        },
      })
      expect(restored.contacts[ADDRESS]?.profile.username).toBeNull()
      expect(restored.contacts[OTHER]?.profile.username).toBe('alice')
      expect(restored.contacts[OTHER]?.profile.addedByUsername).toBe('alice')
    })

    it('an unregistered contact also loses a handle it no longer holds', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      contacts.addContact({
        address: ADDRESS,
        contact: {
          profile: {
            name: 'Bob',
            username: 'bob',
            bio: '',
            avatar: '',
            pubKey: null,
          },
        },
      })
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue(undefined)
      mockRelayHandleOf.mockResolvedValue({ username: null, reassigned: false })
      await contacts.refresh(ADDRESS)
      expect(contacts.getContact(ADDRESS).profile.username).toBeNull()
    })
  })

  describe('fetchAndAddContact', () => {
    it('does not manufacture signed-name evidence from a presentation name', () => {
      const contacts = useContactStore()
      contacts.addContact({
        address: ADDRESS,
        contact: {
          profile: {
            name: 'Blackjack Dealer',
            bio: '',
            avatar: '',
            pubKey: null,
            isBot: true,
          },
        },
      })

      const profile = contacts.getContactProfile(ADDRESS)
      expect(profile.signedName).toBeUndefined()
    })

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
      'adds the current identity through the ordinary contact path (%s)',
      async spelling => {
        const contacts = useContactStore()
        mockUseActiveWallet.mockResolvedValue({
          identity: { address: { raw: ADDRESS } },
        })
        const fetchProfileSpy = jest
          .spyOn(activeChain, 'fetchProfile')
          .mockResolvedValue({
            address: { raw: ADDRESS },
            name: 'Alice',
            avatar: 'data:image/png;base64,alice',
            pubKey: PUB_KEY_BYTES,
          })

        await contacts.fetchAndAddContact({
          address: spelling,
          contact: undefined as unknown as Partial<ContactState>,
        })

        expect(fetchProfileSpy).toHaveBeenCalledWith({ raw: ADDRESS })
        expect(contacts.isContact(ADDRESS)).toBe(true)
        expect(contacts.getContact(ADDRESS).profile).toEqual(
          expect.objectContaining({
            name: 'Alice',
            avatar: 'data:image/png;base64,alice',
          }),
        )
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

    it('replaces the Loading... placeholder with short address and (Unregistered) when profile lookup returns undefined', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      contacts.addLoadingContact({
        address: ADDRESS,
        pubKey: undefined as never,
      })
      expect(contacts.getContactProfile(ADDRESS).name).toBe('Loading...')
      jest
        .spyOn(activeChain, 'fetchProfile')
        .mockResolvedValue(undefined as never)

      await contacts.refresh(ADDRESS)

      expect(contacts.getContactProfile(ADDRESS).name).toBe(
        '0x3e3e\u20263E3e (Unregistered)',
      )
    })

    it('preserves user-assigned name when profile lookup returns undefined', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      contacts.addContact({
        address: ADDRESS,
        contact: {
          profile: { name: 'Alice', bio: '', avatar: '', pubKey: null },
        },
      })
      jest
        .spyOn(activeChain, 'fetchProfile')
        .mockResolvedValue(undefined as never)

      await contacts.refresh(ADDRESS)

      expect(contacts.getContactProfile(ADDRESS).name).toBe('Alice')
    })

    it('creates contact entry with (Unregistered) fallback if contact was not yet in store', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      jest
        .spyOn(activeChain, 'fetchProfile')
        .mockResolvedValue(undefined as never)

      await contacts.refresh(ADDRESS)

      expect(contacts.getContactProfile(ADDRESS).name).toBe(
        '0x3e3e\u20263E3e (Unregistered)',
      )
    })

    it('replaces (Unregistered) label with short address once registered without display name', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      contacts.addContact({
        address: ADDRESS,
        contact: {
          profile: {
            name: '0x3e3e\u20263E3e (Unregistered)',
            bio: '',
            avatar: '',
            pubKey: null,
          },
        },
      })
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
        signedName: 'Picture Shop',
        bio: 'Automated store',
        avatar: 'data:image/png;base64,AQID',
      })
    })

    it.each([
      ['omitted', undefined],
      ['empty', ''],
      ['whitespace', '   '],
    ])(
      'keeps the curated label for presentation but not as an %s signed dealer name (#422)',
      async (_label, signedName) => {
        const contacts = useContactStore()
        contacts.setUpdateInterval(0)
        await contacts.addDefaultContact({
          address: ADDRESS,
          name: 'Blackjack Dealer',
        })
        contacts.replaceCuratedDefaults([
          { address: ADDRESS, name: 'Blackjack Dealer' },
        ])
        jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
          address: { raw: ADDRESS },
          pubKey: PUB_KEY_BYTES,
          name: signedName,
          bot: true,
        })

        await contacts.refresh(ADDRESS)

        const profile = contacts.getContactProfile(ADDRESS)
        expect(profile.name).toBe('Blackjack Dealer')
        expect(profile.signedName).toBe(signedName ?? null)
      },
    )

    it('loads signed-name provenance for a warm contact the hourly cache would skip (#422)', async () => {
      const contacts = useContactStore()
      contacts.addContact({
        address: ADDRESS,
        contact: {
          lastUpdateTime: Date.now(),
          profile: {
            name: 'Blackjack Dealer',
            bio: '',
            avatar: 'data:image/png;base64,AQID',
            pubKey: null,
            isBot: true,
          },
        },
      })
      contacts.replaceCuratedDefaults([
        { address: ADDRESS, name: 'Blackjack Dealer' },
      ])
      const fetchProfileSpy = jest
        .spyOn(activeChain, 'fetchProfile')
        .mockResolvedValue({
          address: { raw: ADDRESS },
          pubKey: PUB_KEY_BYTES,
          name: 'Blackjack Dealer',
          bot: true,
          avatar: 'data:image/png;base64,AQID',
        })

      await contacts.refresh(ADDRESS)

      expect(fetchProfileSpy).toHaveBeenCalled()
      const profile = contacts.getContactProfile(ADDRESS)
      expect(profile.signedName).toBe('Blackjack Dealer')
    })

    it('a warm curated label keeps a blank signed name (#422)', async () => {
      const contacts = useContactStore()
      contacts.addContact({
        address: ADDRESS,
        contact: {
          lastUpdateTime: Date.now(),
          profile: {
            name: 'Blackjack Dealer',
            bio: '',
            avatar: 'data:image/png;base64,AQID',
            pubKey: null,
            isBot: true,
          },
        },
      })
      contacts.replaceCuratedDefaults([
        { address: ADDRESS, name: 'Blackjack Dealer' },
      ])
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: ADDRESS },
        pubKey: PUB_KEY_BYTES,
        name: '',
        bot: true,
        avatar: 'data:image/png;base64,AQID',
      })

      await contacts.refresh(ADDRESS)

      const profile = contacts.getContactProfile(ADDRESS)
      expect(profile.name).toBe('Blackjack Dealer')
      expect(profile.signedName).toBe('')
    })

    it('does not refetch a warm contact whose signed name is already known blank (#422)', async () => {
      const contacts = useContactStore()
      contacts.addContact({
        address: ADDRESS,
        contact: {
          lastUpdateTime: Date.now(),
          profile: {
            name: 'Blackjack Dealer',
            signedName: '',
            bio: '',
            avatar: 'data:image/png;base64,AQID',
            pubKey: null,
            isBot: true,
          },
        },
      })
      const fetchProfileSpy = jest.spyOn(activeChain, 'fetchProfile')

      await contacts.refresh(ADDRESS)

      expect(fetchProfileSpy).not.toHaveBeenCalled()
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

    it('logs debug and does not throw when activeChain.fetchProfile finds nothing', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      contacts.addContact({
        address: ADDRESS,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue(undefined)
      const consoleDebugSpy = jest
        .spyOn(console, 'debug')
        .mockImplementation(() => undefined)
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)

      await expect(contacts.refresh(ADDRESS)).resolves.toBeUndefined()
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        `No registered profile found for ${ADDRESS}`,
      )
      expect(consoleErrorSpy).not.toHaveBeenCalled()
    })

    it('does not refetch a warm contact missing avatar within updateInterval', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(60000)
      contacts.addContact({
        address: ADDRESS,
        contact: {
          lastUpdateTime: Date.now(),
          profile: {
            name: 'Alice',
            signedName: 'Alice',
            bio: '',
            avatar: '',
            pubKey: null,
            isBot: false,
          },
        },
      })
      const fetchProfileSpy = jest.spyOn(activeChain, 'fetchProfile')

      await contacts.refresh(ADDRESS)

      expect(fetchProfileSpy).not.toHaveBeenCalled()
    })

    it('deduplicates concurrent refresh calls for the same address', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      contacts.addContact({
        address: ADDRESS,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })
      const fetchProfileSpy = jest
        .spyOn(activeChain, 'fetchProfile')
        .mockImplementation(async () => {
          await new Promise(r => setTimeout(r, 10))
          return {
            address: { raw: ADDRESS },
            pubKey: PUB_KEY_BYTES,
          }
        })

      await Promise.all([
        contacts.refresh(ADDRESS),
        contacts.refresh(ADDRESS),
        contacts.refresh(ADDRESS),
      ])

      expect(fetchProfileSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('refreshContacts', () => {
    it('refreshes all contacts with bounded concurrency (up to 6 concurrently)', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      const addresses: string[] = []
      for (let i = 1; i <= 14; i++) {
        const hex = i.toString(16).padStart(2, '0').repeat(20)
        const addr = `0x${hex}`
        addresses.push(addr)
        contacts.addContact({
          address: addr,
          contact: {
            profile: {
              name: `Contact ${i}`,
              bio: '',
              avatar: '',
              pubKey: null,
            },
          },
        })
      }

      let active = 0
      let maxActive = 0
      const refreshed: string[] = []

      jest
        .spyOn(contacts, 'refresh')
        .mockImplementation(async (addr: string) => {
          active++
          maxActive = Math.max(maxActive, active)
          refreshed.push(addr)
          await new Promise(r => setTimeout(r, 10))
          active--
        })

      await contacts.refreshContacts()

      expect(refreshed).toHaveLength(14)
      expect(maxActive).toBeGreaterThan(1)
      expect(maxActive).toBeLessThanOrEqual(6)
      for (const addr of addresses) {
        expect(refreshed).toContain(toDisplay(addr))
      }
    })

    it('isolated errors in individual contact refresh do not stop other contacts from refreshing', async () => {
      const contacts = useContactStore()
      contacts.setUpdateInterval(0)
      const addresses: string[] = []
      for (let i = 1; i <= 5; i++) {
        const hex = i.toString(16).padStart(2, '0').repeat(20)
        const addr = `0x${hex}`
        addresses.push(addr)
        contacts.addContact({
          address: addr,
          contact: {
            profile: {
              name: `Contact ${i}`,
              bio: '',
              avatar: '',
              pubKey: null,
            },
          },
        })
      }

      const failingAddr = toDisplay(addresses[2])
      const refreshed: string[] = []
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      jest
        .spyOn(contacts, 'refresh')
        .mockImplementation(async (addr: string) => {
          if (addr === failingAddr) {
            throw new Error(`Network failure for ${addr}`)
          }
          refreshed.push(addr)
        })

      await expect(contacts.refreshContacts()).resolves.toBeUndefined()
      expect(refreshed).toHaveLength(4)
      expect(refreshed).not.toContain(failingAddr)
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
      jest.spyOn(contacts, 'refresh').mockResolvedValue(undefined)
      const selected = chats.createConversation({
        address: DEFAULTS[1].address,
        participants: [DEFAULTS[1].address],
      })
      chats.setActiveConversation(selected.id)
      await contacts.addDefaultContact({
        address: `0x${'05'.repeat(20)}`,
        name: 'Fifth',
      })
      expect(chats.activeChatAddr).toBe(DEFAULTS[1].address)
      expect(chats.activeConversationId).toBe(selected.id)
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

    it('rehydrates signed-name evidence separately from a presentation label (#422)', async () => {
      const restored = await rehydrateContacts({
        contacts: {
          [ADDRESS]: {
            lastUpdateTime: 1,
            notify: true,
            relayURL: null,
            profile: {
              name: 'Blackjack Dealer',
              signedName: '',
              bio: '',
              avatar: '',
              pubKey: null,
              isBot: true,
            },
            inbox: {},
          },
        },
        updateInterval: 1,
      })

      expect(restored.contacts[ADDRESS]?.profile).toMatchObject({
        name: 'Blackjack Dealer',
        signedName: '',
        isBot: true,
      })
      expect(restored.curatedDefaults).toEqual([])
    })

    it('restores legacy v4 contact without signed-name provenance and verifies refresh (#431)', async () => {
      const v4RawBlob = {
        contacts: {
          [ADDRESS]: {
            lastUpdateTime: Date.now(),
            notify: true,
            relayURL: null,
            profile: {
              name: 'Blackjack Dealer',
              bio: '',
              avatar: 'data:image/png;base64,avatar',
              pubKey: PUB_KEY_BYTES,
              isBot: true,
            },
            inbox: {},
          },
        },
        updateInterval: 3600000,
      }

      const restored = await rehydrateContacts(v4RawBlob as any)
      expect(restored.contacts[ADDRESS]?.profile).toBeDefined()
      expect(restored.contacts[ADDRESS]?.profile.name).toBe('Blackjack Dealer')
      expect(restored.contacts[ADDRESS]?.profile.signedName).toBeUndefined()

      setActivePinia(createPinia())
      const contacts = useContactStore()
      contacts.$patch({ contacts: restored.contacts })
      contacts.replaceCuratedDefaults([
        { address: ADDRESS, name: 'Blackjack Dealer' },
      ])

      const fetchSpy = jest
        .spyOn(activeChain, 'fetchProfile')
        .mockResolvedValue({
          address: activeChain.parseAddress(ADDRESS),
          name: '',
          bio: '',
          avatar: 'data:image/png;base64,avatar',
          bot: true,
          pubKey: PUB_KEY_BYTES,
        })

      await contacts.refresh(ADDRESS)

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const refreshedProfile = contacts.getContactProfile(ADDRESS)
      expect(refreshedProfile.name).toBe('Blackjack Dealer')
      expect(isBlankName(refreshedProfile.signedName)).toBe(true)
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

    it('infers curated bot attributes for defaults when added', async () => {
      const contacts = useContactStore()
      await contacts.addDefaultContact({
        address: `0x${'10'.repeat(20)}`,
        name: 'Monad Faucet',
      })
      await contacts.addDefaultContact({
        address: `0x${'20'.repeat(20)}`,
        name: 'Blackjack Dealer',
      })
      await contacts.addDefaultContact({
        address: `0x${'30'.repeat(20)}`,
        name: 'Qwen AI',
      })
      const faucet = contacts.getContact(`0x${'10'.repeat(20)}`)
      expect(faucet?.profile.accountType).toBe(2)
      expect(faucet?.profile.botRole).toBe(2)
      expect(faucet?.profile.isBot).toBe(false)

      const dealer = contacts.getContact(`0x${'20'.repeat(20)}`)
      expect(dealer?.profile.accountType).toBe(1)
      expect(dealer?.profile.botRole).toBe(3)
      expect(dealer?.profile.isBot).toBe(true)

      const qwen = contacts.getContact(`0x${'30'.repeat(20)}`)
      expect(qwen?.profile.accountType).toBe(1)
      expect(qwen?.profile.botRole).toBe(1)
      expect(qwen?.profile.isBot).toBe(true)
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
