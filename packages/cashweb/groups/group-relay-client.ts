import { secp256k1 } from '@noble/curves/secp256k1.js'
import { directoryAddress } from '../relay/open-directory'
import type { GroupEpochCertificate } from './types'
import axios, { type AxiosInstance } from 'axios'
import { randomBytes } from '@frank/crypto-box'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { concatBytes } from '@noble/hashes/utils.js'
import {
  bytesToHex,
  deriveEpochKeys,
  decryptGroupRoster,
  verifyEpochFrame,
  deriveGroupIdentity,
  deriveIdentityMemberEpochPublicKey,
  hexToBytes,
  deriveNextEpochSecret,
  encryptGroupRoster,
  signEpochFrame,
  type GroupEpochFrameWire,
  type GroupEpochKeys,
  type GroupIdentity,
  type GroupRoster,
  type GroupRosterMember,
  type SealedGroupMessageEnvelope,
} from './group-crypto'

export interface PublishEpochResponse {
  epoch: number
  epoch_hash: string
  group_pubkey: string
}

export interface StoredGroupMessageWire extends SealedGroupMessageEnvelope {
  group_id: string
  server_seq: number
  server_time_ms: number
  versionstamp: string
}
export type SendGroupMessageResponse = StoredGroupMessageWire

export interface FetchGroupMessagesResponse {
  group_id: string
  epoch: number
  messages: StoredGroupMessageWire[]
}

export interface GroupRelayClientOptions {
  axiosInstance?: AxiosInstance
  timeoutMs?: number
  homeRelayUrl?: string
  subscriberTag?: (groupIdHex: string) => Promise<string>
}

function normalizeGroupId(groupIdHex: string): string {
  const id = groupIdHex
    .trim()
    .replace(/^group:/i, '')
    .toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid group identifier')
  return id
}

/** The one canonical name rule for writers and signed-roster admission. */
function canonicalGroupName(value: string): string {
  if (typeof value !== 'string') throw new Error('Invalid group name')
  const name = value.trim()
  // Direction overrides/isolates and control characters cannot safely name a conversation.
  // eslint-disable-next-line no-control-regex
  if (
    !name ||
    new TextEncoder().encode(name).length > 128 ||
    /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(name)
  )
    throw new Error('Invalid group name')
  return name
}

export function normalizeGroupRelayOrigin(relayUrl: string): string {
  const parsed = new URL(relayUrl)
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/' ||
    (parsed.protocol !== 'https:' &&
      !(
        parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      ))
  )
    throw new Error('Invalid group relay URL')
  return parsed.href.replace(/\/+$/, '')
}

/**
 * HTTP client for the shared group mailbox endpoints on `cashweb-registry` (Issues #70 & #1365):
 * - `PUT /groups/:group_id/epochs` (with optional `If-Match` CAS header)
 * - `GET /groups/:group_id/epochs` (public root-signed certificate)
 * - `PUT /groups/:group_id/messages` (authenticated via outer shared write signature `write_sig`)
 * - `GET /groups/:group_id/messages?after_seq=&limit=` (authenticated via `X-Group-Read-Token`)
 */
export class GroupRelayClient {
  readonly relayUrl: string
  private readonly http: AxiosInstance
  private readonly transportUrl: string
  private readonly subscriberTag?: (groupIdHex: string) => Promise<string>

  constructor(relayUrl: string, options: GroupRelayClientOptions = {}) {
    this.relayUrl = normalizeGroupRelayOrigin(relayUrl)
    this.transportUrl = normalizeGroupRelayOrigin(
      options.homeRelayUrl ?? relayUrl,
    )
    this.subscriberTag = options.subscriberTag
    this.http =
      options.axiosInstance ??
      axios.create({
        baseURL: this.transportUrl,
        timeout: options.timeoutMs ?? 15_000,
      })
  }

  private routingHeaders(): Record<string, string> {
    return this.transportUrl === this.relayUrl
      ? {}
      : { 'X-Group-Upstream-Relay': this.relayUrl }
  }

  /**
   * Publishes or rotates a group epoch frame (`G_meta` / `G_epoch`) using atomic CAS.
   * For epoch > 0, `expectedPrevEpochHash` is sent as the `If-Match` HTTP header.
   */
  async publishEpoch(
    groupIdHex: string,
    frame: GroupEpochFrameWire,
    expectedPrevEpochHash?: string,
  ): Promise<PublishEpochResponse> {
    const cleanGroupId = normalizeGroupId(groupIdHex)
    const wireBody = {
      group_id: cleanGroupId,
      epoch: frame.epoch,
      ...(frame.group_pubkey ? { group_pubkey: frame.group_pubkey } : {}),
      prev_epoch_hash: frame.prev_epoch_hash,
      write_pubkey: frame.write_pubkey,
      read_token_hash: frame.read_token_hash,
      encrypted_epoch_descriptor: frame.encrypted_roster,
      admin_sig: frame.authority_sig,
      ...(frame.epoch_hash ? { epoch_hash: frame.epoch_hash } : {}),
    }
    const headers: Record<string, string> = this.routingHeaders()
    if (expectedPrevEpochHash) {
      headers['If-Match'] = expectedPrevEpochHash.trim().toLowerCase()
    }
    const response = await this.http.put<PublishEpochResponse>(
      `${this.transportUrl}/groups/${cleanGroupId}/epochs`,
      wireBody,
      { headers },
    )
    if (
      response.data.epoch !== frame.epoch ||
      response.data.epoch_hash !== frame.epoch_hash ||
      response.data.group_pubkey !== frame.group_pubkey
    )
      throw new Error('Invalid group epoch acknowledgement')
    return response.data
  }

  /**
   * Fetches the public root-signed latest epoch certificate for `groupIdHex`.
   */
  async getLatestEpoch(groupIdHex: string): Promise<GroupEpochFrameWire> {
    return this.getEpoch(groupIdHex)
  }

  /** Public signed certificate only; does not provide historical epoch secrets. */
  async getEpoch(
    groupIdHex: string,
    epoch?: number,
  ): Promise<GroupEpochFrameWire> {
    if (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 0))
      throw new Error('Invalid requested group epoch')
    const cleanGroupId = normalizeGroupId(groupIdHex)
    const response = await this.http.get<Record<string, unknown>>(
      `${this.transportUrl}/groups/${cleanGroupId}/epochs`,
      {
        headers: this.routingHeaders(),
        ...(epoch === undefined ? {} : { params: { epoch } }),
      },
    )
    const raw = response.data
    if (
      raw.group_id !== cleanGroupId ||
      !Number.isSafeInteger(raw.epoch) ||
      Number(raw.epoch) < 0 ||
      (epoch !== undefined && raw.epoch !== epoch) ||
      typeof raw.group_pubkey !== 'string' ||
      typeof raw.prev_epoch_hash !== 'string' ||
      typeof raw.write_pubkey !== 'string' ||
      typeof raw.read_token_hash !== 'string' ||
      typeof raw.encrypted_epoch_descriptor !== 'string' ||
      typeof raw.admin_sig !== 'string' ||
      typeof raw.epoch_hash !== 'string'
    )
      throw new Error('Invalid group epoch response')
    const encryptedRoster = String(raw.encrypted_epoch_descriptor ?? '')
    const authoritySig = String(raw.admin_sig ?? '')
    return {
      group_id: String(raw.group_id ?? cleanGroupId),
      epoch: Number(raw.epoch ?? 0),
      ...(typeof raw.group_pubkey === 'string'
        ? { group_pubkey: raw.group_pubkey }
        : {}),
      prev_epoch_hash: String(raw.prev_epoch_hash ?? '00'.repeat(32)),
      write_pubkey: String(raw.write_pubkey ?? ''),
      read_token_hash: String(raw.read_token_hash ?? ''),
      encrypted_roster: encryptedRoster,
      authority_sig: authoritySig,
      ...(typeof raw.epoch_hash === 'string'
        ? { epoch_hash: raw.epoch_hash }
        : {}),
    }
  }

  /**
   * Appends a sealed-sender group message (`SealedGroupMessageEnvelope`) to the group mailbox.
   */
  async sendGroupMessage(
    groupIdHex: string,
    envelope: SealedGroupMessageEnvelope,
  ): Promise<SendGroupMessageResponse> {
    const cleanGroupId = normalizeGroupId(groupIdHex)
    const response = await this.http.put<SendGroupMessageResponse>(
      `${this.transportUrl}/groups/${cleanGroupId}/messages`,
      {
        group_id: cleanGroupId,
        epoch: envelope.epoch,
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
        write_sig: envelope.write_sig,
      },
      { headers: this.routingHeaders() },
    )
    const row = response.data
    if (
      row.group_id !== cleanGroupId ||
      row.epoch !== envelope.epoch ||
      row.nonce !== envelope.nonce ||
      row.ciphertext !== envelope.ciphertext ||
      row.write_sig !== envelope.write_sig ||
      !Number.isSafeInteger(row.server_seq) ||
      row.server_seq <= 0 ||
      !Number.isSafeInteger(row.server_time_ms) ||
      row.server_time_ms < 0
    )
      throw new Error('Invalid group message acknowledgement')
    return row
  }

  /**
   * Fetches ordered group messages with `server_seq > afterSeq` from the relay, authenticating
   * with `X-Group-Read-Token`.
   */
  async fetchGroupMessages(
    groupIdHex: string,
    readTokenHex: string,
    afterSeq = 0,
    limit = 100,
  ): Promise<FetchGroupMessagesResponse> {
    const cleanGroupId = normalizeGroupId(groupIdHex)
    const response = await this.http.get<FetchGroupMessagesResponse>(
      `${this.transportUrl}/groups/${cleanGroupId}/messages`,
      {
        params: {
          after_seq: afterSeq,
          limit,
        },
        headers: {
          ...this.routingHeaders(),
          ...(this.subscriberTag
            ? {
                'X-Group-Subscriber-Tag': await this.subscriberTag(
                  cleanGroupId,
                ),
              }
            : {}),
          'X-Group-Read-Token': readTokenHex.trim().toLowerCase(),
        },
      },
    )
    const data = response.data
    if (
      data.group_id !== cleanGroupId ||
      !Number.isSafeInteger(data.epoch) ||
      data.epoch < 0 ||
      !Array.isArray(data.messages)
    )
      throw new Error('Invalid group mailbox response')
    return data
  }
}

export interface CreateGroupOnRelayMemberInput {
  address: string
  role?: 'admin' | 'member'
  identityPubKeyHex: string
}

export interface CreateGroupOnRelayParams {
  client: GroupRelayClient
  groupName: string
  creatorAddress: string
  creatorIdentityPubKeyHex: string
  members?: readonly CreateGroupOnRelayMemberInput[]
  groupSeed?: Uint8Array
  initialEpochSecret?: Uint8Array
}

export interface CreateGroupOnRelayResult {
  identity: GroupIdentity
  epochKeys: GroupEpochKeys
  roster: GroupRoster
  epochFrame: GroupEpochFrameWire
  epochHash: string
}

/**
 * High-level helper that derives a new group root identity, computes epoch 0 keys,
 * builds & encrypts the initial member roster, signs epoch 0, and publishes it to the relay.
 */
export function prepareGroupCreation(
  params: CreateGroupOnRelayParams,
): CreateGroupOnRelayResult {
  const groupName = canonicalGroupName(params.groupName)
  const identity = deriveGroupIdentity(params.groupSeed ?? randomBytes(32))
  const epochSecret = params.initialEpochSecret ?? randomBytes(32)
  const epochKeys = deriveEpochKeys(epochSecret, identity.groupIdHex, 0)

  const seenAddresses = new Set<string>()
  const rosterMembers: GroupRosterMember[] = []

  const addRosterMember = (
    addressRaw: string,
    role: 'admin' | 'member',
    identityPubKeyHex: string,
  ) => {
    const address = addressRaw.trim().toLowerCase()
    if (!address || directoryAddress(identityPubKeyHex) !== address)
      throw new Error('Group member identity mismatch')
    if (seenAddresses.has(address)) return
    seenAddresses.add(address)
    const index = rosterMembers.length
    const epochSigningPubKeyHex = bytesToHex(
      deriveIdentityMemberEpochPublicKey(
        hexToBytes(identityPubKeyHex),
        identity.groupIdHex,
        0,
      ),
    )
    rosterMembers.push({
      index,
      address,
      epochSigningPubKeyHex,
      identityPubKeyHex,
      role,
    })
  }

  addRosterMember(
    params.creatorAddress,
    'admin',
    params.creatorIdentityPubKeyHex,
  )
  for (const entry of params.members ?? []) {
    addRosterMember(
      entry.address,
      entry.role ?? 'member',
      entry.identityPubKeyHex,
    )
  }

  if (
    rosterMembers.length > 256 ||
    rosterMembers.filter(member => member.role === 'admin').length !== 1
  )
    throw new Error('Invalid group roster or name')
  const roster: GroupRoster = {
    epoch: 0,
    groupName,
    homeRelay: params.client.relayUrl,
    members: rosterMembers,
  }

  const encryptedRoster = encryptGroupRoster(roster, epochKeys)
  const epochFrame = signEpochFrame({
    groupIdHex: identity.groupIdHex,
    groupPubKeyHex: identity.groupPubKeyHex,
    epoch: 0,
    prevEpochHashHex: '00'.repeat(32),
    epochKeys,
    encryptedRoster,
    authorityPrivateKey: identity.groupSecretKey,
  })

  const epochHash = epochFrame.epoch_hash!

  return {
    identity,
    epochKeys,
    roster,
    epochFrame: {
      ...epochFrame,
      epoch_hash: epochHash,
    },
    epochHash,
  }
}

export interface RotateGroupEpochOnRelayParams {
  client: GroupRelayClient
  groupIdHex: string
  groupPubKeyHex?: string
  prevEpoch: number
  prevEpochHashHex: string
  prevEpochSecret: Uint8Array
  nextEpochSecret?: Uint8Array
  freshEntropy?: Uint8Array
  groupName: string
  members: readonly CreateGroupOnRelayMemberInput[]
  authorityPrivateKey: Uint8Array
}

export interface RotateGroupEpochOnRelayResult {
  epoch: number
  epochSecret: Uint8Array
  epochSecretHex: string
  epochKeys: GroupEpochKeys
  roster: GroupRoster
  epochFrame: GroupEpochFrameWire
  epochHash: string
}

/**
 * The secret of the epoch that follows `prevEpochHashHex`. It mixes entropy that only the
 * founding administrator's key can produce into the previous secret, so a removed member (who
 * knows the previous secret but not the administrator key) cannot derive it, while every device
 * of the administrator account computes the same value without coordination. When two of those
 * devices race to publish different rosters for the same successor, the device whose relay CAS
 * loses can therefore open and adopt the winning certificate instead of being stuck behind it.
 */
export function deriveAdminEpochSecret(params: {
  authorityPrivateKey: Uint8Array
  groupIdHex: string
  prevEpochSecret: Uint8Array
  prevEpochHashHex: string
  nextEpoch: number
}): Uint8Array {
  const cleanGroupId = normalizeGroupId(params.groupIdHex)
  const prevHash = hexToBytes(params.prevEpochHashHex)
  if (params.authorityPrivateKey.length !== 32 || prevHash.length !== 32)
    throw new Error('Invalid group rotation authority input')
  const entropy = hkdf(
    sha256,
    params.authorityPrivateKey,
    concatBytes(hexToBytes(cleanGroupId), prevHash),
    new TextEncoder().encode(
      `frank-group-admin-rotation-v1:${params.nextEpoch}`,
    ),
    32,
  )
  return deriveNextEpochSecret(
    params.prevEpochSecret,
    cleanGroupId,
    params.nextEpoch,
    entropy,
  )
}

/**
 * Ratchets or rotates a group to `prevEpoch + 1`, re-deriving per-member epoch signing keys,
 * encrypting the updated `GroupRoster`, signing the new `GroupEpochFrame`, and publishing it
 * to the relay with `If-Match: prevEpochHashHex` Compare-And-Swap protection.
 */
export function prepareGroupEpochRotation(
  params: RotateGroupEpochOnRelayParams,
): RotateGroupEpochOnRelayResult {
  const groupName = canonicalGroupName(params.groupName)
  const cleanGroupId = normalizeGroupId(params.groupIdHex)
  const nextEpoch = params.prevEpoch + 1
  const nextEpochSecret =
    params.nextEpochSecret ??
    (params.freshEntropy
      ? deriveNextEpochSecret(
          params.prevEpochSecret,
          cleanGroupId,
          nextEpoch,
          params.freshEntropy,
        )
      : deriveAdminEpochSecret({
          authorityPrivateKey: params.authorityPrivateKey,
          groupIdHex: cleanGroupId,
          prevEpochSecret: params.prevEpochSecret,
          prevEpochHashHex: params.prevEpochHashHex,
          nextEpoch,
        }))
  const epochKeys = deriveEpochKeys(nextEpochSecret, cleanGroupId, nextEpoch)

  const seenAddresses = new Set<string>()
  const rosterMembers: GroupRosterMember[] = []
  for (const entry of params.members) {
    const address = entry.address.trim().toLowerCase()
    if (!address || directoryAddress(entry.identityPubKeyHex) !== address)
      throw new Error('Group member identity mismatch')
    if (seenAddresses.has(address)) continue
    seenAddresses.add(address)
    const index = rosterMembers.length
    const role = entry.role ?? 'member'
    const identityPubKeyHex = entry.identityPubKeyHex
    const epochSigningPubKeyHex = bytesToHex(
      deriveIdentityMemberEpochPublicKey(
        hexToBytes(identityPubKeyHex),
        cleanGroupId,
        nextEpoch,
      ),
    )
    rosterMembers.push({
      index,
      address,
      epochSigningPubKeyHex,
      identityPubKeyHex,
      role,
    })
  }

  if (
    rosterMembers.length > 256 ||
    rosterMembers.filter(member => member.role === 'admin').length !== 1
  )
    throw new Error('Invalid group roster or name')
  const roster: GroupRoster = {
    epoch: nextEpoch,
    groupName,
    homeRelay: params.client.relayUrl,
    members: rosterMembers,
  }

  const encryptedRoster = encryptGroupRoster(roster, epochKeys)
  const epochFrame = signEpochFrame({
    groupIdHex: cleanGroupId,
    groupPubKeyHex: params.groupPubKeyHex,
    epoch: nextEpoch,
    prevEpochHashHex: params.prevEpochHashHex,
    epochKeys,
    encryptedRoster,
    authorityPrivateKey: params.authorityPrivateKey,
  })

  const epochHash = epochFrame.epoch_hash!

  return {
    epoch: nextEpoch,
    epochSecret: nextEpochSecret,
    epochSecretHex: bytesToHex(nextEpochSecret),
    epochKeys,
    roster,
    epochFrame: {
      ...epochFrame,
      epoch_hash: epochHash,
    },
    epochHash,
  }
}

/** Normalize the signed certificate carried by invitations and membership controls. */
export function groupEpochCertificate(
  frame: GroupEpochFrameWire,
): GroupEpochCertificate {
  if (!frame.group_pubkey || !frame.epoch_hash)
    throw new Error('Missing signed group epoch certificate')
  return {
    epoch: frame.epoch,
    group_pubkey: frame.group_pubkey,
    prev_epoch_hash: frame.prev_epoch_hash,
    write_pubkey: frame.write_pubkey,
    read_token_hash: frame.read_token_hash,
    encrypted_roster: frame.encrypted_roster,
    authority_sig: frame.authority_sig,
    epoch_hash: frame.epoch_hash,
  }
}

/** Only authenticated group metadata can become a local roster. */
export function openGroupEpochCertificate(params: {
  groupIdHex: string
  groupPubKeyHex: string
  epochSecretHex: string
  certificate: GroupEpochCertificate
  expectedPreviousHash?: string
  expectedEpoch?: number
}): { roster: GroupRoster; epochKeys: GroupEpochKeys } {
  const cert = params.certificate
  if (!verifyEpochFrame(cert, params.groupIdHex, params.groupPubKeyHex))
    throw new Error('Invalid group epoch certificate')
  if (
    params.expectedPreviousHash !== undefined &&
    cert.prev_epoch_hash !== params.expectedPreviousHash
  )
    throw new Error('Group epoch predecessor mismatch')
  if (params.expectedEpoch !== undefined && cert.epoch !== params.expectedEpoch)
    throw new Error('Group epoch sequence mismatch')
  const epochKeys = deriveEpochKeys(
    hexToBytes(params.epochSecretHex),
    params.groupIdHex,
    cert.epoch,
  )
  if (
    cert.write_pubkey !== epochKeys.writeKeyPair.publicKeyHex ||
    cert.read_token_hash !== epochKeys.readTokenHashHex
  )
    throw new Error('Group epoch secret does not match certificate')
  const roster = decryptGroupRoster(cert.encrypted_roster, epochKeys)
  if (canonicalGroupName(roster.groupName) !== roster.groupName)
    throw new Error('Invalid group name')
  if (
    typeof roster.homeRelay !== 'string' ||
    normalizeGroupRelayOrigin(roster.homeRelay) !== roster.homeRelay
  )
    throw new Error('Invalid group relay URL')
  if (!roster.members.length || roster.members.length > 256)
    throw new Error('Invalid group roster size')
  const addresses = new Set<string>(),
    indices = new Set<number>()
  for (const member of roster.members) {
    if (
      !Number.isInteger(member.index) ||
      member.index < 0 ||
      member.index > 255 ||
      indices.has(member.index)
    )
      throw new Error('Invalid group member index')
    indices.add(member.index)
    const address = directoryAddress(member.identityPubKeyHex)
    if (member.address !== address || addresses.has(address))
      throw new Error('Group member identity mismatch')
    addresses.add(address)
    const expected = bytesToHex(
      deriveIdentityMemberEpochPublicKey(
        hexToBytes(member.identityPubKeyHex),
        params.groupIdHex,
        cert.epoch,
      ),
    )
    if (expected !== member.epochSigningPubKeyHex)
      throw new Error('Group member signing key mismatch')
  }
  if (roster.members.filter(member => member.role === 'admin').length !== 1)
    throw new Error('Group must have one founding administrator')
  return { roster, epochKeys }
}

/** Convenience publication for hosts that already own their durability boundary. */
export async function createGroupOnRelay(
  params: CreateGroupOnRelayParams,
): Promise<CreateGroupOnRelayResult> {
  const prepared = prepareGroupCreation(params)
  await params.client.publishEpoch(
    prepared.identity.groupIdHex,
    prepared.epochFrame,
  )
  return prepared
}
export async function rotateGroupEpochOnRelay(
  params: RotateGroupEpochOnRelayParams,
): Promise<RotateGroupEpochOnRelayResult> {
  const prepared = prepareGroupEpochRotation(params)
  await params.client.publishEpoch(
    params.groupIdHex,
    prepared.epochFrame,
    params.prevEpochHashHex,
  )
  return prepared
}

/** Only the founding administrator's self-mailbox carries this scoped group capability. */
export function groupAdminSecretMatches(
  secretHex: string,
  publicKeyHex: string,
): boolean {
  try {
    return (
      bytesToHex(secp256k1.getPublicKey(hexToBytes(secretHex), true)) ===
      publicKeyHex
    )
  } catch {
    return false
  }
}
