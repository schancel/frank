import {
  PublicKey,
  Transaction,
  Script,
  Address,
  PrivateKey,
} from 'bitcore-lib-xpi'
import { hmacSha256 } from '@frank/crypto-box'
import { cryptoBackend } from '@frank/nakamoto'
import assert from 'assert'
import atob from 'atob'

import __pb_relay_pb from './relay_pb'
const {
  Header,
  Message,
  PayloadEntry,
  Profile,
  ProfileEntry,
  Stamp,
  StampOutpoints,
} = __pb_relay_pb
import stealth from './stealth_pb'
import p2pkh from './p2pkh_pb'
// See cashweb/pop.ts's identical comment for why this is a default import (ticket #51, Vite
// migration) -- `PriceFilter` is only ever used as a type below (`new filters.PriceFilter()`
// covers the runtime usage), so `import type` is simplest.
import filters from './filters_pb'
import type { PriceFilter } from './filters_pb'
import { PayloadConstructor } from './crypto'
import VCard from 'vcf'
import __pb_signed_payload_payload_pb from '../signed_payload/payload_pb'
const { SignedPayload } = __pb_signed_payload_payload_pb
import { Wallet } from '../legacy-wallet'
import { signRegistryDigest } from '../registry'
import { relayCipherPayloadDigest } from './cipher-payload-digest'
import { relayPlainPayloadDigest } from './plain-payload-digest'
import { outpointPublicKey } from './outpoint-hd'
import { messageSourcePublicKey } from './message-source-pubkey'
import { relayProfilePublicKey } from './profile-pubkey'
import { stealthEphemeralPublicKey } from './stealth-ephemeral-pubkey'

/** One SHA-256 of Profile protobuf bytes. Matches `Sha256::digest` in
 * `SignedPayload::parse_proto`, the message `SignedPayload::verify` checks.
 * Not double-SHA256. cryptoBackend rejects Buffer. Relay encryption in this
 * file stays on bitcore (decision #505, issue #258). */
export function relayProfilePayloadDigest(payload: Uint8Array): Uint8Array {
  return cryptoBackend.sha256(Uint8Array.from(payload))
}

export class MessageConstructor {
  payloadConstructor: PayloadConstructor

  constructor({ networkName }: { networkName: string }) {
    assert(
      networkName,
      'Missing networkName while initializing MessageConstructor',
    )
    this.payloadConstructor = new PayloadConstructor({ networkName })
  }

  constructStampTransactions(
    wallet: Wallet,
    payloadDigest: Buffer,
    destPubKey: PublicKey,
    amount: number,
  ) {
    assert(payloadDigest instanceof Buffer, 'digestPayload is wrong type')

    // Stamp output. Public child only; the receive path still derives
    // the private key with bitcore (decision #513).
    const stampPublicKey = this.payloadConstructor.constructStampPublicKey(
      payloadDigest,
      destPubKey,
    )
    // Assuming one txn and one output for now.

    const stampAddressGenerator =
      (transactionNumber: number) => (outputNumber: number) => {
        const address = new PublicKey(
          Buffer.from(
            outpointPublicKey(
              stampPublicKey.toBuffer(),
              payloadDigest,
              transactionNumber,
              outputNumber,
            ),
          ),
        )
        transactionNumber += 1
        return address
      }
    if (!amount) {
      return []
    }

    // Construct transaction
    return wallet.constructTransactionSet({
      addressGenerator: stampAddressGenerator,
      amount,
    })
  }

  constructStealthTransactions(
    wallet: Wallet,
    ephemeralPrivKey: PrivateKey,
    destPubKey: PublicKey,
    amount: number,
  ) {
    // Add ephemeral output
    // NOTE: We're only doing 1 stealth txn, and 1 output for now.
    // But the spec should allow doing confidential amounts.
    const { stealthPublicKey, digest } =
      this.payloadConstructor.constructStealthPublicKey(
        ephemeralPrivKey,
        destPubKey,
      )

    const stealthPubKeyGenerator =
      (transactionNumber: number) => (outputNumber: number) => {
        const stealthAddress = new PublicKey(
          Buffer.from(
            outpointPublicKey(
              stealthPublicKey.toBuffer(),
              digest,
              transactionNumber,
              outputNumber,
            ),
          ),
        )

        transactionNumber += 1
        return stealthAddress
      }

    // Construct transaction
    return wallet.constructTransactionSet({
      addressGenerator: stealthPubKeyGenerator,
      amount,
    })
  }

  constructMessage(
    wallet: Wallet,
    plainTextPayload: Uint8Array,
    sourcePrivateKey: PrivateKey,
    destinationPublicKey: PublicKey,
    stampAmount: number,
  ) {
    const plainPayloadDigest = Buffer.from(
      relayPlainPayloadDigest(plainTextPayload),
    )

    // Construct salt
    const rawSourcePrivateKey = sourcePrivateKey.toBuffer()
    const salt = Buffer.from(
      hmacSha256(plainPayloadDigest, rawSourcePrivateKey),
    )

    // Construct shared key
    const sharedKey = this.payloadConstructor.constructSharedKey(
      sourcePrivateKey,
      destinationPublicKey,
      salt,
    )

    // Encrypt payload
    const payload = this.payloadConstructor.encrypt(sharedKey, plainTextPayload)

    // Calculate payload hmac
    const payloadDigest = Buffer.from(relayCipherPayloadDigest(payload))
    const payloadHmac = this.payloadConstructor.constructPayloadHmac(
      sharedKey,
      payloadDigest,
    )

    // Get transaction bundle from wallet
    try {
      const transactionBundle = this.constructStampTransactions(
        wallet,
        payloadDigest,
        destinationPublicKey,
        stampAmount,
      )

      // Construct Stamp
      const stamp = new Stamp()
      stamp.setStampType(1)

      for (const { transaction: stampTx, vouts } of transactionBundle) {
        const rawStampTx = stampTx.toBuffer()
        const stampOutpoints = new StampOutpoints()
        stampOutpoints.setStampTx(rawStampTx)
        vouts.forEach(vout => stampOutpoints.addVouts(vout))

        stamp.addStampOutpoints(stampOutpoints)
      }

      // Construct message. SEC1 point of the sender (decision #574).
      // types.d.ts omits the runtime compression flag; bitcore-lib-xpi
      // stays until #259. HMAC, salt, and envelope ECDH stay on bitcore.
      const message = new Message()
      const compressed = (sourcePrivateKey as unknown as { compressed?: boolean })
        .compressed
      if (compressed !== true && compressed !== false) {
        throw new Error('message-source-pubkey:compressed')
      }
      const rawSourcePublickey = Buffer.from(
        messageSourcePublicKey(
          Uint8Array.from(sourcePrivateKey.toBuffer()),
          compressed,
        ),
      )
      const rawDestinationPublicKey = destinationPublicKey.toBuffer()
      message.setScheme(1)
      message.setDestinationPublicKey(rawDestinationPublicKey)
      message.setSourcePublicKey(rawSourcePublickey)
      message.setPayload(payload)
      message.setPayloadHmac(payloadHmac)
      message.setSalt(salt)
      message.setStamp(stamp)
      return { message, transactionBundle, payloadDigest }
    } catch (err: unknown) {
      console.error(err)
      throw Object({
        payloadDigest,
        err,
      })
    }
  }

  constructReplyEntry({ payloadDigest }: { payloadDigest: string }) {
    assert(typeof payloadDigest === 'string', 'digestPayload is wrong type')
    const payloadDigestBuffer = Buffer.from(payloadDigest, 'hex')

    const entry = new PayloadEntry()
    entry.setKind('reply')
    entry.setBody(payloadDigestBuffer)
    return entry
  }

  constructTextEntry({ text }: { text: string }) {
    // Add text entry
    const textEntry = new PayloadEntry()
    textEntry.setKind('text-utf8')
    const rawText = new TextEncoder().encode(text)
    textEntry.setBody(rawText)
    return textEntry
  }

  constructStealthEntry({
    wallet,
    amount,
    destPubKey,
  }: {
    wallet: Wallet
    amount: number
    destPubKey: PublicKey
  }) {
    // Construct payment entry
    const paymentEntry = new PayloadEntry()
    paymentEntry.setKind('stealth-payment')

    const stealthPaymentEntry = new stealth.StealthPaymentEntry()
    const ephemeralPrivKey = new PrivateKey()

    const transactionBundle = this.constructStealthTransactions(
      wallet,
      ephemeralPrivKey,
      destPubKey,
      amount,
    )

    // Sent to HASH160(ephemeralPrivKey * destPubKey)
    // Sent to HASH160(ephemeralPrivKey * destPubKey)
    // Ephemeral SEC1 point (decision #576). types.d.ts omits the runtime
    // compression flag; bitcore-lib-xpi stays until #259. HMAC, salt,
    // the plaintext digest, and envelope ECDH stay on bitcore.
    const compressed = (ephemeralPrivKey as unknown as { compressed?: boolean })
      .compressed
    if (compressed !== true && compressed !== false) {
      throw new Error('stealth-ephemeral-pubkey:compressed')
    }
    stealthPaymentEntry.setEphemeralPubKey(
      Buffer.from(
        stealthEphemeralPublicKey(
          Uint8Array.from(ephemeralPrivKey.toBuffer()),
          compressed,
        ),
      ),
    )
    for (const { transaction: stealthTx, vouts } of transactionBundle) {
      const rawStealthTx = stealthTx.toBuffer()
      const stealthOutpoints = new stealth.StealthOutpoints()

      stealthOutpoints.setStealthTx(rawStealthTx)
      vouts.forEach(vout => stealthOutpoints.addVouts(vout))
      stealthPaymentEntry.addOutpoints(stealthOutpoints)
    }

    const paymentEntryRaw = stealthPaymentEntry.serializeBinary()
    paymentEntry.setBody(paymentEntryRaw)

    return { paymentEntry, transactionBundle }
  }

  constructImageEntry({ image }: { image: string }) {
    // Construct text entry
    const imgEntry = new PayloadEntry()
    imgEntry.setKind('image')

    const arr = image.split(',')
    assert(arr.length > 0, 'image string is invalid.')
    const matches = arr[0].match(/:(.*?);/)
    assert(matches && matches.length > 1, 'matches is the wrong length')
    const avatarType = matches[1]
    const bstr = atob(arr[1])
    let n = bstr.length
    const rawAvatar = new Uint8Array(n)

    while (n--) {
      rawAvatar[n] = bstr.charCodeAt(n)
    }
    const imgHeader = new Header()
    imgHeader.setName('data')
    imgHeader.setValue(avatarType)
    imgEntry.setBody(rawAvatar)
    imgEntry.addHeaders(imgHeader)

    return imgEntry
  }

  constructP2PKHEntry({
    address,
    amount,
    wallet,
  }: {
    address: string
    amount: number
    wallet: Wallet
  }) {
    const p2pkhEntry = new p2pkh.P2PKHEntry()

    const output = new Transaction.Output({
      script: new Script(new Address(address)),
      satoshis: amount,
    })

    const { transaction, usedUtxos } = wallet.constructTransaction({
      outputs: [output],
    })
    const rawTransaction = transaction.toBuffer()

    p2pkhEntry.setTransaction(rawTransaction)

    const p2pkhEntryRaw = p2pkhEntry.serializeBinary()
    const payloadEntry = new PayloadEntry()
    payloadEntry.setKind('p2pkh')
    payloadEntry.setBody(p2pkhEntryRaw)

    return { entry: payloadEntry, transaction, usedUtxos }
  }

  constructPriceFilter(
    isPublic: boolean,
    acceptancePrice: number,
    notificationPrice: number,
  ) {
    // Construct PriceFilter
    const priceFilter = new filters.PriceFilter()
    priceFilter.setPublic(isPublic)
    priceFilter.setAcceptancePrice(acceptancePrice)
    priceFilter.setNotificationPrice(notificationPrice)

    return priceFilter
  }

  constructProfileMetadata(
    profileObj: { name?: string; bio?: string; avatar?: string },
    priceFilter: PriceFilter,
    privKey: PrivateKey,
  ) {
    // Construct vCard
    const vCard = new VCard()
    if (profileObj.name) {
      vCard.set('fn', profileObj.name)
    }
    if (profileObj.bio) {
      vCard.set('note', profileObj.bio)
    }
    const rawCard = new TextEncoder().encode(vCard.toString())

    const cardEntry = new ProfileEntry()
    cardEntry.setKind('vcard')
    cardEntry.setBody(rawCard)

    // Construct avatar
    const imgEntry = new ProfileEntry()
    imgEntry.setKind('avatar')

    if (profileObj.avatar) {
      const arr = profileObj.avatar.split(',')
      assert(arr.length > 0, 'image string is invalid.')
      const matches = arr[0].match(/:(.*?);/)
      assert(matches && matches.length > 1, 'matches is the wrong length')
      const avatarType = matches[1]
      const bstr = atob(arr[1])
      let n = bstr.length
      const rawAvatar = new Uint8Array(n)

      while (n--) {
        rawAvatar[n] = bstr.charCodeAt(n)
      }
      const imgHeader = new Header()
      imgHeader.setName('data')
      imgHeader.setValue(avatarType)
      imgEntry.setBody(rawAvatar)
      imgEntry.addHeaders(imgHeader)
    }

    // Construct price filter
    const filterEntry = new ProfileEntry()
    filterEntry.setKind('price-filter')
    const rawPriceFilter = priceFilter.serializeBinary()
    filterEntry.setBody(rawPriceFilter)

    // Construct payload
    const profile = new Profile()
    profile.setTimestamp(Math.floor(Date.now() / 1000))
    profile.setTtl(31556952) // 1 year
    profile.addEntries(cardEntry)
    profile.addEntries(imgEntry)
    profile.addEntries(filterEntry)

    const rawProfile = profile.serializeBinary()
    const hashbuf = Buffer.from(relayProfilePayloadDigest(rawProfile))
    const rawSig = signRegistryDigest(hashbuf, privKey)

    // SEC1 point of the signing key (decision #543). types.d.ts omits the
    // runtime compression flag; bitcore-lib-xpi stays until #259.
    const compressed = (privKey as unknown as { compressed?: boolean }).compressed
    if (compressed !== true && compressed !== false) {
      throw new Error('profile-pubkey:compressed')
    }
    const signedPayload = new SignedPayload()
    signedPayload.setPublicKey(
      Buffer.from(
        relayProfilePublicKey(Uint8Array.from(privKey.toBuffer()), compressed),
      ),
    )
    signedPayload.setSignature(rawSig)
    signedPayload.setScheme(1)
    signedPayload.setPayload(rawProfile)

    return signedPayload
  }
}
