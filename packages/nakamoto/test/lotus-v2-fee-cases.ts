// Fee vector cases the shared Lotus file (fixtures/lotus-v2/fee_vectors.json)
// lacks: spends of the 37-byte keyhash program Frank's wallet pays with
// (`DUP BLAKE3 PUSH32(keyhash) EQUALVERIFY CHECKSIG`; the shared file spends
// `PUSH32(key) CHECKSIG`), with several inputs and a mode-1 signature, many
// outputs, and token outputs. Signatures are BIP340 with zero aux
// randomness, so the bytes are deterministic.
//
// `npx tsx test/lotus-v2-fee-cases.ts --print` prints them as JSON for
// scripts/lotus-v2-fee-vectors.py, which prices them with the Lotus reference.

import { LOTUS_V2_REGTEST } from '../src/chain/lotus-v2'
import { privateKeyFromSecretBytes, publicFromPrivate } from '../src/keys'
import { signingKey } from '../src/signing-key'
import { lotusV2BranchLeaf } from '../src/lotus-v2/hash'
import { encodeLotusV2CoinOutput } from '../src/lotus-v2/legacy'
import { signLotusV2Transaction } from '../src/lotus-v2/sign'
import type { LotusV2TemplateSpend } from '../src/lotus-v2/sign'
import { lotusV2KeyhashTemplate } from '../src/lotus-v2/template'
import type { LotusV2Output } from '../src/lotus-v2/transaction'

const chain = LOTUS_V2_REGTEST

const secret = (n: number): Uint8Array => {
  const out = new Uint8Array(32)
  out[31] = n
  return out
}
export const feeCaseSigner = (n: number) => {
  const key = privateKeyFromSecretBytes(secret(n), true)
  if (!key.ok) throw new Error('key')
  const signer = signingKey('schnorr', {
    key: key.value,
    aux: new Uint8Array(32),
  })
  if (!signer.ok) throw new Error('signer')
  return signer.value
}
export const feeCaseXOnly = (n: number): Uint8Array => {
  const key = privateKeyFromSecretBytes(secret(n), true)
  if (!key.ok) throw new Error('key')
  const point = publicFromPrivate(key.value)
  if (!point.ok) throw new Error('point')
  return Uint8Array.from(point.value.xOnly)
}
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

export const keyhashOutput = (n: number, value: bigint): LotusV2Output => ({
  value,
  branches: [
    lotusV2BranchLeaf(chain, lotusV2KeyhashTemplate(feeCaseXOnly(n)).script),
  ],
  paths: [[0]],
})

export const keyhashSpend = (
  n: number,
  i: number,
  value: bigint,
  mode: 0 | 1 = 0,
): LotusV2TemplateSpend => ({
  prevTxid: new Uint8Array(32).fill(0x10 + i),
  prevIndex: i,
  coin: keyhashOutput(n, value),
  template: lotusV2KeyhashTemplate(feeCaseXOnly(n)),
  signer: feeCaseSigner(n),
  mode,
})

const TOKEN = new Uint8Array(32).fill(0x77)

export interface FeeCase {
  readonly name: string
  readonly spends: readonly LotusV2TemplateSpend[]
  readonly outputs: readonly LotusV2Output[]
}

export function feeCases(): FeeCase[] {
  return [
    {
      name: 'keyhash 1-in/2-out',
      spends: [keyhashSpend(1, 0, 10_000_000n)],
      outputs: [keyhashOutput(2, 3_000_000n), keyhashOutput(1, 6_990_000n)],
    },
    {
      name: 'keyhash 3-in/2-out, one mode-1 signature',
      spends: [
        keyhashSpend(1, 0, 1_000_000n),
        keyhashSpend(4, 1, 2_000_000n, 1),
        keyhashSpend(5, 2, 3_000_000n),
      ],
      outputs: [keyhashOutput(2, 5_000_000n), keyhashOutput(1, 990_000n)],
    },
    {
      name: 'keyhash 1-in/20-out',
      spends: [keyhashSpend(1, 0, 100_000_000n)],
      outputs: Array.from({ length: 20 }, (_, j) =>
        keyhashOutput(6 + j, 4_000_000n + BigInt(j)),
      ),
    },
    {
      name: 'keyhash 1-in, 2 token outputs and native change',
      spends: [keyhashSpend(1, 0, 10_000_000n)],
      outputs: [
        { ...keyhashOutput(2, 600n), tokenId: TOKEN },
        { ...keyhashOutput(1, 400n), tokenId: TOKEN },
        keyhashOutput(1, 9_990_000n),
      ],
    },
  ]
}

/** The signed bytes and the spent coins' outputs, as the vector file holds them. */
export function feeCaseWire(c: FeeCase): { tx: string; coins: string[] } {
  const signed = signLotusV2Transaction({
    chain,
    inputs: c.spends,
    outputs: c.outputs,
  })
  return {
    tx: hex(signed.raw),
    coins: c.spends.map(s => hex(encodeLotusV2CoinOutput(s.coin))),
  }
}

if (process.argv.includes('--print'))
  process.stdout.write(
    JSON.stringify(
      feeCases().map(c => ({ name: c.name, ...feeCaseWire(c) })),
      null,
      1,
    ) + '\n',
  )
