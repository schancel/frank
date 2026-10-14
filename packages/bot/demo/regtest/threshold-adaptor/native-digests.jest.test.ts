import {
  verifyAdaptorSignature,
  generateAdaptorSecret,
  extractAdaptorSecret,
  compactEcdsaSignatureFromBytes,
} from '@frank/adaptor-signatures'
import { randomBytes } from 'node:crypto'
import { Signature } from 'ethers'
import { recoveryBit } from '@frank/threshold-ecdsa'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { createHash } from 'node:crypto'
import { internalHashFromBytes, type Transaction } from '@frank/nakamoto'
import {
  buildXecAdaptorSpend,
  buildEvmAdaptorTransfer,
  requireLoopback,
} from './native-digests'
import { must, hex, freshJointKey } from './signing-fixture'

const script = new Uint8Array(
  Buffer.from(`76a914${'11'.repeat(20)}88ac`, 'hex')
)
const tx: Transaction = {
  version: 2,
  inputs: [
    {
      prevout: {
        txid: must(internalHashFromBytes(new Uint8Array(32).fill(2))),
        vout: 3,
      },
      scriptSig: new Uint8Array(),
      sequence: 0xfffffffe,
    },
  ],
  outputs: [{ value: 9000n, scriptPubKey: script }],
  locktime: 7,
}
const evm = {
  chainIdentifier: 'monad-regtest',
  chainId: 20143n,
  nonce: 0,
  to: '0x0000000000000000000000000000000000000001',
  value: 1n,
  gasLimit: 21000n,
  maxFeePerGas: 100n,
  maxPriorityFeePerGas: 2n,
}
const sha = (b: Buffer) =>
  createHash('sha256').update(createHash('sha256').update(b).digest()).digest()
const le = (n: bigint, bytes: number) => {
  const b = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i++) {
    b[i] = Number(n & 255n)
    n >>= 8n
  }
  return b
}

it('matches an independently assembled ForkID preimage, including prevout amount', () => {
  const outpoint = Buffer.concat([Buffer.alloc(32, 2), le(3n, 4)])
  const output = Buffer.concat([
    le(9000n, 8),
    Buffer.from([script.length]),
    script,
  ])
  const preimage = Buffer.concat([
    le(2n, 4),
    sha(outpoint),
    sha(le(0xfffffffen, 4)),
    outpoint,
    Buffer.from([script.length]),
    script,
    le(10000n, 8),
    le(0xfffffffen, 4),
    sha(output),
    le(7n, 4),
    le(0x41n, 4),
  ])
  expect(hex(buildXecAdaptorSpend('xec-regtest', tx, script, 10000n))).toBe(
    hex(sha(preimage))
  )
  expect(hex(buildXecAdaptorSpend('xec-regtest', tx, script, 10001n))).not.toBe(
    hex(sha(preimage))
  )
  expect(
    hex(
      buildXecAdaptorSpend(
        'xec-regtest',
        {
          ...tx,
          inputs: [
            {
              ...tx.inputs[0]!,
              prevout: { ...tx.inputs[0]!.prevout, vout: 4 },
            },
          ],
        },
        script,
        10000n
      )
    )
  ).not.toBe(hex(sha(preimage)))
})
it('pins the literal EIP-1559 unsigned bytes and rejects wrong chain before signing', () => {
  expect(buildEvmAdaptorTransfer(evm).preimage).toBe(
    '0x02e1824eaf8002648252089400000000000000000000000000000000000000010180c0'
  )
  for (const patch of [
    { chainId: 143n },
    { chainIdentifier: 'evm' },
    { chainIdentifier: 'monad-mainnet' },
    { value: 0n },
  ])
    expect(() => buildEvmAdaptorTransfer({ ...evm, ...patch })).toThrow()
  expect(() => buildXecAdaptorSpend('bch-regtest', tx, script, 10000n)).toThrow(
    'unsupported'
  )
  expect(buildEvmAdaptorTransfer({ ...evm, value: 2n }).digest).not.toEqual(
    buildEvmAdaptorTransfer(evm).digest
  )
  expect(
    buildEvmAdaptorTransfer({
      ...evm,
      to: '0x0000000000000000000000000000000000000002',
    }).digest
  ).not.toEqual(buildEvmAdaptorTransfer(evm).digest)
})
it('rejects public URLs and credential-bearing endpoints', () => {
  for (const url of [
    'https://127.0.0.1:48080',
    'http://example.com',
    'http://localhost',
    'http://user:pass@127.0.0.1',
  ])
    expect(() => requireLoopback(url)).toThrow()
  expect(requireLoopback('http://127.0.0.1:49080')).toBe(
    'http://127.0.0.1:49080/'
  )
})
it('completes fresh dealerless adaptor signing and refuses another observation digest', () => {
  const joint = freshJointKey(),
    digest = buildEvmAdaptorTransfer(evm).digest
  const result = joint.sign(digest, 'monad-regtest/disposable-test')
  expect(result.observe(digest, result.completed)).toEqual({
    extractionVerified: true,
  })
  expect(() => result.observe(new Uint8Array(32), result.completed)).toThrow(
    'binding'
  )
  const other = must(
    generateAdaptorSecret((n) => new Uint8Array(randomBytes(n)))
  )
  expect(
    must(
      verifyAdaptorSignature({ ...result.context, digest: new Uint8Array(32) })
    )
  ).toBe(false)
  expect(
    must(
      verifyAdaptorSignature({
        ...result.context,
        adaptorPoint: other.point,
        adaptorProof: other.proof,
      })
    )
  ).toBe(false)
  expect(
    must(verifyAdaptorSignature({ ...result.context, publicKey: other.point }))
  ).toBe(false)
  expect(
    recoveryBit(joint.publicKey, new Uint8Array(32), result.completed)
  ).toBeNull()
  expect(() =>
    Signature.from({
      r: '0x' + hex(result.completed.subarray(0, 32)),
      s: '0x' + hex(result.completed.subarray(32)),
      yParity: 2,
    })
  ).toThrow()
  const badProof = other.proof.slice()
  badProof[0] ^= 1
  expect(
    verifyAdaptorSignature({
      ...result.context,
      adaptorProof: badProof as typeof other.proof,
    }).ok
  ).toBe(false)
  const parsed = secp256k1.Signature.fromCompact(result.completed)
  const high = new secp256k1.Signature(
    parsed.r,
    secp256k1.CURVE.n - parsed.s
  ).toCompactRawBytes()
  expect(() => result.observe(digest, high)).toThrow('binding')
  expect(
    must(
      extractAdaptorSecret({
        ...result.context,
        completedSignature: must(compactEcdsaSignatureFromBytes(high)),
      })
    )
  ).toHaveLength(32)
  const changed = result.completed.slice()
  changed[0] ^= 1
  expect(() => result.observe(digest, changed)).toThrow()
}, 180000)
