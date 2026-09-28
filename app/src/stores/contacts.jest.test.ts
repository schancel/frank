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
    getIterator: async function* () {
      /* no persisted Lotus-era messages in tests */
    },
  }),
}))
jest.mock('../utils/notifications', () => ({
  desktopNotify: jest.fn(),
}))

import { useContactStore } from './contacts'
import type { ContactState } from './contacts'
import { activeChain } from '@frank/wallet/chain'

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

    it('does not add a contact when activeChain.fetchProfile finds nothing registered', async () => {
      const contacts = useContactStore()
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue(undefined)

      await contacts.fetchAndAddContact({
        address: ADDRESS,
        contact: undefined as unknown as Partial<ContactState>,
      })

      expect(contacts.isContact(ADDRESS)).toBe(false)
    })

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
