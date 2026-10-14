import {
  XEC_REGTEST,
  sighash,
  type Transaction as XecTransaction,
} from '@frank/nakamoto'
import { Transaction, encodeRlp, keccak256, toBeHex } from 'ethers'

export function requireChain(
  actual: string,
  expected: 'xec-regtest' | 'monad-regtest'
): void {
  if (actual !== expected)
    throw new Error(`unsupported chainIdentifier: ${actual}`)
}

export function buildXecAdaptorSpend(
  chainIdentifier: string,
  transaction: XecTransaction,
  scriptCode: Uint8Array,
  amount: bigint
): Uint8Array {
  requireChain(chainIdentifier, 'xec-regtest')
  if (
    transaction.inputs.length !== 1 ||
    amount <= 0n ||
    transaction.outputs.some((o) => o.value <= 0n) ||
    transaction.outputs.reduce((sum, o) => sum + o.value, 0n) >= amount
  )
    throw new Error('invalid spend accounting')
  const result = sighash(transaction, 0, XEC_REGTEST, 0x41, {
    algorithm: 'forkid',
    scriptCode,
    amount,
  })
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

export interface EvmTransfer {
  chainIdentifier: string
  chainId: bigint
  nonce: number
  to: string
  value: bigint
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

export function buildEvmAdaptorTransfer(input: EvmTransfer) {
  requireChain(input.chainIdentifier, 'monad-regtest')
  if (
    input.chainId !== 20143n ||
    input.value <= 0n ||
    !Number.isSafeInteger(input.nonce) ||
    input.nonce < 0 ||
    input.gasLimit < 21000n ||
    input.maxPriorityFeePerGas < 0n ||
    input.maxFeePerGas < input.maxPriorityFeePerGas
  )
    throw new Error('invalid local native transfer')
  const { chainIdentifier: _, ...fields } = input
  const transaction = Transaction.from({
    ...fields,
    type: 2,
    data: '0x',
    accessList: [],
  })
  const integer = (n: bigint | number) => (BigInt(n) === 0n ? '0x' : toBeHex(n))
  const preimage = `0x02${encodeRlp([
    integer(input.chainId),
    integer(input.nonce),
    integer(input.maxPriorityFeePerGas),
    integer(input.maxFeePerGas),
    integer(input.gasLimit),
    input.to,
    integer(input.value),
    '0x',
    [],
  ]).slice(2)}`
  if (
    preimage.toLowerCase() !== transaction.unsignedSerialized.toLowerCase() ||
    keccak256(preimage) !== transaction.unsignedHash
  )
    throw new Error('native digest disagreement')
  return {
    transaction,
    preimage,
    digest: Uint8Array.from(Buffer.from(keccak256(preimage).slice(2), 'hex')),
  }
}

export function requireLoopback(url: string): string {
  const parsed = new URL(url)
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  )
    throw new Error('dedicated literal loopback HTTP endpoint required')
  return parsed.href
}
