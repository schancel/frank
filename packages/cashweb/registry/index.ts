import axios from 'axios'
import assert from 'assert'

import __pb_metadata_pb from './metadata_pb'
const { Entry, AddressMetadata } = __pb_metadata_pb
import __pb_signed_payload_payload_pb from '../signed_payload/payload_pb'
const { SignedPayload, SignedPayloadSet, BurnOutputs } =
  __pb_signed_payload_payload_pb
import pop from '../pop'
import { pondBurnOutputSatoshis } from './burn-script'
import { registryBroadcastDigest } from './broadcast-digest'
import { registryWrapperDigest } from './wrapper-digest'
import { registryBurnOutput } from './burn-output'
import { registryIdentityPublicKey } from './identity-pubkey'
import { cryptoBackend, signingKey } from '@frank/nakamoto'
import { pointFromPublicKey } from '../../nakamoto/src/secp256k1'
import { Wallet } from '../legacy-wallet'
import { Utxo } from '../types/utxo'
import { calcUtxoId } from '../legacy-wallet/helpers'
import {
  lotusFromAddress,
  lotusFromPrivateKey,
  lotusFromPublicKey,
} from '../legacy-wallet/lotus-address'
import __pb_broadcast_pb from './broadcast_pb'
const { BroadcastEntry, BroadcastMessage, ForumPost } = __pb_broadcast_pb
import { ForumMessage, ForumMessageEntry } from '../types/forum'

/** Canonical DER integer as a minimal big-endian magnitude. */
function readDerInt(
  der: Uint8Array,
  offset: number,
): { value: Buffer; next: number } {
  if (der[offset] !== 0x02) throw new Error('signature-invalid')
  const length = der[offset + 1]
  if (length === undefined || length < 1 || offset + 2 + length > der.length) {
    throw new Error('signature-invalid')
  }
  let magnitude = der.subarray(offset + 2, offset + 2 + length)
  if (magnitude[0] === 0x00) {
    if (magnitude.length === 1 || (magnitude[1] & 0x80) === 0) {
      throw new Error('signature-invalid')
    }
    magnitude = magnitude.subarray(1)
  } else if ((magnitude[0] & 0x80) !== 0) {
    throw new Error('signature-invalid')
  }
  if (magnitude.length < 1 || magnitude.length > 32) {
    throw new Error('signature-invalid')
  }
  return { value: Buffer.from(magnitude), next: offset + 2 + length }
}

/**
 * r||s with the compact header removed. r is minimal. s is 32 bytes.
 * `fromDER` returns a string when the DER is 64 bytes and starts with 0x30,
 * so r and s are read here. The replaced compact slice calls `toBuffer({size:32})`:
 * r is an elliptic BN and ignores size, s is a bitcore BN and left-pads.
 */
export function compactRsFromDer(der: Uint8Array): Buffer {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) {
    throw new Error('signature-invalid')
  }
  const r = readDerInt(der, 2)
  const s = readDerInt(der, r.next)
  if (s.next !== der.length) throw new Error('signature-invalid')
  const sFixed = Buffer.alloc(32)
  s.value.copy(sFixed, 32 - s.value.length)
  return Buffer.concat([r.value, sFixed])
}

/** Callers still pass bitcore PrivateKey. types.d.ts omits `compressed`. */
type RegistryPrivateKey = {
  toBuffer(): Uint8Array
  compressed?: boolean
}

/** Compact r||s over a 32-byte digest. A bad digest throws and returns nothing. */
export function signRegistryDigest(
  hash: Buffer,
  privKey: RegistryPrivateKey,
): Buffer {
  if (hash.length !== 32) throw new Error('sign-digest')
  const signing = signingKey('secret', privKey)
  if (!signing.ok) throw new Error(signing.error.code)
  return compactRsFromDer(signing.value.sign(Uint8Array.from(hash)))
}

/** One SHA-256 of AddressMetadata protobuf bytes. Matches `Sha256::digest`
 * in `SignedPayload::parse_proto` and the registry HTTP test that hashes
 * `AddressMetadata::encode_to_vec`. Not double-SHA256. createBroadcast uses
 * registryBroadcastDigest (decision #598). parseWrapper hashes with
 * registryWrapperDigest and emits a Lotus address. The burn script is
 * decision #519. Burn output
 * amounts are decision #521.
 * cryptoBackend rejects Buffer. */
export function registryAddressMetadataDigest(payload: Uint8Array): Uint8Array {
  return cryptoBackend.sha256(Uint8Array.from(payload))
}

/** SEC1 point of a registry identity key (decision #578). */
function registryIdentityPoint(privKey: RegistryPrivateKey): Buffer {
  const compressed = privKey.compressed
  if (compressed !== true && compressed !== false) {
    throw new Error('registry-identity-pubkey:compressed')
  }
  return Buffer.from(
    registryIdentityPublicKey(Uint8Array.from(privKey.toBuffer()), compressed),
  )
}

function calculateBurnAmount(burnOutputs: BurnOutputs[]) {
  return burnOutputs.reduce((total, burn) => {
    const index = burn.getIndex()
    const tx = burn.getTx()
    assert(
      typeof tx !== 'string',
      'Tx returned as string from protobuf library',
    )
    // Value and script bytes, not a bitcore Transaction (decision #521).
    return total + pondBurnOutputSatoshis(Uint8Array.from(tx), index)
  }, 0)
}

export class RegistryHandler {
  registrys: string[]
  networkName: string
  defaultSampleSize: number
  wallet?: Wallet

  constructor({
    wallet,
    defaultSampleSize = 3,
    registrys,
    networkName,
  }: {
    wallet?: Wallet
    defaultSampleSize?: number
    registrys: string[]
    networkName: string
  }) {
    assert(
      networkName,
      'Missing networkName while initializing RegistryHandler',
    )
    assert(registrys, 'Missing registrys while initializing RegistryHandler')
    this.registrys = registrys
    this.networkName = networkName
    this.defaultSampleSize = defaultSampleSize
    this.wallet = wallet
  }

  toAPIAddressString(address: string) {
    return lotusFromAddress(address, this.networkName)
  }

  constructRelayUrlMetadata(relayUrl: string, privKey: RegistryPrivateKey) {
    const relayUrlEntry = new Entry()
    relayUrlEntry.setKind('relay-server')
    const rawRelayUrl = new TextEncoder().encode(relayUrl)
    relayUrlEntry.setBody(rawRelayUrl)

    // Construct payload
    const metadata = new AddressMetadata()
    metadata.setTimestamp(Math.floor(Date.now() / 1000))
    metadata.setTtl(31556952) // 1 year
    metadata.addEntries(relayUrlEntry)

    const serializedPayload = metadata.serializeBinary()
    const hashbuf = Buffer.from(
      registryAddressMetadataDigest(serializedPayload),
    )
    const sig = signRegistryDigest(hashbuf, privKey)

    const signedPayload = new SignedPayload()
    signedPayload.setPublicKey(registryIdentityPoint(privKey))
    signedPayload.setSignature(sig)
    signedPayload.setScheme(1)
    signedPayload.setPayload(serializedPayload)

    return signedPayload
  }

  async fetchMetadata(registry: string, address: string) {
    const legacyAddress = this.toAPIAddressString(address)
    const url = `${registry}/keys/${legacyAddress}`
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'arraybuffer',
    })
    if (response.status === 200) {
      const metadata = SignedPayload.deserializeBinary(response.data)
      return metadata
    }
  }

  chooseServer() {
    // TODO: Sample correctly
    return this.registrys[0]
  }

  async paymentRequest(
    serverUrl: string,
    address: string,
    truncatedSignedPayload: SignedPayload,
  ) {
    const legacyAddress = this.toAPIAddressString(address)
    const rawSignedPayload = truncatedSignedPayload.serializeBinary()
    const url = `${serverUrl}/keys/${legacyAddress}`
    return pop.getPaymentRequest(url, 'put', rawSignedPayload)
  }

  async _uniformSample(address: string) {
    // TODO: Sample correctly
    const server = this.chooseServer()
    return this.fetchMetadata(server, address)
  }

  async getRelayUrl(address: string) {
    const legacyAddress = this.toAPIAddressString(address)

    // Get metadata
    const metadata = await this._uniformSample(legacyAddress)
    assert(metadata, 'Missing metadata from registry')
    const rawAddressMetadata = metadata.getPayload()
    assert(
      typeof rawAddressMetadata !== 'string',
      'rawAddressMetadata is a string?',
    )
    const payload = AddressMetadata.deserializeBinary(rawAddressMetadata)

    // Find vCard
    function isRelay(entry: Entry) {
      return entry.getKind() === 'relay-server'
    }
    const entryList = payload.getEntriesList()
    const entry = entryList.find(isRelay)
    if (!entry) {
      return null
    }
    const entryData = entry.getBody()
    assert(typeof entryData !== 'string', 'entryData is a string')
    const relayUrl = new TextDecoder().decode(entryData)
    return relayUrl
  }

  async putMetadata(
    address: string,
    server: string,
    metadata: SignedPayload,
    token: string,
  ) {
    const rawMetadata = metadata.serializeBinary()
    const url = `${server}/keys/${address}`
    await axios({
      method: 'put',
      url: url,
      headers: {
        Authorization: token,
      },
      data: rawMetadata,
    })
  }

  async updateKeyMetadata(relayUrl: string, idPrivKey: RegistryPrivateKey) {
    assert(this.wallet, 'Missing wallet while running updateKeyMetadata')
    // Bitcore keys still expose toPublicKey. The parameter type does not.
    const idAddress = lotusFromPrivateKey(
      idPrivKey as RegistryPrivateKey & {
        toPublicKey(): { toBuffer(): Uint8Array }
      },
      this.networkName,
    )
    // Construct metadata
    const signedPayload = this.constructRelayUrlMetadata(relayUrl, idPrivKey)

    const serverUrl = this.chooseServer()
    const payloadRaw = signedPayload.getPayload()
    if (typeof payloadRaw === 'string') {
      throw new Error('payloadRaw is a string?')
    }
    const payloadDigest = registryAddressMetadataDigest(payloadRaw)
    const truncatedSignedPayload = new SignedPayload()
    const publicKey = signedPayload.getPublicKey()
    assert(typeof publicKey !== 'string', 'publicKey is a string?')

    truncatedSignedPayload.setPublicKey(publicKey)
    truncatedSignedPayload.setPayloadDigest(payloadDigest)

    const { paymentDetails } = (await this.paymentRequest(
      serverUrl,
      idAddress,
      truncatedSignedPayload,
    )) ?? { paymentDetails: undefined }
    assert(paymentDetails, 'Missing payment details')
    // Construct payment
    const { paymentUrl, payment, usedUtxos } =
      await pop.constructPaymentTransaction(this.wallet, paymentDetails)

    const paymentUrlFull = new URL(paymentUrl, serverUrl)
    try {
      const { token } = await pop.sendPayment(paymentUrlFull.href, payment)
      await Promise.all(
        usedUtxos.map((id: Utxo) =>
          this.wallet?.storage.deleteById(calcUtxoId(id)),
        ),
      )

      await this.putMetadata(idAddress, serverUrl, signedPayload, token)
    } catch (err) {
      this.wallet.fixUtxos(usedUtxos)
      throw err
    }
  }

  private constructBurnTransaction(wallet: Wallet, hash: Buffer, vote: number) {
    // Script bytes stay pondBurnScript (decision #519). The record is
    // paymentOutput (decision #596), not Transaction.Output.
    return wallet.constructTransaction({
      outputs: [registryBurnOutput(Uint8Array.from(hash), vote)],
    })
  }

  /**
   * @deprecated Legacy protobuf topic broadcast endpoint (/message) is deprecated and dead.
   * Canonical CBOR topic endpoints (/message/monad/topics) are the active routes.
   */
  async createBroadcast(
    topic: string,
    entries: ForumMessageEntry[],
    vote: number,
    parentDigest?: string,
  ) {
    assert(this.wallet, 'Missing wallet while running updateKeyMetadata')

    const broadcastMessage = new BroadcastMessage()
    broadcastMessage.setTopic(topic)
    broadcastMessage.setTimestamp(Date.now())
    parentDigest &&
      broadcastMessage.setParentDigest(Buffer.from(parentDigest, 'hex'))

    // Construct payload
    const protoEntries: BroadcastEntry[] = []
    for (const entry of entries) {
      const textEntry = new BroadcastEntry()
      textEntry.setKind(entry.kind)
      if (entry.kind === 'post') {
        const payload = new ForumPost()
        entry.title && payload.setTitle(entry.title)
        entry.url && payload.setUrl(entry.url)
        entry.message && payload.setMessage(entry.message)
        textEntry.setPayload(payload.serializeBinary())
        protoEntries.push(textEntry)
        continue
      }
      assert(false, 'unsupported entry type')
    }
    broadcastMessage.setEntriesList(protoEntries)

    const serializedMessage = broadcastMessage.serializeBinary()
    const payloadDigest = Buffer.from(
      registryBroadcastDigest(serializedMessage),
    )
    const { transaction: burnTransaction, usedUtxos } =
      this.constructBurnTransaction(this.wallet, payloadDigest, vote)

    const burnOutput = new BurnOutputs()
    burnOutput.setTx(burnTransaction.toBuffer())
    burnOutput.setIndex(0)

    const idPrivKey = this.wallet?.identityPrivKey
    assert(idPrivKey, 'Missing private key in createBroadcast')
    const idPubKey = registryIdentityPoint(idPrivKey)

    const sig = signRegistryDigest(payloadDigest, idPrivKey)

    const signedPayload = new SignedPayload()
    signedPayload.setPublicKey(idPubKey)
    signedPayload.setSignature(sig)

    signedPayload.setPublicKey(idPubKey)
    signedPayload.setPayload(serializedMessage)
    signedPayload.setBurnAmount(vote)
    signedPayload.setScheme(SignedPayload.SignatureScheme.ECDSA)
    signedPayload.setTransactionsList([burnOutput])
    const server = this.chooseServer()

    try {
      const url = `${server}/messages`
      await axios({
        method: 'put',
        url: url,
        data: signedPayload.serializeBinary(),
      })
      await Promise.all(
        usedUtxos.map((id: Utxo) =>
          this.wallet?.storage.deleteById(calcUtxoId(id)),
        ),
      )
    } catch (err) {
      await this.wallet?.fixUtxos(usedUtxos)
      throw err
    }
    return payloadDigest.toString('hex')
  }

  /**
   * @deprecated Legacy protobuf topic offering endpoint (/messages) is deprecated and dead.
   * Canonical CBOR topic endpoints (/message/monad/topics) are the active routes.
   */
  async addOfferings(payloadDigest: string, vote: number) {
    // Topic should not be required, but it is a sanity check on the backend to
    // make sure the vote and the post have the same information.
    assert(this.wallet, 'Missing wallet while running updateKeyMetadata')

    const payloadDigestBinary = Buffer.from(payloadDigest, 'hex')
    const { transaction: burnTransaction, usedUtxos } =
      this.constructBurnTransaction(this.wallet, payloadDigestBinary, vote)

    const burnOutput = new BurnOutputs()
    burnOutput.setTx(burnTransaction.toBuffer())
    burnOutput.setIndex(0)

    const idPrivKey = this.wallet?.identityPrivKey
    assert(idPrivKey, 'Missing private key in createBroadcast')
    const idPubKey = registryIdentityPoint(idPrivKey)

    const sig = signRegistryDigest(payloadDigestBinary, idPrivKey)

    const signedPayload = new SignedPayload()
    signedPayload.setPublicKey(idPubKey)
    signedPayload.setSignature(sig)

    signedPayload.setPublicKey(idPubKey)
    signedPayload.setPayloadDigest(payloadDigestBinary)
    signedPayload.setBurnAmount(vote)
    signedPayload.setScheme(SignedPayload.SignatureScheme.ECDSA)
    signedPayload.setTransactionsList([burnOutput])
    const server = this.chooseServer()
    const url = `${server}/messages`
    await axios({
      method: 'put',
      url: url,
      data: signedPayload.serializeBinary(),
    })
    await Promise.all(
      usedUtxos.map((id: Utxo) =>
        this.wallet?.storage.deleteById(calcUtxoId(id)),
      ),
    )
  }

  parseWrapper(wrapper: SignedPayload) {
    const payload = wrapper.getPayload()
    assert(typeof payload !== 'string', 'payload type should not be a string')
    const message = BroadcastMessage.deserializeBinary(payload)
    const pubKey = Buffer.from(wrapper.getPublicKey())
    const pointBytes = Uint8Array.from(pubKey)
    if (pointFromPublicKey(pointBytes) === null) {
      throw new Error('registry-public-key')
    }
    const address = lotusFromPublicKey(
      { toBuffer: () => pointBytes },
      this.networkName,
    )
    const entries = message.getEntriesList()
    const parsedEntries: ForumMessageEntry[] = []
    const satoshisBurned = calculateBurnAmount(wrapper.getTransactionsList())
    assert(satoshisBurned === wrapper.getBurnAmount())
    const payloadDigest = Buffer.from(registryWrapperDigest(payload)).toString(
      'hex',
    )
    const parentDigestBinary = message.getParentDigest()
    assert(
      typeof parentDigestBinary !== 'string' || parentDigestBinary.length === 0,
      'post.getParentDigest() returned a string incorrectly',
    )
    const timestamp = message.getTimestamp()
    const parsedMessage: ForumMessage = {
      poster: address,
      satoshis: satoshisBurned,
      topic: message.getTopic(),
      entries: parsedEntries,
      payloadDigest,
      parentDigest: Buffer.from(parentDigestBinary).toString('hex'),
      timestamp: new Date(timestamp),
    }
    for (const entry of entries) {
      const kind = entry.getKind()
      const payload = entry.getPayload()
      if (typeof payload === 'string') {
        console.error('invalid payload type returned from protobufs')
        continue
      }

      if (kind === 'post') {
        const post = ForumPost.deserializeBinary(payload)
        parsedEntries.push({
          kind: 'post',
          title: post.getTitle(),
          url: post.getUrl(),
          message: post.getMessage(),
        })
        continue
      }
    }
    return parsedMessage
  }

  /**
   * @deprecated Legacy protobuf topic read endpoint (/messages) is deprecated and dead.
   * Canonical CBOR topic endpoints (/message/monad/topics) are the active routes.
   */
  async getBroadcastMessages(topic: string, from?: number, to?: number) {
    const server = this.chooseServer()
    const url = `${server}/messages`
    const response = await axios({
      method: 'get',
      url: url,
      params: {
        // Defaults to 1 day
        from: from ?? Date.now() - 1000 * 60 * 60 * 24,
        to: to ?? Date.now(),
        topic,
      },
      responseType: 'arraybuffer',
    })
    if (response.status !== 200) {
      return
    }
    if (response.status !== 200) {
      throw new Error('unable to fetch broadcast messages')
    }
    const signedpayloadSet = SignedPayloadSet.deserializeBinary(response.data)
    const wrappers = signedpayloadSet.getItemsList()
    const messages: ForumMessage[] = []
    for (const wrapper of wrappers) {
      const message = this.parseWrapper(wrapper)
      messages.push(message)
    }
    return messages
  }

  /**
   * @deprecated Legacy protobuf topic single-message endpoint (/messages/:payloadDigest) is deprecated and dead.
   * Canonical CBOR topic endpoints (/message/monad/topics) are the active routes.
   */
  async getBroadcastMessage(payloadDigest: string) {
    const server = this.chooseServer()
    const url = `${server}/messages/${payloadDigest}`
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'arraybuffer',
    })
    if (response.status !== 200) {
      return
    }
    if (response.status !== 200) {
      throw new Error('unable to fetch broadcast messages')
    }
    const signedPayload = SignedPayload.deserializeBinary(response.data)
    const message = this.parseWrapper(signedPayload)
    return message
  }
}
