import { fetchContactProfile } from '../utils/directory-peer'
import { relayHandleOf } from '../utils/contact-username'
import { defineStore } from 'pinia'

import { useChatStore } from './chats'
import { accountSession } from '../accounts/session'

import {
  defaultUpdateInterval,
  defaultRelayUrl,
  defaultAcceptancePrice,
} from '../utils/constants'
import { activeChain } from '@frank/wallet/chain'
import moment from 'moment'
import {
  isChainAddress,
  safeChainDisplayAddress,
  safeToChainDisplayAddress,
  toChainDisplayAddress,
} from '../utils/chain-address'
import { isOwnAddress, sameCanonicalAddress } from '../utils/own-address'
import {
  isProfilePubKey,
  profilePubKeyFromBytes,
  type ProfilePubKey,
} from '../utils/profile-pubkey'
import { mapObjIndexed } from 'ramda'
import assert from 'assert'
import { readStoreJson } from 'src/boot/pinia'
import { markRaw, toRaw } from 'vue'
import { inferCuratedBotAttributes } from '../utils/curated-bots'
import { setOutboundWakeupTokenProvider } from '@frank/cashweb/relay/canonical-dm-transport'
import { syncRelayNotificationPolicy } from '../utils/webpush-sync'
import {
  CONTACT_KEY_ROTATION_DOMAIN,
  createContactKeyRotationStatement,
  deriveAddressFromPublicKeyHex,
  encodeContactKeyRotationPayload,
  hashContactKeyRotationPayload,
  normalizeMasterPublicKeyHex,
  verifyContactKeyRotationStatement,
  type ContactKeyRotationRejectionReason,
  type ContactKeyRotationStatement,
  type ContactKeyRotationVerificationResult,
  type CreateContactKeyRotationStatementParams,
  type VerifyContactKeyRotationOptions,
} from '../utils/contact-key-rotation'

export {
  CONTACT_KEY_ROTATION_DOMAIN,
  createContactKeyRotationStatement,
  deriveAddressFromPublicKeyHex,
  encodeContactKeyRotationPayload,
  hashContactKeyRotationPayload,
  normalizeMasterPublicKeyHex,
  verifyContactKeyRotationStatement,
  type ContactKeyRotationRejectionReason,
  type ContactKeyRotationStatement,
  type ContactKeyRotationVerificationResult,
  type CreateContactKeyRotationStatementParams,
  type VerifyContactKeyRotationOptions,
}

export interface UnverifiedHandleResolution {
  handle: string
  pinnedAddress: string
  conflictingAddress: string
  detectedAt: number
}

export type ContactKeyRotationResult =
  | {
      ok: true
      applied: true
      oldAddress: string
      newAddress: string
      sequence: number
      rotationNotice: string
    }
  | {
      ok: false
      applied: false
      reason: ContactKeyRotationRejectionReason
      warning: string
      address?: string
    }

function normalizeHandle(handle: string): string {
  const trimmed = handle.trim()
  return (trimmed.startsWith('@') ? trimmed.slice(1) : trimmed).toLowerCase()
}

const pendingOutboundWakeupTokens = new Map<string, string>()

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
    acceptancePrice: defaultAcceptancePrice,
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
  /** The @username the relay says this address holds. Filled only from the relay's name
   * store (`utils/contact-username`), never from what a profile says about itself. */
  username?: string | null
  /** The username this contact was added by. The contact is pinned to its address: this is
   * kept only to notice when the name later points to a different account. */
  addedByUsername?: string | null
  /** `addedByUsername` is now held by another account. This contact is still the address that
   * was added; it is never re-pointed. */
  usernameReassigned?: boolean
  bio: string | null
  avatar: string | null
  location?: string | null
  links?: Array<{ type: string; url: string; label?: string }>
  pubKey: ProfilePubKey | null
  /** The signed profile carried the self-declared bot marker (#311). `undefined` = not looked up
   * yet; only an explicit `true` counts. A copied name plus this flag is still not a verified
   * key (#217). */
  isBot?: boolean
  accountType?: number
  botRole?: number
}

export type ContactState = {
  lastUpdateTime: number
  notify: boolean
  relayURL: string | null
  profile: Profile
  inbox: {
    acceptancePrice?: number
  }
  /** 32-byte hex wakeup token preimage we issued to this contact so they can wake us. */
  inboundWakeupToken?: string
  /** 32-byte hex wakeup token preimage this contact issued to us so we can wake them via X-Cashweb-Wakeup-Token. */
  outboundWakeupToken?: string
  /** Canonical address this contact is pinned to (#1369). */
  pinnedAddress?: string
  /** Compressed 33-byte secp256k1 master public key hex authorised to sign key rotations (#1369). */
  masterPublicKeyHex?: string | null
  /** Highest validated key rotation sequence number applied for this contact (#1369). */
  lastRotationSequence?: number
  /** Previous address this contact was rotated from (#1369). */
  rotatedFromAddress?: string | null
  /** User-facing notice recorded when a valid master-key rotation statement rotated this contact (#1369). */
  rotationNotice?: string | null
  /** User-facing warning recorded when an invalid or replayed rotation statement was rejected (#1369). */
  rotationWarning?: string | null
  /** User-facing warning recorded when a handle resolved to a different address without a valid rotation statement (#1369). */
  handleConflictWarning?: string | null
  /** Structured record of an unverified handle resolution conflict (#1369). */
  unverifiedHandleResolution?: UnverifiedHandleResolution | null
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
    username?: string | null
    addedByUsername?: string | null
    usernameReassigned?: boolean
    bio: string | null
    avatar: string | null
    pubKey: Uint8Array | null
    isBot?: boolean
    accountType?: number
    botRole?: number
  }
  inbox: {
    acceptancePrice?: number
  }
  inboundWakeupToken?: string
  outboundWakeupToken?: string
  pinnedAddress?: string
  masterPublicKeyHex?: string | null
  lastRotationSequence?: number
  rotatedFromAddress?: string | null
  rotationNotice?: string | null
  rotationWarning?: string | null
  handleConflictWarning?: string | null
  unverifiedHandleResolution?: UnverifiedHandleResolution | null
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
        pinnedAddress:
          contact.pinnedAddress ??
          safeToChainDisplayAddress(address) ??
          address,
        lastRotationSequence: contact.lastRotationSequence ?? 0,
        profile: {
          ...profile,
          // A username saved before handles came only from the relay's name store was copied
          // from the contact's own profile and proves nothing. Such a record has no
          // `usernameReassigned` field; its username is dropped until the relay confirms one.
          username:
            profile?.usernameReassigned === undefined
              ? null
              : profile.username ?? null,
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

const inFlightRefreshes = new Map<string, Promise<void>>()
const inFlightRefreshAll = new WeakMap<object, Promise<void>>()

export const useContactStore = defineStore('contacts', {
  state: (): State => freshContactsState(),
  getters: {
    getNotify: state => (address: string) => {
      const apiAddress = safeToChainDisplayAddress(address) ?? address
      if (!apiAddress) return false

      return state.contacts[apiAddress]
        ? state.contacts[apiAddress]?.notify
        : false
    },
    getInboundWakeupToken: state => (address: string) => {
      const apiAddress = safeToChainDisplayAddress(address) ?? address
      if (!apiAddress) return undefined
      return state.contacts[apiAddress]?.inboundWakeupToken
    },
    getOutboundWakeupToken: state => (address: string) => {
      const apiAddress = safeToChainDisplayAddress(address) ?? address
      if (!apiAddress) return undefined
      return (
        state.contacts[apiAddress]?.outboundWakeupToken ??
        pendingOutboundWakeupTokens.get(apiAddress)
      )
    },
    getRelayURL: state => (address: string) => {
      const apiAddress = safeToChainDisplayAddress(address) ?? address
      if (!apiAddress) return defaultRelayUrl

      return state.contacts[apiAddress]
        ? state.contacts[apiAddress]?.relayURL
        : defaultRelayUrl
    },
    isContact: state => (address: string) => {
      const apiAddress = safeToChainDisplayAddress(address) ?? address
      if (!apiAddress) return false

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
        const apiAddress = safeToChainDisplayAddress(address) ?? address

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
      const apiAddress = safeToChainDisplayAddress(address) ?? address
      if (!apiAddress) return false
      return !!state.contacts[apiAddress]
    },
    getContactProfile: state => (address: string) => {
      if (!address) {
        return { ...pendingRelayData.profile }
      }
      const apiAddress = safeToChainDisplayAddress(address) ?? address

      return state.contacts[apiAddress]
        ? state.contacts[apiAddress]?.profile
        : { ...pendingRelayData.profile }
    },
    getAcceptancePrice: state => (address: string) => {
      const apiAddress = safeToChainDisplayAddress(address) ?? address
      if (!apiAddress) return defaultAcceptancePrice

      const price = state.contacts[apiAddress]?.inbox.acceptancePrice
      return typeof price === 'number' && Number.isFinite(price)
        ? price
        : defaultAcceptancePrice
    },
    getPubKey: state => (address: string) => {
      const apiAddress = safeToChainDisplayAddress(address) ?? address
      if (!apiAddress) return undefined
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
    getPinnedContactByHandle:
      state =>
      (handle: string): ContactState | undefined => {
        if (!handle) return undefined
        const target = normalizeHandle(handle)
        for (const contact of Object.values(state.contacts)) {
          if (!contact) continue
          const addedBy = contact.profile?.addedByUsername
          if (addedBy && normalizeHandle(addedBy) === target) {
            return contact
          }
        }
        return undefined
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
      const apiAddress = toChainDisplayAddress(address)
      const addedByHandle = contact.profile?.addedByUsername
      if (addedByHandle) {
        const normalizedAddedBy = normalizeHandle(addedByHandle)
        for (const [existingAddr, existingContact] of Object.entries(
          this.contacts,
        )) {
          if (
            existingContact &&
            existingAddr !== apiAddress &&
            existingContact.profile?.addedByUsername &&
            normalizeHandle(existingContact.profile.addedByUsername) ===
              normalizedAddedBy
          ) {
            const pinnedAddr = existingContact.pinnedAddress ?? existingAddr
            const warning = `Handle "${existingContact.profile.addedByUsername}" resolved to ${apiAddress} without a verified master-key rotation statement; keeping pinned address ${pinnedAddr}`
            existingContact.profile.usernameReassigned = true
            existingContact.profile.username = null
            existingContact.handleConflictWarning = warning
            existingContact.unverifiedHandleResolution = {
              handle: existingContact.profile.addedByUsername,
              pinnedAddress: pinnedAddr,
              conflictingAddress: apiAddress,
              detectedAt: Date.now(),
            }
            return
          }
        }
      }

      const existing = this.contacts[apiAddress]
      const derivedInbound =
        contact.inboundWakeupToken ?? existing?.inboundWakeupToken
      const resolvedOutbound =
        contact.outboundWakeupToken ??
        existing?.outboundWakeupToken ??
        pendingOutboundWakeupTokens.get(apiAddress)
      if (resolvedOutbound) {
        pendingOutboundWakeupTokens.delete(apiAddress)
      }
      const rawMasterKey =
        contact.masterPublicKeyHex !== undefined
          ? contact.masterPublicKeyHex
          : existing?.masterPublicKeyHex ?? null
      const normalizedMasterKey = rawMasterKey
        ? normalizeMasterPublicKeyHex(rawMasterKey) ??
          rawMasterKey.toLowerCase()
        : null

      const fixedContact: ContactState = {
        ...contact,
        pinnedAddress: contact.pinnedAddress
          ? toChainDisplayAddress(contact.pinnedAddress)
          : existing?.pinnedAddress ?? apiAddress,
        masterPublicKeyHex: normalizedMasterKey,
        lastRotationSequence:
          contact.lastRotationSequence ?? existing?.lastRotationSequence ?? 0,
        rotatedFromAddress:
          contact.rotatedFromAddress !== undefined
            ? contact.rotatedFromAddress
            : existing?.rotatedFromAddress ?? null,
        rotationNotice:
          contact.rotationNotice !== undefined
            ? contact.rotationNotice
            : existing?.rotationNotice ?? null,
        rotationWarning:
          contact.rotationWarning !== undefined
            ? contact.rotationWarning
            : existing?.rotationWarning ?? null,
        handleConflictWarning:
          contact.handleConflictWarning !== undefined
            ? contact.handleConflictWarning
            : existing?.handleConflictWarning ?? null,
        unverifiedHandleResolution:
          contact.unverifiedHandleResolution !== undefined
            ? contact.unverifiedHandleResolution
            : existing?.unverifiedHandleResolution ?? null,
        profile: {
          name: contact.profile?.name ?? null,
          signedName: contact.profile?.signedName,
          // Callers pass a username only when the relay's name store gave it to them.
          username: contact.profile?.username ?? null,
          addedByUsername: contact.profile?.addedByUsername ?? null,
          usernameReassigned: contact.profile?.usernameReassigned ?? false,
          bio: contact.profile?.bio ?? null,
          avatar: contact.profile?.avatar ?? null,
          isBot: contact.profile?.isBot,
          accountType: contact.profile?.accountType,
          botRole: contact.profile?.botRole,
          pubKey: contact.profile?.pubKey
            ? markRaw(contact.profile?.pubKey)
            : null,
        },
        lastUpdateTime: contact.lastUpdateTime ?? 0,
        notify: contact.notify ?? true,
        relayURL: null,
        inbox: contact.inbox ?? { acceptancePrice: defaultAcceptancePrice },
        ...(derivedInbound ? { inboundWakeupToken: derivedInbound } : {}),
        ...(resolvedOutbound ? { outboundWakeupToken: resolvedOutbound } : {}),
      }

      this.contacts[apiAddress] = fixedContact
      void syncRelayNotificationPolicy()
    },
    /**
     * Adds a contact resolved by username/handle and pins it to `address` (and optionally
     * `masterPublicKeyHex`). If a contact is already pinned for `handle` at a different address,
     * the existing contact is NEVER silently re-pointed; instead a handle conflict warning is
     * recorded on the pinned contact (#1369).
     */
    addContactByHandle({
      handle,
      address,
      masterPublicKeyHex,
      contact,
    }: {
      handle: string
      address: string
      masterPublicKeyHex?: string | null
      contact?: Partial<ContactState>
    }) {
      const apiAddress = toChainDisplayAddress(address)
      const normalizedHandle = normalizeHandle(handle)
      for (const [existingAddr, existingContact] of Object.entries(
        this.contacts,
      )) {
        if (
          existingContact &&
          existingContact.profile?.addedByUsername &&
          normalizeHandle(existingContact.profile.addedByUsername) ===
            normalizedHandle
        ) {
          if (existingAddr !== apiAddress) {
            const pinnedAddr = existingContact.pinnedAddress ?? existingAddr
            const warning = `Handle "${existingContact.profile.addedByUsername}" resolved to ${apiAddress} without a verified master-key rotation statement; keeping pinned address ${pinnedAddr}`
            existingContact.profile.usernameReassigned = true
            existingContact.profile.username = null
            existingContact.handleConflictWarning = warning
            existingContact.unverifiedHandleResolution = {
              handle: existingContact.profile.addedByUsername,
              pinnedAddress: pinnedAddr,
              conflictingAddress: apiAddress,
              detectedAt: Date.now(),
            }
          }
          return existingContact
        }
      }

      this.addContact({
        address: apiAddress,
        contact: {
          ...contact,
          pinnedAddress: apiAddress,
          masterPublicKeyHex:
            masterPublicKeyHex ?? contact?.masterPublicKeyHex ?? null,
          lastRotationSequence: contact?.lastRotationSequence ?? 0,
          profile: {
            name: contact?.profile?.name ?? handle,
            signedName: contact?.profile?.signedName,
            username: contact?.profile?.username ?? normalizedHandle,
            addedByUsername: handle,
            usernameReassigned: false,
            bio: contact?.profile?.bio ?? '',
            avatar: contact?.profile?.avatar ?? '',
            pubKey: contact?.profile?.pubKey ?? null,
            isBot: contact?.profile?.isBot,
            accountType: contact?.profile?.accountType,
            botRole: contact?.profile?.botRole,
          },
        },
      })
      return this.contacts[apiAddress]
    },
    /**
     * Observes a directory handle resolution for an existing handle-pinned contact (#1369).
     * Never re-points a pinned contact unless a valid master-key rotation statement is supplied.
     */
    resolveContactHandle({
      handle,
      resolvedAddress,
      rotationStatement,
    }: {
      handle: string
      resolvedAddress: string
      rotationStatement?: ContactKeyRotationStatement
    }) {
      const apiResolved = toChainDisplayAddress(resolvedAddress)
      const normalizedHandle = normalizeHandle(handle)
      let matchedAddr: string | undefined
      let matchedContact: ContactState | undefined
      for (const [addr, c] of Object.entries(this.contacts)) {
        if (
          c?.profile?.addedByUsername &&
          normalizeHandle(c.profile.addedByUsername) === normalizedHandle
        ) {
          matchedAddr = addr
          matchedContact = c
          break
        }
      }

      if (!matchedContact || !matchedAddr) {
        return {
          ok: false as const,
          reason: 'contact-not-found' as const,
        }
      }

      const pinnedAddr = matchedContact.pinnedAddress ?? matchedAddr
      if (sameCanonicalAddress(pinnedAddr, apiResolved)) {
        return {
          ok: true as const,
          address: pinnedAddr,
          rotated: false,
        }
      }

      if (rotationStatement) {
        return this.applyContactKeyRotation(rotationStatement)
      }

      const handleLabel = matchedContact.profile.addedByUsername ?? handle
      const warning = `Handle "${handleLabel}" now resolves to ${apiResolved} without a verified master-key rotation statement; keeping pinned address ${pinnedAddr}`
      matchedContact.profile.usernameReassigned = true
      matchedContact.profile.username = null
      matchedContact.handleConflictWarning = warning
      matchedContact.unverifiedHandleResolution = {
        handle: handleLabel,
        pinnedAddress: pinnedAddr,
        conflictingAddress: apiResolved,
        detectedAt: Date.now(),
      }
      return {
        ok: false as const,
        applied: false as const,
        reason: 'unverified-handle-resolution' as const,
        pinnedAddress: pinnedAddr,
        conflictingAddress: apiResolved,
        warning,
      }
    },
    /**
     * Applies a master-key-signed `ContactKeyRotationStatement` to a pinned contact (#1369).
     * Rejects invalid, unauthorized, or replayed (`sequence <= lastRotationSequence`) statements
     * without changing the contact's address, and records `rotationWarning` on the contact.
     */
    applyContactKeyRotation(
      statement: ContactKeyRotationStatement,
    ): ContactKeyRotationResult {
      const oldAddr = safeToChainDisplayAddress(statement?.oldAddress)
      const newAddr = safeToChainDisplayAddress(statement?.newAddress)

      let targetAddress =
        oldAddr && this.contacts[oldAddr] ? oldAddr : undefined
      let targetContact = targetAddress
        ? this.contacts[targetAddress]
        : undefined

      if (!targetContact && oldAddr) {
        const normalizedMaster = statement?.masterPublicKeyHex
          ? normalizeMasterPublicKeyHex(statement.masterPublicKeyHex)
          : null
        for (const [addr, candidate] of Object.entries(this.contacts)) {
          if (!candidate) continue
          if (
            candidate.pinnedAddress === oldAddr ||
            candidate.rotatedFromAddress === oldAddr ||
            (normalizedMaster &&
              candidate.masterPublicKeyHex === normalizedMaster)
          ) {
            targetAddress = addr
            targetContact = candidate
            break
          }
        }
      }

      if (!targetContact || !targetAddress) {
        return {
          ok: false,
          applied: false,
          reason: 'contact-not-found',
          warning: 'Cannot rotate key: pinned contact not found',
        }
      }

      const currentSequence = targetContact.lastRotationSequence ?? 0
      const pinnedAddr = targetContact.pinnedAddress ?? targetAddress

      // Check replay/stale sequence first if the statement is replayed against an already-rotated contact
      if (
        typeof statement?.sequence === 'number' &&
        Number.isSafeInteger(statement.sequence) &&
        statement.sequence >= 1 &&
        statement.sequence <= currentSequence
      ) {
        const warning = `Rejected replayed or stale key rotation statement (sequence ${statement.sequence} <= ${currentSequence})`
        targetContact.rotationWarning = warning
        return {
          ok: false,
          applied: false,
          reason: 'replayed-or-stale-sequence',
          warning,
          address: targetAddress,
        }
      }

      let expectedMasterKey = targetContact.masterPublicKeyHex ?? null
      if (!expectedMasterKey && targetContact.profile?.pubKey) {
        try {
          const pubHex = Buffer.from(
            targetContact.profile.pubKey.toBuffer(),
          ).toString('hex')
          expectedMasterKey = normalizeMasterPublicKeyHex(pubHex)
        } catch {
          // ignore
        }
      }

      const verification = verifyContactKeyRotationStatement(statement, {
        expectedOldAddress: pinnedAddr,
        expectedMasterPublicKeyHex: expectedMasterKey,
        lastRotationSequence: currentSequence,
        requireOldAddressBinding: !expectedMasterKey,
      })

      if (!verification.valid) {
        targetContact.rotationWarning = verification.message
        return {
          ok: false,
          applied: false,
          reason: verification.reason,
          warning: verification.message,
          address: targetAddress,
        }
      }

      if (
        newAddr &&
        newAddr !== targetAddress &&
        this.contacts[newAddr] !== undefined
      ) {
        const warning = `Cannot rotate contact from ${targetAddress} to ${newAddr}: destination address is already a contact`
        targetContact.rotationWarning = warning
        return {
          ok: false,
          applied: false,
          reason: 'new-address-conflict',
          warning,
          address: targetAddress,
        }
      }

      const canonicalOld = verification.oldAddress
      const canonicalNew = verification.newAddress
      const rotationNotice = `Contact key rotated from ${canonicalOld} to ${canonicalNew} (sequence #${verification.sequence})`

      const rotatedContact: ContactState = {
        ...targetContact,
        pinnedAddress: canonicalNew,
        masterPublicKeyHex: verification.normalizedMasterPublicKeyHex,
        lastRotationSequence: verification.sequence,
        rotatedFromAddress: canonicalOld,
        rotationNotice,
        rotationWarning: null,
        handleConflictWarning: null,
        unverifiedHandleResolution: null,
        profile: {
          ...targetContact.profile,
          usernameReassigned: false,
        },
      }

      delete this.contacts[targetAddress]
      this.contacts[canonicalNew] = rotatedContact
      void syncRelayNotificationPolicy()

      return {
        ok: true,
        applied: true,
        oldAddress: canonicalOld,
        newAddress: canonicalNew,
        sequence: verification.sequence,
        rotationNotice,
      }
    },
    rotatePinnedContact(
      statement: ContactKeyRotationStatement,
    ): ContactKeyRotationResult {
      return this.applyContactKeyRotation(statement)
    },
    setUpdateInterval(interval: number) {
      this.updateInterval = interval
    },
    updateContact({
      address,
      profile,
      inbox,
      inboundWakeupToken,
      outboundWakeupToken,
      pinnedAddress,
      masterPublicKeyHex,
      lastRotationSequence,
      rotatedFromAddress,
      rotationNotice,
      rotationWarning,
      handleConflictWarning,
      unverifiedHandleResolution,
    }: Partial<ContactState> & { address: string }) {
      const apiAddress = toChainDisplayAddress(address)
      const contact = this.contacts[apiAddress]
      if (!contact) {
        this.addContact({
          address: apiAddress,
          contact: {
            profile,
            inbox,
            inboundWakeupToken,
            outboundWakeupToken,
            pinnedAddress,
            masterPublicKeyHex,
            lastRotationSequence,
            rotatedFromAddress,
            rotationNotice,
            rotationWarning,
            handleConflictWarning,
            unverifiedHandleResolution,
          },
        })
        return
      }
      contact.lastUpdateTime = moment().valueOf()
      contact.profile = profile || contact.profile
      contact.inbox = inbox || contact.inbox
      if (inboundWakeupToken !== undefined) {
        contact.inboundWakeupToken = inboundWakeupToken
      }
      if (outboundWakeupToken !== undefined) {
        contact.outboundWakeupToken = outboundWakeupToken
      }
      if (pinnedAddress !== undefined) {
        contact.pinnedAddress = toChainDisplayAddress(pinnedAddress)
      }
      if (masterPublicKeyHex !== undefined) {
        contact.masterPublicKeyHex = masterPublicKeyHex
          ? normalizeMasterPublicKeyHex(masterPublicKeyHex) ??
            masterPublicKeyHex.toLowerCase()
          : null
      }
      if (lastRotationSequence !== undefined) {
        contact.lastRotationSequence = lastRotationSequence
      }
      if (rotatedFromAddress !== undefined) {
        contact.rotatedFromAddress = rotatedFromAddress
      }
      if (rotationNotice !== undefined) {
        contact.rotationNotice = rotationNotice
      }
      if (rotationWarning !== undefined) {
        contact.rotationWarning = rotationWarning
      }
      if (handleConflictWarning !== undefined) {
        contact.handleConflictWarning = handleConflictWarning
      }
      if (unverifiedHandleResolution !== undefined) {
        contact.unverifiedHandleResolution = unverifiedHandleResolution
      }
    },
    setNotify({ address, value }: { address: string; value: boolean }) {
      const apiAddress = safeChainDisplayAddress(address)
      if (!apiAddress) return
      const contact = this.contacts[apiAddress]
      if (!contact) {
        return
      }
      contact.notify = value
      // Muting or unmuting a contact immediately updates the relay's blinded wakeup token allowlist.
      void syncRelayNotificationPolicy()
    },
    setInboundWakeupToken({
      address,
      token,
    }: {
      address: string
      token: string | undefined
    }) {
      const apiAddress = safeChainDisplayAddress(address)
      if (!apiAddress) return
      const contact = this.contacts[apiAddress]
      if (!contact) return
      contact.inboundWakeupToken = token
      void syncRelayNotificationPolicy()
    },
    setOutboundWakeupToken({
      address,
      token,
    }: {
      address: string
      token: string | undefined
    }) {
      const apiAddress = safeChainDisplayAddress(address)
      if (!apiAddress) return
      const contact = this.contacts[apiAddress]
      if (contact) {
        contact.outboundWakeupToken = token
      } else if (token) {
        pendingOutboundWakeupTokens.set(apiAddress, token)
      } else {
        pendingOutboundWakeupTokens.delete(apiAddress)
      }
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
      const apiAddress = safeChainDisplayAddress(address)
      const revision = accountSession.state.revision
      const account = accountSession.state.account
      const contacts = this.contacts
      const assertCurrent = () => {
        if (
          accountSession.state.revision !== revision ||
          accountSession.state.account !== account ||
          this.contacts !== contacts
        )
          throw new Error('Account changed during contact deletion')
      }

      // The contact is one peer; independent direct/email threads keep their identities until
      // the user explicitly deletes the contact. Groups containing this peer are not theirs.
      const conversationIds = chats
        .getConversationsForAddress(address)
        .filter(
          conversation =>
            (conversation.kind === 'direct' || conversation.kind === 'email') &&
            sameCanonicalAddress(conversation.address, address) &&
            new Set(
              conversation.participants.map(
                participant =>
                  safeChainDisplayAddress(participant) || participant,
              ),
            ).size <= 2,
        )
        .map(conversation => conversation.id)
      for (const id of conversationIds) {
        assertCurrent()
        await chats.deleteConversation(id)
        assertCurrent()
      }
      assertCurrent()
      if (apiAddress && apiAddress in this.contacts) {
        delete this.contacts[apiAddress]
      }
      if (apiAddress) {
        pendingOutboundWakeupTokens.delete(apiAddress)
      }
      if (apiAddress && !this.dismissedDefaults.includes(apiAddress)) {
        this.dismissedDefaults.push(apiAddress)
      }
      // Deleting a contact immediately revokes its wakeup capability token hash on the relay.
      void syncRelayNotificationPolicy()
    },
    /** Resolve a signed Monad profile through the active-chain seam. */
    async fetchAndAddContact({
      address,
      contact,
    }: {
      address: string
      contact: Partial<ContactState>
    }) {
      if (!isChainAddress(address)) {
        return
      }
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
        const handle = await relayHandleOf(displayAddress)
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
              username: handle?.username ?? null,
              bio: profileInfo.bio ?? '',
              avatar: profileInfo.avatar ?? '',
              location: profileInfo.location ?? null,
              links: profileInfo.links ?? [],
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
      const inferred = inferCuratedBotAttributes(name)
      const contact = {
        ...pendingRelayData,
        profile: {
          ...pendingRelayData.profile,
          name: name,
          bio: '',
          avatar: null,
          pubKey: null,
          isBot: inferred.isBot ?? true,
          accountType: inferred.accountType,
          botRole: inferred.botRole,
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
    isCurated(address: string): boolean {
      try {
        const canonical = toChainDisplayAddress(address)
        return this.curatedDefaults.some(d => d.address === canonical)
      } catch {
        return false
      }
    },
    async refreshContacts() {
      const stateKey = toRaw(this.$state)
      const existing = inFlightRefreshAll.get(stateKey)
      if (existing) return existing

      const run = (async () => {
        const addresses = Object.keys(this.contacts)
        const CONCURRENCY_LIMIT = 6
        for (let i = 0; i < addresses.length; i += CONCURRENCY_LIMIT) {
          const chunk = addresses.slice(i, i + CONCURRENCY_LIMIT)
          await Promise.all(
            chunk.map(async address => {
              try {
                await this.refresh(address)
              } catch (err) {
                console.error(`Failed to refresh contact ${address}:`, err)
              }
            }),
          )
        }
      })()

      inFlightRefreshAll.set(stateKey, run)
      try {
        await run
      } finally {
        if (inFlightRefreshAll.get(stateKey) === run) {
          inFlightRefreshAll.delete(stateKey)
        }
      }
    },
    async refresh(address: string) {
      if (!isChainAddress(address)) {
        return
      }
      const canonical = safeToChainDisplayAddress(address) ?? address
      const existing = inFlightRefreshes.get(canonical)
      if (existing) return existing

      const refreshOp = (async () => {
        const oldContactInfo = this.getContact(address)
        const updateInterval = this.updateInterval
        const now = moment()
        const lastUpdateTime = oldContactInfo.lastUpdateTime ?? 0
        const isFresh =
          lastUpdateTime > 0 &&
          updateInterval > 0 &&
          moment(now).diff(moment(lastUpdateTime), 'milliseconds') <
            updateInterval
        const botUnknown =
          oldContactInfo.profile && oldContactInfo.profile.isBot === undefined
        // A profile saved before signed-name provenance has a fresh picture and bot flag, so the
        // hourly skip would leave it unknown forever. Unknown provenance must be fetched. A
        // known blank signed name is not unknown and must not be refreshed just to fill it.
        const signedNameUnknown =
          oldContactInfo.profile &&
          oldContactInfo.profile.signedName === undefined
        if (isFresh && !botUnknown && !signedNameUnknown) {
          // Short circuit if we already updated this contact recently.
          return
        }

        try {
          const chainAddress = activeChain.parseAddress(address)
          if (!chainAddress) {
            throw new Error(`Invalid ${activeChain.name} address: ${address}`)
          }
          // The handle is whatever the relay's name store says this address holds now. When
          // the relay cannot be asked, what was known is kept.
          const handle = await relayHandleOf(
            canonical,
            oldContactInfo.profile?.addedByUsername,
          )
          const handleFields =
            handle === undefined
              ? {}
              : {
                  username: handle.username,
                  usernameReassigned: handle.reassigned,
                }
          const handleConflictPatch =
            handle === undefined
              ? {}
              : handle.reassigned
              ? {
                  handleConflictWarning:
                    oldContactInfo.handleConflictWarning ??
                    `Handle "${
                      oldContactInfo.profile?.addedByUsername ?? ''
                    }" is now held by a different address without a verified key rotation; keeping pinned address ${canonical}`,
                }
              : {
                  handleConflictWarning: null,
                  unverifiedHandleResolution: null,
                }
          const profileInfo = await fetchContactProfile(chainAddress)
          if (!profileInfo) {
            console.debug(`No registered profile found for ${address}`)
            const displayAddress = safeToChainDisplayAddress(address) ?? address
            const currentName = oldContactInfo.profile?.name
            const name =
              !isBlankName(currentName) &&
              currentName !== pendingRelayData.profile.name
                ? currentName
                : `${shortAddressLabel(displayAddress)} (Unregistered)`
            this.updateContact({
              address,
              ...handleConflictPatch,
              profile: {
                ...oldContactInfo.profile,
                ...handleFields,
                name,
                signedName: oldContactInfo.profile.signedName ?? null,
                isBot: oldContactInfo.profile.isBot ?? false,
                accountType: oldContactInfo.profile.accountType ?? 0,
                botRole: oldContactInfo.profile.botRole,
              },
              inbox: oldContactInfo.inbox,
            })
            return
          }
          const oldName = oldContactInfo.profile.name
          this.updateContact({
            address,
            ...handleConflictPatch,
            profile: {
              ...oldContactInfo.profile,
              // A registered profile without a display name must not keep the "Loading..."
              // placeholder (#317); a name the user already has for this contact is kept.
              name: !isBlankName(profileInfo.name)
                ? (profileInfo.name as string)
                : typeof oldName === 'string' &&
                  !isBlankName(oldName) &&
                  oldName !== pendingRelayData.profile.name &&
                  !oldName.endsWith('(Unregistered)')
                ? oldName
                : shortAddressLabel(
                    safeToChainDisplayAddress(address) ?? address,
                  ),
              signedName: profileInfo.name ?? null,
              ...handleFields,
              bio: profileInfo.bio ?? oldContactInfo.profile.bio,
              avatar: profileInfo.avatar ?? oldContactInfo.profile.avatar,
              location:
                profileInfo.location ?? oldContactInfo.profile.location ?? null,
              links: profileInfo.links ?? oldContactInfo.profile.links ?? [],
              isBot: profileInfo.bot === true,
              accountType: profileInfo.accountType,
              botRole: profileInfo.botRole,
              pubKey: markRaw(profilePubKeyFromBytes(profileInfo.pubKey)),
            },
            inbox: oldContactInfo.inbox,
          })
        } catch (err) {
          console.error(err)
          const displayAddress = safeToChainDisplayAddress(address) ?? address
          const currentName = oldContactInfo.profile?.name
          if (
            isBlankName(currentName) ||
            currentName === pendingRelayData.profile.name
          ) {
            this.updateContact({
              address,
              profile: {
                ...oldContactInfo.profile,
                name: `${shortAddressLabel(displayAddress)} (Unregistered)`,
              },
              inbox: oldContactInfo.inbox,
            })
          }
        }
      })()

      inFlightRefreshes.set(canonical, refreshOp)
      try {
        await refreshOp
      } finally {
        inFlightRefreshes.delete(canonical)
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
    async restore(storage): Promise<Partial<State>> {
      const deserializedProfile = await readStoreJson<RestorableState>(
        storage,
        'contacts',
        (k, v) => {
          switch (k) {
            // Restore pubKey binary string to Uint8Array
            case 'pubKey': {
              if (!v) return null
              // pubKey will be an object if not processed via JSON.stringify replacer function
              const buf =
                typeof v != 'string'
                  ? Object.values(v as object)
                  : Buffer.from(v, 'binary')
              return new Uint8Array(buf)
            }
          }
          return v
        },
      )
      const rehydratedContacts = await rehydrateContacts(deserializedProfile)
      return rehydratedContacts
    },
  },
})

setOutboundWakeupTokenProvider((recipientAddress: string) => {
  try {
    const apiAddress =
      safeToChainDisplayAddress(recipientAddress) ?? recipientAddress
    if (!apiAddress) return undefined
    const store = useContactStore()
    return (
      store.contacts[apiAddress]?.outboundWakeupToken ??
      pendingOutboundWakeupTokens.get(apiAddress)
    )
  } catch {
    return pendingOutboundWakeupTokens.get(
      safeToChainDisplayAddress(recipientAddress) ?? recipientAddress,
    )
  }
})
