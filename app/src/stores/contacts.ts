import { fetchContactProfile } from '../utils/directory-peer'
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
import { isOwnAddress } from '../utils/own-address'
import {
  isProfilePubKey,
  profilePubKeyFromBytes,
  type ProfilePubKey,
} from '../utils/profile-pubkey'
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

/** `0x1234…abcd`: what a resolved-but-unnamed contact is shown as (#317), instead of leaving the
 * "Loading..." placeholder up forever once its profile is known to exist. */
export function shortAddressLabel(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}\u2026${address.slice(-4)}`
    : address
}

/** Zero-width, bidi-control and other invisible format characters. */
// Deliberately lists combining/variation characters: they are invisible by themselves.
/* eslint-disable no-misleading-character-class */
const INVISIBLE_CHARS =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g
/* eslint-enable no-misleading-character-class */

/** True for a name with nothing visible: empty, whitespace, or only zero-width/bidi controls.
 * Used only to decide whether to show a fallback; the stored name is never rewritten. */
export function isBlankName(name: string | null | undefined): boolean {
  return !name || name.replace(INVISIBLE_CHARS, '').trim() === ''
}

type Profile = {
  name: string | null
  /** Name carried by the last signed profile lookup. Kept separate from `name`, which may be a
   * relay-curated, address, or user-facing fallback label. */
  signedName?: string | null
  bio: string | null
  avatar: string | null
  pubKey: ProfilePubKey | null
  /** The signed profile carried the self-declared bot marker (#311). `undefined` = not looked up
   * yet; only an explicit `true` counts. A copied name plus this flag is still not a verified
   * key (#217). */
  isBot?: boolean
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

export interface CuratedDefaultProvenance {
  address: string
  name: string
}

export interface State {
  contacts: Record<string, ContactState | undefined>
  updateInterval: number
  /** Canonical addresses of contacts the user deleted: curated defaults are not re-added for
   * them on later launches. */
  dismissedDefaults: string[]
  /** Relay curated defaults for this session only. Not persisted: a profile refresh cannot
   * recreate it, and a failed fetch leaves it empty (#425). */
  curatedDefaults: CuratedDefaultProvenance[]
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
    dismissedDefaults: [],
    curatedDefaults: [],
  }
}

/** Drops session curated provenance before contacts are written. A later launch starts empty. */
export function omitSessionCuratedDefaults<T extends object>(
  state: T,
): Omit<T, 'curatedDefaults'> {
  const copy = { ...state } as T & { curatedDefaults?: unknown }
  delete copy.curatedDefaults
  return copy as Omit<T, 'curatedDefaults'>
}

type RestorableContactState = {
  lastUpdateTime: number
  notify: boolean
  relayURL: string | null
  profile: {
    name: string | null
    signedName?: string | null
    bio: string | null
    avatar: string | null
    pubKey: Uint8Array | null
    isBot?: boolean
  }
  inbox: {
    acceptancePrice?: number
  }
}

export type RestorableState = {
  contacts: Record<string, RestorableContactState>
  updateInterval: number
  dismissedDefaults?: string[]
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
            ? markRaw(profilePubKeyFromBytes(profile.pubKey))
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
    dismissedDefaults: contactState.dismissedDefaults ?? [],
    // Never trust a saved blob for this. Only a completed fetch in this session sets it.
    curatedDefaults: [],
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
      const stored: unknown = contact.profile.pubKey
      if (!stored) {
        return null
      }
      // Already accepted, or a legacy object that still has toBuffer().
      if (isProfilePubKey(stored)) {
        return markRaw(stored)
      }
      const bytes =
        stored instanceof Uint8Array
          ? stored
          : Uint8Array.from(stored as ArrayLike<number>)
      return markRaw(profilePubKeyFromBytes(bytes))
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
          signedName: contact.profile?.signedName,
          bio: contact.profile?.bio ?? null,
          avatar: contact.profile?.avatar ?? null,
          isBot: contact.profile?.isBot,
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
      pubKey: ProfilePubKey
    }) {
      const contact = {
        ...pendingRelayData,
        profile: { ...pendingRelayData.profile, pubKey: pubKey },
      }
      this.addContact({ address, contact })
    },
    async deleteContact(address: string) {
      const chats = useChatStore()
      const apiAddress = toChainDisplayAddress(address)

      await chats.deleteChat(address)
      delete this.contacts[apiAddress]
      if (!this.dismissedDefaults.includes(apiAddress)) {
        this.dismissedDefaults.push(apiAddress)
      }
    },
    /** Resolve a signed Monad profile through the active-chain seam. */
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
        const profileInfo = await fetchContactProfile(chainAddress)
        if (!profileInfo) {
          return
        }
        this.addContact({
          address: displayAddress,
          contact: {
            relayURL: null,
            profile: {
              ...defaultRelayData.profile,
              name: isBlankName(profileInfo.name)
                ? shortAddressLabel(displayAddress)
                : (profileInfo.name as string),
              signedName: profileInfo.name ?? null,
              bio: profileInfo.bio ?? '',
              avatar: profileInfo.avatar ?? '',
              isBot: profileInfo.bot === true,
              pubKey: markRaw(profilePubKeyFromBytes(profileInfo.pubKey)),
            },
            inbox: defaultRelayData.inbox,
          },
        })
      } else {
        this.addContact({
          address: displayAddress,
          contact,
        })
        // A contact added without a looked-up profile (deep link / route navigation) has no bot
        // marker yet; resolve it now (`setActiveChat`'s own refresh ran before this contact
        // existed), so the bot marker is known for whatever needs it.
        if (contact.profile?.isBot === undefined) {
          void this.refresh(address)
        }
      }
    },
    /** Adds a relay-curated default contact. Never opens a chat (a first run shows the list, and
     * a returning user is not switched by a newly added default), never re-adds one the user
     * deleted, never adds the user themself, and ignores an unparseable address. */
    async addDefaultContact({
      address,
      name,
    }: {
      address: string
      name: string
    }) {
      let apiAddress: string
      try {
        apiAddress = toChainDisplayAddress(address)
      } catch {
        console.error(
          `ignoring curated default with invalid address ${address}`,
        )
        return
      }
      if (this.isContact(apiAddress)) return
      if (this.dismissedDefaults.includes(apiAddress)) return
      if (await isOwnAddress(apiAddress)) return
      // The await above can interleave with another add of the same address.
      if (this.isContact(apiAddress)) return
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
      this.addContact({ address: apiAddress, contact })
    },
    /** Replaces session provenance with one completed relay response. Invalid addresses are
     * dropped. Does not persist. */
    replaceCuratedDefaults(entries: { address: string; name: string }[]) {
      const next: CuratedDefaultProvenance[] = []
      for (const entry of entries) {
        try {
          next.push({
            address: toChainDisplayAddress(entry.address),
            name: entry.name,
          })
        } catch {
          // Same as addDefaultContact: an unparseable address is not provenance.
        }
      }
      this.curatedDefaults = next
    },
    clearCuratedDefaults() {
      this.curatedDefaults = []
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
      const noPicture = oldContactInfo.profile && !oldContactInfo.profile.avatar
      const botUnknown =
        oldContactInfo.profile && oldContactInfo.profile.isBot === undefined
      // A profile saved before signed-name provenance has a fresh picture and bot flag, so the
      // hourly skip would leave it unknown forever. Unknown provenance must be fetched. A
      // known blank signed name is not unknown and must not be refreshed just to fill it.
      const signedNameUnknown =
        oldContactInfo.profile &&
        oldContactInfo.profile.signedName === undefined
      if (!expired && !noPicture && !botUnknown && !signedNameUnknown) {
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
        const profileInfo = await fetchContactProfile(chainAddress)
        if (!profileInfo) {
          console.error(new Error(`No registered profile found for ${address}`))
          this.updateContact({
            address,
            profile: {
              ...oldContactInfo.profile,
              signedName: oldContactInfo.profile.signedName ?? null,
              isBot: oldContactInfo.profile.isBot ?? false,
            },
            inbox: oldContactInfo.inbox,
          })
          return
        }
        this.updateContact({
          address,
          profile: {
            ...oldContactInfo.profile,
            // A registered profile without a display name must not keep the "Loading..."
            // placeholder (#317); a name the user already has for this contact is kept.
            name: !isBlankName(profileInfo.name)
              ? (profileInfo.name as string)
              : !isBlankName(oldContactInfo.profile.name) &&
                oldContactInfo.profile.name !== pendingRelayData.profile.name
              ? oldContactInfo.profile.name
              : shortAddressLabel(toChainDisplayAddress(address)),
            signedName: profileInfo.name ?? null,
            bio: profileInfo.bio ?? oldContactInfo.profile.bio,
            avatar: profileInfo.avatar ?? oldContactInfo.profile.avatar,
            isBot: profileInfo.bot === true,
            pubKey: markRaw(profilePubKeyFromBytes(profileInfo.pubKey)),
          },
          inbox: oldContactInfo.inbox,
        })
      } catch (err) {
        console.error(err)
      }
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      const reducedState = omitSessionCuratedDefaults({
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
      })
      return storage.put(
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
