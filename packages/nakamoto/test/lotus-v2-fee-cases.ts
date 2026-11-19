// Fee vector cases the shared Lotus file (fixtures/lotus-v2/fee_vectors.json)
// lacks, all on Frank's keyhash program (`DUP BLAKE3 PUSH32(keyhash)
// EQUALVERIFY CHECKSIG`) or Frank's own scripts:
// - a mode-1 signature (a 65-byte operand; every shared vector signs mode 0);
// - token outputs created from keyhash coins;
// - Frank's HTLC claim and refund (SIZE and NUMEQUALVERIFY, which no shared
//   vector uses; the shared htlc-* vectors are the reference's own HTLC).
// The HTLC programs are the bytes of packages/nakamoto/src/lotus-v2/htlc.ts
// at Frank ec5300b68 (branch worktree-agent-a7e41a13b3bffda83, not yet on
// main), rebuilt here so this file does not depend on that branch.
// Signatures are BIP340 with zero aux randomness, so the bytes are
// deterministic.
//
// `npx tsx test/lotus-v2-fee-cases.ts --print` prints them as JSON for
// scripts/lotus-v2-fee-vectors.py, which prices them with the Lotus reference.

import { sha256 } from '@noble/hashes/sha2.js'

import { LOTUS_V2_REGTEST } from '../src/chain/lotus-v2'
import { privateKeyFromSecretBytes, publicFromPrivate } from '../src/keys'
import { signingKey } from '../src/signing-key'
import { lotusV2BranchLeaf, lotusV2BranchNode } from '../src/lotus-v2/hash'
import { encodeLotusV2CoinOutput } from '../src/lotus-v2/legacy'
import { signLotusV2Transaction } from '../src/lotus-v2/sign'
import type { LotusV2TemplateSpend } from '../src/lotus-v2/sign'
import { lotusV2KeyhashTemplate } from '../src/lotus-v2/template'
import type { LotusV2Lock, LotusV2Output } from '../src/lotus-v2/transaction'

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

// Frank's HTLC programs (htlc.ts at ec5300b68): numbers are 16-byte pushes.
const pushNumber = (value: bigint): number[] => {
  const out = [0x10]
  for (let i = 0n; i < 16n; i += 1n)
    out.push(Number((value >> (8n * i)) & 0xffn))
  return out
}
const requireSize = (n: bigint): number[] => [0x8c, ...pushNumber(n), 0xa7]
const push32 = (b: Uint8Array): number[] => [0x20, ...b]
export const HTLC_PREIMAGE = new Uint8Array(32).fill(0x42)
export const HTLC_REFUND_LOCK: LotusV2Lock = { kind: 1, value: 500n }
export const htlcClaimScript = (): Uint8Array =>
  Uint8Array.from([
    ...requireSize(32n),
    0xb8,
    ...push32(sha256(HTLC_PREIMAGE)),
    0x92,
    ...requireSize(64n),
    ...push32(feeCaseXOnly(2)),
    0xbb,
  ])
export const htlcRefundScript = (): Uint8Array =>
  Uint8Array.from([
    0x4e,
    ...pushNumber(HTLC_REFUND_LOCK.value),
    0xf3,
    ...requireSize(64n),
    ...push32(feeCaseXOnly(3)),
    0xbb,
  ])
const htlcCoin = (value: bigint): LotusV2Output => ({
  value,
  branches: [
    lotusV2BranchNode(
      chain,
      lotusV2BranchLeaf(chain, htlcClaimScript()),
      lotusV2BranchLeaf(chain, htlcRefundScript()),
    ),
  ],
  paths: [[0]],
})
export const htlcSpend = (
  branch: 'claim' | 'refund',
  value: bigint,
): LotusV2TemplateSpend => {
  const key = branch === 'claim' ? 2 : 3
  const script = branch === 'claim' ? htlcClaimScript() : htlcRefundScript()
  const other = branch === 'claim' ? htlcRefundScript() : htlcClaimScript()
  return {
    prevTxid: new Uint8Array(32).fill(0x30),
    prevIndex: 0,
    coin: htlcCoin(value),
    template: {
      script,
      publicKey: feeCaseXOnly(key),
      arguments: (signature: Uint8Array) =>
        branch === 'claim'
          ? [Uint8Array.from(signature), Uint8Array.from(HTLC_PREIMAGE)]
          : [Uint8Array.from(signature)],
    },
    siblings: [lotusV2BranchLeaf(chain, other)],
    signer: feeCaseSigner(key),
  }
}

export interface FeeCase {
  readonly name: string
  readonly spends: readonly LotusV2TemplateSpend[]
  readonly outputs: readonly LotusV2Output[]
  readonly lock?: LotusV2Lock
}

export function feeCases(): FeeCase[] {
  return [
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
      name: 'Frank HTLC claim, 1-in/1-out',
      spends: [htlcSpend('claim', 10_000_000n)],
      outputs: [keyhashOutput(2, 9_990_000n)],
    },
    {
      name: 'Frank HTLC refund, 1-in/1-out',
      spends: [htlcSpend('refund', 10_000_000n)],
      outputs: [keyhashOutput(3, 9_990_000n)],
      lock: HTLC_REFUND_LOCK,
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
    ...(c.lock ? { lock: c.lock } : {}),
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
