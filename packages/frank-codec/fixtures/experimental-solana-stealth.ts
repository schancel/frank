/** Public synthetic bindings only; raw bytes are structural fixtures, not receipt proof. */
import { encodeCanonical } from '../src/cbor'
import { fromHex, toHex } from '../src/hash'
import { encodeStealthAssetMessageItem } from '../src/stealth-assets'
import {
  encodeExperimentalSolanaStealthContext,
  experimentalSolanaStealthTranscript,
} from '../src/experimental-solana-stealth'
import type { StealthAssetTransfer } from '../src/types'

/** Public native inputs from frozen crypto vectors e4b87c2d, native-0-0. */
export const FROZEN_NATIVE_Q =
  '8978236672616e6b3a736f6c616e612d737465616c74683a656477617264732d6164643a76316d736f6c616e612d6465766e65748100582003a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8582058666666666666666666666666666666666666666666666666666666666666665820202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f005820404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f01'

export function experimentalEntry(spl = false): StealthAssetTransfer {
  return {
    derivationScheme: 2,
    recipientSpendKey: {
      keyType: 2,
      keyBytes: fromHex(
        '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8',
      ),
    },
    derivationContext: encodeExperimentalSolanaStealthContext({
      cryptoOperationId: fromHex(
        '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
      ),
      memberIndex: spl ? 0xffffffff : 0,
      derivationContext: fromHex(
        '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
      ),
    }),
    ...(spl
      ? {
          tokenProgram: fromHex(
            '06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9',
          ),
        }
      : {}),
    transfer: {
      networkTag: 'solana-devnet',
      txId: new Uint8Array(64).fill(9),
      destination: new Uint8Array(32).fill(10),
      value: spl ? 18446744073709551615n : 1n,
      ...(spl ? { token: new Uint8Array(32).fill(17) } : {}),
      stealthMetadata: {
        ephemeralPubKey: {
          keyType: 2,
          keyBytes: fromHex(
            '5866666666666666666666666666666666666666666666666666666666666666',
          ),
        },
      },
      rawTx: new Uint8Array([1, 2, 3]),
    },
  }
}

export function experimentalSolanaStealthCorpus() {
  return {
    status:
      'UNALLOCATED EXPERIMENT; structural bindings only, no execution or cryptographic approval',
    cases: [false, true].map(spl => {
      const entry = experimentalEntry(spl)
      const context = entry.derivationContext!
      return {
        id: spl ? 'classic-spl-u64-max-u32-max' : 'native-frozen-Q',
        frame_hex: toHex(encodeStealthAssetMessageItem({ transfers: [entry] })),
        context_hex: toHex(context),
        transcript_hex: toHex(experimentalSolanaStealthTranscript(entry)),
      }
    }),
    invalid_contexts: [
      { id: 'not-array', bytes: encodeCanonical(new Map()) },
      {
        id: 'extra-field',
        bytes: encodeCanonical([new Uint8Array(32), 0, new Uint8Array(32), 0]),
      },
      {
        id: 'uuid16',
        bytes: encodeCanonical([new Uint8Array(16), 0, new Uint8Array(32)]),
      },
      {
        id: 'wrong-context-length',
        bytes: encodeCanonical([new Uint8Array(32), 0, new Uint8Array(31)]),
      },
      {
        id: 'negative-index',
        bytes: encodeCanonical([new Uint8Array(32), -1, new Uint8Array(32)]),
      },
      {
        id: 'overflow-index',
        bytes: encodeCanonical([
          new Uint8Array(32),
          4294967296n,
          new Uint8Array(32),
        ]),
      },
      {
        id: 'noncanonical-index',
        bytes: fromHex(
          '835820' + '00'.repeat(32) + '18005820' + '00'.repeat(32),
        ),
      },
      {
        id: 'trailing-byte',
        bytes: fromHex(
          '835820' + '00'.repeat(32) + '005820' + '00'.repeat(32) + '00',
        ),
      },
    ].map(({ id, bytes }) => ({ id, context_hex: toHex(bytes) })),
  }
}
