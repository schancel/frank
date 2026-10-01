import assert from 'assert'
import type { ReplyItem, StealthItem, ImageItem } from '../types/messages'
import type { PayloadEntry } from './relay_pb'
import { entryToImage } from './images'
import stealth from './stealth_pb'
import { TextItem, MessageItem } from '../types/messages'
import {
  Networks,
  PrivateKey,
  PublicKey,
  Script,
} from 'bitcore-lib-xpi'
import { Wallet } from '../legacy-wallet'
import { calcUtxoId } from '../legacy-wallet/helpers'
import { Utxo } from '../types/utxo'
import { outpointPrivateKey } from './outpoint-hd'
import { stealthOutpointPublicKey } from './stealth-outpoint-pub'
import { stealthParentSecret } from './stealth-parent'
import { readStealthTransaction } from './stealth-tx'

export async function decodeEntry(
  entry: PayloadEntry,
  outbound: boolean,
  {
    networkName,
    wallet,
    destinationPrivateKey,
  }: {
    networkName: string
    wallet: Wallet
    destinationPrivateKey: PrivateKey
  },
): Promise<[MessageItem, Utxo[]] | null> {
  // If address data doesn't exist then add it
  const kind = entry.getKind()
  const outpoints: Utxo[] = []

  if (kind === 'reply') {
    const entryData = entry.getBody()
    const payloadDigest = Buffer.from(entryData).toString('hex')
    return [
      {
        type: 'reply',
        payloadDigest,
      } as ReplyItem,
      outpoints,
    ]
  }

  if (kind === 'text-utf8') {
    const entryData = entry.getBody()
    if (typeof entryData === 'string') {
      return [
        {
          type: 'text',
          text: entryData,
        } as TextItem,
        outpoints,
      ]
    }
    assert(
      typeof entryData !== 'string',
      `text entry data was a string ${entryData}`,
    )
    const text = new TextDecoder().decode(entryData)
    return [
      {
        type: 'text',
        text,
      } as TextItem,
      outpoints,
    ]
  }

  if (kind === 'stealth-payment') {
    const entryData = entry.getBody()
    assert(
      typeof entryData !== 'string',
      'entryData should not have string type',
    )
    const stealthMessage =
      stealth.StealthPaymentEntry.deserializeBinary(entryData)

    // Add stealth outputs
    const outpointsList = stealthMessage.getOutpointsList()
    const ephemeralPubKeyRaw = stealthMessage.getEphemeralPubKey()
    const ephemeralPubKey = PublicKey.fromBuffer(
      Buffer.from(ephemeralPubKeyRaw),
    )
    // Parent is stealthParentSecret (decision #559). Chain code is the raw
    // SHA-256 digest, not the reduced scalar. The caller's PrivateKey is
    // not wiped. Address strings stay on bitcore (issue #242).
    const derived = stealthParentSecret(
      Uint8Array.from(destinationPrivateKey.toBuffer()),
      Uint8Array.from(ephemeralPubKey.toBuffer()),
    )
    const stealthSecret = derived.secret
    const stealthChain = derived.digest

    let stealthValue = 0
    for (const [i, outpoint] of outpointsList.entries()) {
      const stealthTxRaw = Buffer.from(outpoint.getStealthTx())
      // Segmented id and output amounts, not a bitcore Transaction (decision #529).
      const stealthTx = readStealthTransaction(stealthTxRaw)
      const txId = stealthTx.txId
      const vouts = outpoint.getVoutsList()

      if (outbound) {
        for (const input of stealthTx.inputs) {
          // Don't add these outputs to our wallet. They're the other persons
          const utxoId = calcUtxoId({
            txId: input.txId,
            outputIndex: input.outputIndex,
          })
          await wallet.deleteUtxo(utxoId)
        }
      }

      for (const [j, outputIndex] of vouts.entries()) {
        const output = stealthTx.outputs[outputIndex]
        if (output === undefined) throw new Error('stealth-output')
        const satoshis = output.satoshis

        // Non-hardened m/44/145 private child (decision #531).
        const outpointSecret = outpointPrivateKey(
          stealthSecret,
          stealthChain,
          i,
          j,
        )
        const outpointPrivKey = new PrivateKey(
          Buffer.from(outpointSecret).toString('hex'),
          Networks.get(networkName),
        )
        // Address strings stay on bitcore (issue #242).
        const address = new Script(Buffer.from(output.script)).toAddress(
          networkName,
        )
        // Compressed point of the outpoint secret (decision #555). Address
        // strings stay on bitcore (issue #242).
        const computedAddress = new PublicKey(
          Buffer.from(stealthOutpointPublicKey(outpointSecret)),
        ).toAddress(networkName)
        if (
          !outbound &&
          !address.toBuffer().equals(computedAddress.toBuffer())
        ) {
          console.error('invalid stealth address, ignoring')
          return null
        }
        // total up the satoshis only if we know the txn was valid
        stealthValue += satoshis

        const stampOutput = {
          type: 'stealth',
          address: address.toCashAddress(),
          satoshis,
          outputIndex,
          txId,
        } as Utxo
        outpoints.push(stampOutput)
        if (outbound) {
          // Don't add these outputs to our wallet. They're the other persons
          continue
        }
        wallet.putUtxo({
          ...stampOutput,
          privKey: Object.freeze(outpointPrivKey),
        })
      }
    }
    return [
      {
        type: 'stealth',
        amount: stealthValue,
      } as StealthItem,
      outpoints,
    ]
  }

  if (kind === 'image') {
    const image = entryToImage(entry)
    return [
      {
        type: 'image',
        image,
      } as ImageItem,
      outpoints,
    ]
  }

  console.error('Unknown entry Kind', kind)
  return null
}
