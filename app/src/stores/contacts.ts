import { PublicKey } from 'bitcore-lib-xpi'
import { defineStore } from 'pinia'

import { useChatStore } from './chats'

import {
  defaultUpdateInterval,
  defaultRelayUrl,
  displayNetwork,
  defaultAcceptancePrice,
} from '../utils/constants'
import { activeChain } from '@frank/wallet/chain'
import moment from 'moment'
import { toChainDisplayAddress } from '../utils/chain-address'
import { mapObjIndexed } from 'ramda'
import assert from 'assert'
import { STORE_SCHEMA_VERSION } from 'src/boot/pinia'
import { markRaw } from 'vue'

export const defaultRelayData: {
  profile: {
    name: string
    bio: string
    avatar: string
    pubKey?: Uint8Array
  }
  inbox: {
    acceptancePrice?: number
  }
  notify: boolean
} = {
  profile: {
    name: '',
    bio: '',
    avatar: '',
  },
  inbox: {
    acceptancePrice: defaultAcceptancePrice,
  },
  notify: true,
}

export const pendingRelayData = {
  profile: {
    name: 'Loading...',
    bio: '',
    avatar: '',
  },
  inbox: {
    acceptancePrice: NaN,
  },
  notify: true,
  lastUpdateTime: 0,
}

type Profile = {
  name: string | null
  bio: string | null
  avatar: string | null
  pubKey: PublicKey | null
}

export type ContactState = {
  lastUpdateTime: number
  notify: boolean
  relayURL: string | null
  profile: Profile
  inbox: {
    acceptancePrice?: number
  }
}

export interface State {
  contacts: Record<string, ContactState | undefined>
  updateInterval: number
}

/**
 * Bugfix found while writing this ticket's (#42) first-ever `stores/*.ts` jest tests -- same shape
 * as `stores/chats.ts`'s `freshChatsState` (see that function's doc comment for the full
 * explanation): the old module-level `defaultContactsState` constant's `.contacts` object was
 * shared, un-copied, across every `useContactStore()` instance in the same process (one call site,
 * `rehydrateContacts`, didn't even spread it -- it aliased `defaultContactsState.contacts` directly
 * and mutated it in place). Fixed by constructing a fresh state object each call.
 */
function freshContactsState(): State {
  return {
    contacts: {},
    updateInterval: defaultUpdateInterval,
  }
}

type RestorableContactState = {
  lastUpdateTime: number
  notify: boolean
  relayURL: string | null
  profile: {
    name: string | null
    bio: string | null
    avatar: string | null
    pubKey: Uint8Array | null
  }
  inbox: {
    acceptancePrice?: number
  }
}

export type RestorableState = {
  contacts: Record<string, RestorableContactState>
  updateInterval: number
}

export async function rehydrateContacts(
  contactState?: RestorableState,
): Promise<State> {
  if (!contactState) {
    return freshContactsState()
  }

  // This is currently a shim, we don't need any special rehydrate contact at this time.
  const contacts: Record<string, ContactState | undefined> = {}
  for (const [address, contact] of Object.entries(
    contactState.contacts ?? {},
  )) {
    assert(contact, 'Undefined contact?')
    const profile = contact?.profile
    try {
      contacts[address] = {
        ...contact,
        profile: {
          ...profile,
          pubKey: profile?.pubKey
            ? markRaw(PublicKey.fromBuffer(profile.pubKey))
            : null,
        },
      }
    } catch (e) {
      // Ignore contact if it fails to deserialize
    }
  }

  return {
    ...contactState,
    contacts: contacts,
  }
}

export const useContactStore = defineStore('contacts', {
  state: (): State => freshContactsState(),
  getters: {
    getNotify: state => (address: string) => {
      const apiAddress = toChainDisplayAddress(address)

      return state.contacts[apiAddress]
        ? state.contacts[apiAddress]?.notify
        : false
    },
    getRelayURL: state => (address: string) => {
      const apiAddress = toChainDisplayAddress(address)

      return state.contacts[apiAddress]
        ? state.contacts[apiAddress]?.relayURL
        : defaultRelayUrl
    },
    isContact: state => (address: string) => {
      const apiAddress = toChainDisplayAddress(address)

      return apiAddress in state.contacts
    },
    getContact:
      state =>
      (address: string): ContactState => {
        if (!address) {
          return {
            ...pendingRelayData,
            relayURL: null,
            profile: { ...pendingRelayData.profile, pubKey: null },
          }
        }
        const apiAddress = toChainDisplayAddress(address)

        return (
          state.contacts[apiAddress] ?? {
            ...pendingRelayData,
            relayURL: null,
            profile: { ...pendingRelayData.profile, pubKey: null },
          }
        )
      },
    getContacts: state => {
      return state.contacts
    },
    haveContact: state => (address: string) => {
      const apiAddress = toChainDisplayAddress(address)
      return !!state.contacts[apiAddress]
    },
    getContactProfile: state => (address: string) => {
      if (!address) {
        return { ...pendingRelayData.profile }
      }
      const apiAddress = toChainDisplayAddress(address)

      return state.contacts[apiAddress]
        ? state.contacts[apiAddress]?.profile
        : { ...pendingRelayData.profile }
    },
    getAcceptancePrice: state => (address: string) => {
      const apiAddress = toChainDisplayAddress(address)

      return state.contacts[apiAddress]?.inbox.acceptancePrice
    },
    getPubKey: state => (address: string) => {
      const apiAddress = toChainDisplayAddress(address)
      const contact = state.contacts[apiAddress]
      if (!contact || !contact?.profile) {
        return undefined
      }
      const pubKey = contact.profile.pubKey
      if (!pubKey) {
        return null
      }

      if ('buffer' in pubKey) {
        return markRaw(PublicKey.fromBuffer(pubKey as unknown as Buffer))
      }

      if ('point' in pubKey) {
        return markRaw(pubKey)
      }

      return markRaw(PublicKey.fromBuffer(Uint8Array.from(pubKey)))
    },
  },
  actions: {
    addContact({
      address,
      contact,
    }: {
      address: string
      contact: Partial<ContactState>
    }) {
      const fixedContact = {
        ...contact,
        profile: {
          name: contact.profile?.name ?? null,
          bio: contact.profile?.bio ?? null,
          avatar: contact.profile?.avatar ?? null,
          pubKey: contact.profile?.pubKey
            ? markRaw(contact.profile?.pubKey)
            : null,
        },
        lastUpdateTime: contact.lastUpdateTime ?? 0,
        notify: true,
        relayURL: null,
        inbox: contact.inbox ?? { acceptancePrice: defaultAcceptancePrice },
      }
      const apiAddress = toChainDisplayAddress(address)

      this.contacts[apiAddress] = fixedContact
    },
    setUpdateInterval(interval: number) {
      this.updateInterval = interval
    },
    updateContact({
      address,
      profile,
      inbox,
    }: Partial<ContactState> & { address: string }) {
      const apiAddress = toChainDisplayAddress(address)
      const contact = this.contacts[apiAddress]
      if (!contact) {
        return
      }
      contact.lastUpdateTime = moment().valueOf()
      contact.profile = profile || contact.profile
      contact.inbox = inbox || contact.inbox
    },
    setNotify({ address, value }: { address: string; value: boolean }) {
      const apiAddress = toChainDisplayAddress(address)
      const contact = this.contacts[apiAddress]
      if (!contact) {
        return
      }
      contact.notify = value
    },
    addLoadingContact({
      address,
      pubKey,
    }: {
      address: string
      pubKey: PublicKey
    }) {
      const contact = {
        ...pendingRelayData,
        profile: { ...pendingRelayData.profile, pubKey: pubKey },
      }
      this.addContact({ address, contact })
    },
    deleteContact(address: string) {
      const chats = useChatStore()
      const apiAddress = toChainDisplayAddress(address)

      chats.clearChat(address)
      chats.deleteChat(address)
      delete this.contacts[apiAddress]
    },
    /**
     * `contacts.ts`'s network-calling entry points (ticket #42 acceptance criteria): resolves a
     * profile via `activeChain.formatAddress`/`parseAddress`/`fetchProfile` instead of the old
     * `toAPIAddress`/`RegistryHandler`/`ReadOnlyRelayClient` trio.
     *
     * ## Known gap: no name/bio/avatar/relayURL/acceptancePrice from `activeChain.fetchProfile`
     *
     * Unlike the old Lotus `RegistryHandler` (relay-URL lookup) + `ReadOnlyRelayClient.getRelayData`
     * (name/bio/avatar/inbox) pair, `ActiveChain.fetchProfile` (`@frank/wallet/chain/active-chain.ts`)
     * only ever returns `{ address, pubKey }` -- by design, not an oversight: the Monad-side
     * `AddressMetadata` registered via `@frank/wallet/monad-identity.ts` is deliberately empty
     * of vCard content ("no vCard content, just proving registration itself", that file's own doc
     * comment), and `ActiveChain` has no per-contact relay-URL concept at all (Monad uses one
     * global `relayBaseUrl`, internal to `MonadChain`, never exposed through the interface). So a
     * contact resolved this way only ever gets a real `pubKey` -- `profile.name`/`bio`/`avatar`
     * stay at their existing/default values (never fabricated), `relayURL` is `null` (no longer a
     * meaningful per-contact concept), and `inbox.acceptancePrice` falls back to
     * `defaultAcceptancePrice`. Flagged here so this isn't mistaken for a bug later.
     */
    async fetchAndAddContact({
      address,
      contact,
    }: {
      address: string
      contact: Partial<ContactState>
    }) {
      if (this.isContact(address)) {
        return
      }
      const displayAddress = toChainDisplayAddress(address)

      if (!contact) {
        const chainAddress = activeChain.parseAddress(address)
        if (!chainAddress) {
          console.error(`Invalid ${activeChain.name} address: ${address}`)
          return
        }
        const profileInfo = await activeChain.fetchProfile(chainAddress)
        if (!profileInfo) {
          return
        }
        this.addContact({
          address: displayAddress,
          contact: {
            relayURL: null,
            profile: {
              ...defaultRelayData.profile,
              pubKey: markRaw(
                PublicKey.fromBuffer(Buffer.from(profileInfo.pubKey)),
              ),
            },
            inbox: defaultRelayData.inbox,
          },
        })
      } else {
        this.addContact({
          address: displayAddress,
          contact,
        })
      }
    },
    addDefaultContact({ address, name }: { address: string; name: string }) {
      if (this.isContact(address)) {
        return
      }
      console.log('adding default contact', address)
      const contact = {
        ...pendingRelayData,
        profile: {
          ...pendingRelayData.profile,
          name: name,
          bio: '',
          avatar: null,
          pubKey: null,
        },
      }
      this.addContact({ address: address, contact })
      const chats = useChatStore()
      chats.activeChatAddr = address
    },
    async refreshContacts() {
      for (const address of Object.keys(this.contacts)) {
        await this.refresh(address)
      }
    },
    async refresh(address: string) {
      const oldContactInfo = this.getContact(address)
      const updateInterval = this.updateInterval
      const now = moment()
      const lastUpdateTime = oldContactInfo.lastUpdateTime ?? 0
      const expired =
        lastUpdateTime &&
        moment(lastUpdateTime).add(updateInterval, 'milliseconds').isBefore(now)
      // NOTE: `activeChain.fetchProfile` never returns an avatar (see `fetchAndAddContact`'s doc
      // comment for why) -- `noPicture` is therefore always true for a Monad contact, so `refresh`
      // never short-circuits on this branch alone (it still short-circuits via `!expired` once
      // `updateInterval` hasn't elapsed). Slightly more frequent refetching than the old Lotus
      // behavior, not a correctness issue -- left as-is rather than silently dropping the check.
      const noPicture = oldContactInfo.profile && !oldContactInfo.profile.avatar
      if (!expired && !noPicture) {
        // Short circuit if we already updated this contact recently.
        console.log('skipping contact update, checked recently')
        return
      }
      console.log('Updating contact', address)

      try {
        const chainAddress = activeChain.parseAddress(address)
        if (!chainAddress) {
          throw new Error(`Invalid ${activeChain.name} address: ${address}`)
        }
        const profileInfo = await activeChain.fetchProfile(chainAddress)
        if (!profileInfo) {
          throw new Error(`No registered profile found for ${address}`)
        }
        this.updateContact({
          address,
          profile: {
            ...oldContactInfo.profile,
            pubKey: markRaw(
              PublicKey.fromBuffer(Buffer.from(profileInfo.pubKey)),
            ),
          },
          inbox: oldContactInfo.inbox,
        })
      } catch (err) {
        console.error(err)
      }
    },
  },
  storage: {
    save(storage, _mutation, state): void {
      const reducedState = {
        ...state,
        contacts: mapObjIndexed(contact => {
          assert(contact, 'Missing contact?? Logic error')
          const profile = contact?.profile
          assert(
            typeof profile !== 'undefined',
            'Profile is undefined for contact',
          )
          return {
            ...contact,
            profile: {
              ...profile,
              pubKey: profile.pubKey
                ? new Uint8Array(profile.pubKey.toBuffer())
                : undefined,
            },
          }
        }, state.contacts),
      }
      storage.put(
        'contacts',
        JSON.stringify(reducedState, (k, v) => {
          switch (k) {
            // Convert the pubKey Uint8Array into a binary string for storage
            case 'pubKey': {
              // only buffer if pubKey defined
              return v ? Buffer.from(v).toString('binary') : v
            }
          }
          return v
        }),
      )
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async restore(storage, metadata): Promise<Partial<State>> {
      let contacts = '{}'
      try {
        contacts = await storage.get('contacts')
      } catch (err) {
        //
      }
      const invalidStore =
        metadata.networkName !== displayNetwork ||
        metadata.version !== STORE_SCHEMA_VERSION
      if (invalidStore) {
        return freshContactsState()
      }

      const deserializedProfile = JSON.parse(contacts, (k, v) => {
        switch (k) {
          // Restore pubKey binary string to Uint8Array
          case 'pubKey': {
            // pubKey will be an object if not processed via JSON.stringify replacer function
            const buf =
              typeof v != 'string'
                ? Object.values(v as object)
                : Buffer.from(v, 'binary')
            return new Uint8Array(buf)
          }
        }
        return v
      }) as RestorableState
      const rehydratedContacts = await rehydrateContacts(deserializedProfile)
      return rehydratedContacts
    },
  },
})
