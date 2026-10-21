/** Source generator for docs/protocol/cbor/vectors/stealth-assets.json. */
import {
  cborMap,
  decodeCanonical,
  encodeFrame,
  encodeStealthAssetMessageItem,
  encodeStealthMessageItem,
  fromHex,
  parseFrame,
  toHex,
} from '../src'
import type { Encodable, CanonicalStealthAssetMessageItem } from '../src'
import {
  FRANK_ENVELOPE,
  PAYMENT_TRANSFER,
  STEALTH_ASSET_MESSAGE_ITEM,
  STEALTH_ASSET_TRANSFER,
  TYPE_STEALTH_MESSAGE_ITEM,
} from '../src/constants'

const recipient = fromHex(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
)
const ephemeral = fromHex(
  '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
)

function sample(): CanonicalStealthAssetMessageItem['transfers'][number] {
  return {
    transfer: {
      networkTag: 'monad-testnet',
      txId: 'ab'.repeat(32),
      destination: 'cd'.repeat(20),
      value: 2n ** 200n + 7n,
      token: 'ef'.repeat(20),
      stealthMetadata: { keyType: 1, ephemeralPubKey: ephemeral },
      rawTx: '010203',
    },
    derivationScheme: 1,
    recipientSpendKey: { keyType: 1, keyBytes: recipient },
  }
}

function malformed(
  change: (entry: Map<bigint, Encodable>) => void,
): Uint8Array {
  const good = encodeStealthAssetMessageItem({ transfers: [sample()] })
  const envelope = decodeCanonical(good.subarray(9)) as Map<bigint, Encodable>
  const payload = decodeCanonical(
    envelope.get(BigInt(FRANK_ENVELOPE.payload)) as Uint8Array,
  ) as Map<bigint, Encodable>
  const entry = (
    payload.get(BigInt(STEALTH_ASSET_MESSAGE_ITEM.transfers)) as Map<
      bigint,
      Encodable
    >[]
  )[0]
  change(entry)
  return encodeFrame(
    {
      typeId: TYPE_STEALTH_MESSAGE_ITEM,
      schemaVersion: 2,
      minReaderVersion: 2,
    },
    payload,
  )
}

/** Structural vectors only: the raw transaction bytes are not financial receipt proof. */
export function stealthAssetCorpus() {
  const token = sample()
  const native = sample()
  delete native.transfer.token
  native.transfer.networkTag = 'btc-testnet'
  native.transfer.value = 18446744073709551615n
  native.transfer.vout = 4294967295
  const unknown = sample()
  unknown.derivationScheme = 2 // Unallocated; retained, never a supported signing capability.
  unknown.tokenProgram = new Uint8Array(32).fill(4)
  // raw-cbor-key: opaque derivation-context bytes, not a map entry
  unknown.derivationContext = new Uint8Array([1, 2, 3])
  const cases = [
    {
      id: 'native-uint64-max',
      bytes: encodeStealthAssetMessageItem({ transfers: [native] }),
    },
    {
      id: 'token-uint256-exact',
      bytes: encodeStealthAssetMessageItem({
        transfers: [token],
        memo: 'payment',
      }),
    },
    {
      id: 'unknown-scheme-preserved',
      bytes: encodeStealthAssetMessageItem({ transfers: [unknown] }),
    },
    {
      id: 'native-schema1-recovery',
      bytes: encodeStealthMessageItem({
        type: 'stealth',
        networkTag: 'btc-testnet',
        keyType: 1,
        ephemeralPubKey: toHex(ephemeral),
        transactions: ['0102'],
        amount: 1n,
      }),
    },
    {
      id: 'reject-zero',
      bytes: malformed(entry =>
        (
          entry.get(BigInt(STEALTH_ASSET_TRANSFER.transfer)) as Map<
            bigint,
            Encodable
          >
        ).set(BigInt(PAYMENT_TRANSFER.value), 0n),
      ),
    },
    {
      id: 'reject-missing-metadata',
      bytes: malformed(entry => {
        const transfer = entry.get(
          BigInt(STEALTH_ASSET_TRANSFER.transfer),
        ) as Map<bigint, Encodable>
        transfer.delete(BigInt(PAYMENT_TRANSFER.stealthMetadata))
      }),
    },
    {
      id: 'reject-program-without-token',
      bytes: malformed(entry => {
        const transfer = entry.get(
          BigInt(STEALTH_ASSET_TRANSFER.transfer),
        ) as Map<bigint, Encodable>
        transfer.delete(BigInt(PAYMENT_TRANSFER.token))
        entry.set(BigInt(STEALTH_ASSET_TRANSFER.derivationScheme), 2n)
        entry.set(
          BigInt(STEALTH_ASSET_TRANSFER.tokenProgram),
          new Uint8Array(32),
        )
      }),
    },
    {
      id: 'reject-zero-scheme',
      bytes: malformed(entry => {
        entry.set(BigInt(STEALTH_ASSET_TRANSFER.derivationScheme), 0n)
      }),
    },
  ]
  return {
    description:
      'Dedicated type-19 recipient payment schema 2 structural agreement; unknown schemes do not authorize execution.',
    cases: cases.map(({ id, bytes }) => {
      try {
        const parsed = parseFrame(bytes)
        if (parsed.kind !== 'parsed')
          throw new Error('unexpected retained vector')
        return {
          id,
          frame_hex: toHex(bytes),
          expectation: 'accepted',
          schema_version: parsed.schemaVersion,
        }
      } catch (error) {
        const failure = error as { category: string; stage: string }
        return {
          id,
          frame_hex: toHex(bytes),
          expectation: 'rejected',
          error_category: failure.category,
          error_stage: failure.stage,
        }
      }
    }),
  }
}
