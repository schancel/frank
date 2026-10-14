import { directoryAddress } from '../relay/open-directory'
import type { GroupEpochCertificate } from '../types/messages'
import axios, { type AxiosInstance } from 'axios'
import { randomBytes } from '@frank/crypto-box'
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
  status: string
  group_id: string
  epoch: number
  epoch_hash: string
}

export interface SendGroupMessageResponse {
  status: string
  group_id: string
  server_seq: number
  received_at_ms: number
}

export interface StoredGroupMessageWire extends SealedGroupMessageEnvelope {
  group_id: string
  server_seq: number
  received_at_ms: number
}

export interface FetchGroupMessagesResponse {
  group_id: string
  epoch: number
  messages: StoredGroupMessageWire[]
}

export interface GroupRelayClientOptions {
  axiosInstance?: AxiosInstance
  timeoutMs?: number
}

function normalizeGroupId(groupIdHex: string): string {
  return groupIdHex.trim().replace(/^group:/i, '').toLowerCase()
}

function normalizeRelayBaseUrl(relayUrl: string): string {
  return relayUrl.trim().replace(/\/+$/, '')
}

/**
 * HTTP client for the shared group mailbox endpoints on `cashweb-registry` (Issues #70 & #1365):
 * - `PUT /groups/:group_id/epoch` (with optional `If-Match` CAS header)
 * - `GET /groups/:group_id/epoch` (authenticated via `X-Frank-Group-Read-Token`)
 * - `PUT /groups/:group_id/messages` (authenticated via outer shared write signature `write_sig`)
 * - `GET /groups/:group_id/messages?after_seq=&limit=` (authenticated via `X-Frank-Group-Read-Token`)
 */
export class GroupRelayClient {
  readonly relayUrl: string
  private readonly http: AxiosInstance

  constructor(relayUrl: string, options: GroupRelayClientOptions = {}) {
    this.relayUrl = normalizeRelayBaseUrl(relayUrl)
    this.http =
      options.axiosInstance ??
      axios.create({
        baseURL: this.relayUrl,
        timeout: options.timeoutMs ?? 15_000,
      })
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
    const encryptedDescriptor =
      frame.encrypted_epoch_descriptor ?? frame.encrypted_roster
    const adminSig = frame.admin_sig ?? frame.authority_sig
    const wireBody = {
      group_id: cleanGroupId,
      epoch: frame.epoch,
      ...(frame.group_pubkey ? { group_pubkey: frame.group_pubkey } : {}),
      prev_epoch_hash: frame.prev_epoch_hash,
      write_pubkey: frame.write_pubkey,
      read_token_hash: frame.read_token_hash,
      encrypted_epoch_descriptor: encryptedDescriptor,
      admin_sig: adminSig,
      ...(frame.epoch_hash ? { epoch_hash: frame.epoch_hash } : {}),
    }
    const headers: Record<string, string> = {}
    if (expectedPrevEpochHash) {
      headers['If-Match'] = expectedPrevEpochHash.trim().toLowerCase()
    }
    const response = await this.http.put<PublishEpochResponse>(
      `${this.relayUrl}/groups/${cleanGroupId}/epoch`,
      wireBody,
      { headers },
    )
    return response.data
  }

  /**
   * Fetches the latest `GroupEpochFrame` (`G_meta`) for `groupIdHex`, authenticating with
   * the current epoch's `readTokenHex` in `X-Frank-Group-Read-Token`.
   */
  async getLatestEpoch(
    groupIdHex: string,
    readTokenHex: string,
  ): Promise<GroupEpochFrameWire> {
    const cleanGroupId = normalizeGroupId(groupIdHex)
    const response = await this.http.get<Record<string, unknown>>(
      `${this.relayUrl}/groups/${cleanGroupId}/epoch`,
      {
        headers: {
          'X-Frank-Group-Read-Token': readTokenHex.trim().toLowerCase(),
        },
      },
    )
    const raw = response.data
    const encryptedRoster = String(
      raw.encrypted_roster ?? raw.encrypted_epoch_descriptor ?? '',
    )
    const authoritySig = String(raw.authority_sig ?? raw.admin_sig ?? '')
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
      encrypted_epoch_descriptor: encryptedRoster,
      authority_sig: authoritySig,
      admin_sig: authoritySig,
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
      `${this.relayUrl}/groups/${cleanGroupId}/messages`,
      {
        group_id: cleanGroupId,
        epoch: envelope.epoch,
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
        write_sig: envelope.write_sig,
      },
    )
    return response.data
  }

  /**
   * Fetches ordered group messages with `server_seq > afterSeq` from the relay, authenticating
   * with `X-Frank-Group-Read-Token`.
   */
  async fetchGroupMessages(
    groupIdHex: string,
    readTokenHex: string,
    afterSeq = 0,
    limit = 100,
  ): Promise<FetchGroupMessagesResponse> {
    const cleanGroupId = normalizeGroupId(groupIdHex)
    const response = await this.http.get<FetchGroupMessagesResponse>(
      `${this.relayUrl}/groups/${cleanGroupId}/messages`,
      {
        params: {
          after_seq: afterSeq,
          limit,
        },
        headers: {
          'X-Frank-Group-Read-Token': readTokenHex.trim().toLowerCase(),
        },
      },
    )
    return response.data
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
export async function createGroupOnRelay(
  params: CreateGroupOnRelayParams,
): Promise<CreateGroupOnRelayResult> {
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
    if (!address || seenAddresses.has(address)) return
    seenAddresses.add(address)
    const index = rosterMembers.length
    const epochSigningPubKeyHex = bytesToHex(deriveIdentityMemberEpochPublicKey(
      hexToBytes(identityPubKeyHex), identity.groupIdHex, 0,
    ))
    rosterMembers.push({
      index,
      address,
      epochSigningPubKeyHex,
      identityPubKeyHex,
      role,
    })
  }

  addRosterMember(params.creatorAddress, 'admin', params.creatorIdentityPubKeyHex)
  for (const entry of params.members ?? []) {
    addRosterMember(entry.address, entry.role ?? 'member', entry.identityPubKeyHex)
  }

  const roster: GroupRoster = {
    epoch: 0,
    groupName: params.groupName.trim(),
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

  const published = await params.client.publishEpoch(
    identity.groupIdHex,
    epochFrame,
  )
  const epochHash =
    published.epoch_hash || epochFrame.epoch_hash || '00'.repeat(32)

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
 * Ratchets or rotates a group to `prevEpoch + 1`, re-deriving per-member epoch signing keys,
 * encrypting the updated `GroupRoster`, signing the new `GroupEpochFrame`, and publishing it
 * to the relay with `If-Match: prevEpochHashHex` Compare-And-Swap protection.
 */
export async function rotateGroupEpochOnRelay(
  params: RotateGroupEpochOnRelayParams,
): Promise<RotateGroupEpochOnRelayResult> {
  const cleanGroupId = normalizeGroupId(params.groupIdHex)
  const nextEpoch = params.prevEpoch + 1
  const nextEpochSecret =
    params.nextEpochSecret ??
    deriveNextEpochSecret(
      params.prevEpochSecret,
      cleanGroupId,
      nextEpoch,
      params.freshEntropy,
    )
  const epochKeys = deriveEpochKeys(nextEpochSecret, cleanGroupId, nextEpoch)

  const seenAddresses = new Set<string>()
  const rosterMembers: GroupRosterMember[] = []
  for (const entry of params.members) {
    const address = entry.address.trim().toLowerCase()
    if (!address || seenAddresses.has(address)) continue
    seenAddresses.add(address)
    const index = rosterMembers.length
    const role = entry.role ?? 'member'
    const identityPubKeyHex = entry.identityPubKeyHex
    const epochSigningPubKeyHex = bytesToHex(deriveIdentityMemberEpochPublicKey(
      hexToBytes(identityPubKeyHex), cleanGroupId, nextEpoch,
    ))
    rosterMembers.push({
      index,
      address,
      epochSigningPubKeyHex,
      identityPubKeyHex,
      role,
    })
  }

  const roster: GroupRoster = {
    epoch: nextEpoch,
    groupName: params.groupName.trim(),
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

  const published = await params.client.publishEpoch(
    cleanGroupId,
    epochFrame,
    params.prevEpochHashHex,
  )
  const epochHash =
    published.epoch_hash || epochFrame.epoch_hash || '00'.repeat(32)

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
export function groupEpochCertificate(frame: GroupEpochFrameWire): GroupEpochCertificate {
  if (!frame.group_pubkey || !frame.epoch_hash) throw new Error('Missing signed group epoch certificate')
  return {
    epoch: frame.epoch, group_pubkey: frame.group_pubkey,
    prev_epoch_hash: frame.prev_epoch_hash, write_pubkey: frame.write_pubkey,
    read_token_hash: frame.read_token_hash, encrypted_roster: frame.encrypted_roster,
    authority_sig: frame.authority_sig, epoch_hash: frame.epoch_hash,
  }
}

/** Only authenticated group metadata can become a local roster. */
export function openGroupEpochCertificate(params: {
  groupIdHex: string; groupPubKeyHex: string; epochSecretHex: string;
  certificate: GroupEpochCertificate; expectedPreviousHash?: string; expectedEpoch?: number;
}): { roster: GroupRoster; epochKeys: GroupEpochKeys } {
  const cert = params.certificate
  if (!verifyEpochFrame(cert, params.groupIdHex, params.groupPubKeyHex)) throw new Error('Invalid group epoch certificate')
  if (params.expectedPreviousHash !== undefined && cert.prev_epoch_hash !== params.expectedPreviousHash) throw new Error('Group epoch predecessor mismatch')
  if (params.expectedEpoch !== undefined && cert.epoch !== params.expectedEpoch) throw new Error('Group epoch sequence mismatch')
  const epochKeys = deriveEpochKeys(hexToBytes(params.epochSecretHex), params.groupIdHex, cert.epoch)
  if (cert.write_pubkey !== epochKeys.writeKeyPair.publicKeyHex || cert.read_token_hash !== epochKeys.readTokenHashHex) throw new Error('Group epoch secret does not match certificate')
  const roster = decryptGroupRoster(cert.encrypted_roster, epochKeys)
  if (!roster.members.length || roster.members.length > 256) throw new Error('Invalid group roster size')
  const addresses = new Set<string>(), indices = new Set<number>()
  for (const member of roster.members) {
    if (!Number.isInteger(member.index) || member.index < 0 || member.index > 255 || indices.has(member.index)) throw new Error('Invalid group member index')
    indices.add(member.index)
    const address = directoryAddress(member.identityPubKeyHex)
    if (member.address !== address || addresses.has(address)) throw new Error('Group member identity mismatch')
    addresses.add(address)
    const expected = bytesToHex(deriveIdentityMemberEpochPublicKey(hexToBytes(member.identityPubKeyHex), params.groupIdHex, cert.epoch))
    if (expected !== member.epochSigningPubKeyHex) throw new Error('Group member signing key mismatch')
  }
  if (roster.members.filter(member => member.role === 'admin').length !== 1) throw new Error('Group must have one founding administrator')
  return { roster, epochKeys }
}
