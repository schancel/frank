// Lotus v2 signature messages and BIP340 signing (P01 "Resolved outputs and
// committed authorization", "Exact CHECKSIG message").
//
//   SpendSelector = 01 || input_index:u32 || branch_index:u32 || Leaf(script)
//   mode 00 FULL:                 H_sighash(ChainID || 00 || TxID || CoinsRoot || Selector)
//   mode 01 OWN_INPUT_ALL_OUTPUTS: H_sighash(ChainID || 01 || version || lock
//                                            || OwnInputHash(i) || OutputsRoot || Selector)
//   mode 02 OWN_INPUT_ONE_OUTPUT:  H_sighash(ChainID || 02 || version || lock
//                                            || OwnInputHash(i) || OutputLeaf(i) || Selector)
//
// A 64-byte signature means mode 00; modes 01/02 append one mode byte. The
// signature itself is unmodified BIP340 over the 32-byte message.

import { concatBytes } from '../bytes.js'
import type { LotusV2ChainDescriptor } from '../chain/types.js'
import { verifySchnorr } from '../curve.js'
import { ByteWriter } from '../reader.js'
import type { SigningKey } from '../signing-key.js'
import {
  lengthPrefixed,
  lotusV2BranchLeaf,
  lotusV2BranchProofRoot,
  lotusV2IndexedTreeRoot,
  lotusV2TaggedHash,
} from './hash.js'
import type { LotusV2SignatureTemplate } from './template.js'
import {
  encodeLotusV2Input,
  encodeLotusV2Output,
  encodeLotusV2Transaction,
  LOTUS_V2_NO_LOCK,
  LOTUS_V2_SEQUENCE_FINAL,
  LotusV2FormatError,
  type LotusV2Input,
  type LotusV2Lock,
  type LotusV2Output,
  type LotusV2Transaction,
  lotusV2ChainIdBytes,
  lotusV2HeaderCore,
  lotusV2TransactionIdentities,
} from './transaction.js'

export type LotusV2SigningMode = 0 | 1 | 2

type SpendInput = Extract<LotusV2Input, { kind: 'spend' }>

/** The resolved coin of each input in order; `undefined` for a mint input. */
export type LotusV2ResolvedCoins = readonly (LotusV2Output | undefined)[]

function resolvedFor(
  tx: LotusV2Transaction,
  coins: LotusV2ResolvedCoins,
): void {
  if (coins.length !== tx.inputs.length)
    throw new LotusV2FormatError('resolved count')
  tx.inputs.forEach((input, i) => {
    const coin = coins[i]
    if (input.kind === 'coinbase')
      throw new LotusV2FormatError('unsupported input kind for signing')
    if (input.kind === 'spend' && (!coin || coin.burn))
      throw new LotusV2FormatError('spend resolved coin')
    if (input.kind === 'mint' && coin)
      throw new LotusV2FormatError('mint resolved coin')
  })
}

/** `CoinsRoot = IndexedTreeRoot(H_coinentry(Bytes(Output(coin_i))))`; a mint's entry is `Bytes(empty)`. */
export function lotusV2CoinsRoot(
  chain: LotusV2ChainDescriptor,
  tx: LotusV2Transaction,
  coins: LotusV2ResolvedCoins,
): Uint8Array {
  resolvedFor(tx, coins)
  return lotusV2IndexedTreeRoot(
    chain,
    coins.map(coin =>
      lotusV2TaggedHash(
        chain,
        'coinentry',
        lengthPrefixed(coin ? encodeLotusV2Output(coin) : new Uint8Array(0)),
      ),
    ),
  )
}

/** `OwnInputHash(i) = H_owninput(InputCore(i) || Bytes(Output(resolved_coin_i)))`. */
export function lotusV2OwnInputHash(
  chain: LotusV2ChainDescriptor,
  input: LotusV2Input,
  coin: LotusV2Output,
): Uint8Array {
  return lotusV2TaggedHash(
    chain,
    'owninput',
    concatBytes([
      encodeLotusV2Input(input, true),
      lengthPrefixed(encodeLotusV2Output(coin)),
    ]),
  )
}

export class LotusV2UnsupportedError extends Error {
  constructor(readonly feature: string) {
    super(`Lotus v2: ${feature} is not supported`)
    this.name = 'LotusV2UnsupportedError'
  }
}

export interface LotusV2SignatureTarget {
  readonly inputIndex: number
  /** Position `j` in the input's witness vector. */
  readonly witnessIndex: number
  readonly mode: LotusV2SigningMode
}

/** The 32 bytes a CHECKSIG in witness `j` of input `i` verifies. */
export function lotusV2SignatureMessage(
  chain: LotusV2ChainDescriptor,
  tx: LotusV2Transaction,
  coins: LotusV2ResolvedCoins,
  target: LotusV2SignatureTarget,
): Uint8Array {
  const { inputIndex: i, witnessIndex: j, mode } = target
  if (!chain.signature.modes.includes(mode))
    throw new LotusV2UnsupportedError(`signing mode ${String(mode)}`)
  const input = tx.inputs[i]
  if (input === undefined) throw new LotusV2FormatError('input index')
  if (input.kind === 'mint')
    // MintSelector binds the accounting delta, which this package does not compute.
    throw new LotusV2UnsupportedError('mint signature messages')
  if (input.kind !== 'spend')
    throw new LotusV2FormatError('unsupported input kind for signing')
  resolvedFor(tx, coins)
  const coin = coins[i] as LotusV2Output
  const path = coin.paths[input.pathIndex]
  if (path === undefined) throw new LotusV2FormatError('path index')
  const branchIndex = path[j]
  const witness = input.witnesses[j]
  if (branchIndex === undefined || witness === undefined)
    throw new LotusV2FormatError('witness index')
  const selector = new ByteWriter()
    .writeUInt8(1)
    .writeUInt32LE(i)
    .writeUInt32LE(branchIndex)
    .write(lotusV2BranchLeaf(chain, witness.script))
    .finish()
  const chainId = lotusV2ChainIdBytes(chain)
  const ids = lotusV2TransactionIdentities(chain, tx)
  if (mode === 0)
    return lotusV2TaggedHash(
      chain,
      'sighash',
      concatBytes([
        chainId,
        Uint8Array.of(0),
        ids.txid,
        lotusV2CoinsRoot(chain, tx, coins),
        selector,
      ]),
    )
  // version:u32 || lock:u64 are the first 12 bytes of TxHeaderCore.
  const versionLock = lotusV2HeaderCore(chain, tx).subarray(0, 12)
  let outputs: Uint8Array
  if (mode === 1) outputs = ids.outputsRoot
  else {
    const paired = ids.outputLeaves[i]
    if (paired === undefined)
      throw new LotusV2FormatError('mode 02 input has no paired output')
    outputs = paired
  }
  return lotusV2TaggedHash(
    chain,
    'sighash',
    concatBytes([
      chainId,
      Uint8Array.of(mode),
      versionLock,
      lotusV2OwnInputHash(chain, input, coin),
      outputs,
      selector,
    ]),
  )
}

/** The CHECKSIG operand: 64 bytes for mode 00, else 64 bytes and the mode byte. */
export function lotusV2SignatureOperand(
  signature: Uint8Array,
  mode: LotusV2SigningMode,
): Uint8Array {
  if (signature.length !== 64)
    throw new RangeError('BIP340 signatures are 64 bytes')
  return mode === 0
    ? Uint8Array.from(signature)
    : concatBytes([signature, Uint8Array.of(mode)])
}

/**
 * Verify a CHECKSIG operand against witness `j` of input `i`: the operand's
 * length selects the mode exactly as P01 does (an explicit `00` byte is an
 * error, so it is `false` here).
 */
export function verifyLotusV2Signature(
  chain: LotusV2ChainDescriptor,
  tx: LotusV2Transaction,
  coins: LotusV2ResolvedCoins,
  target: { readonly inputIndex: number; readonly witnessIndex: number },
  operand: Uint8Array,
  xOnlyPublicKey: Uint8Array,
): boolean {
  let mode: LotusV2SigningMode
  if (operand.length === 64) mode = 0
  else if (operand.length === 65 && (operand[64] === 1 || operand[64] === 2))
    mode = operand[64] as 1 | 2
  else return false
  const message = lotusV2SignatureMessage(chain, tx, coins, { ...target, mode })
  const verified = verifySchnorr(
    operand.subarray(0, 64),
    message,
    xOnlyPublicKey,
  )
  return verified.ok && verified.value
}

/** One coin to spend through a single-signature template on one branch. */
export interface LotusV2TemplateSpend {
  readonly prevTxid: Uint8Array
  readonly prevIndex: number
  readonly sequence?: number
  /** The coin's complete output, as created. */
  readonly coin: LotusV2Output
  readonly template: LotusV2SignatureTemplate
  /** Membership proof of the template's leaf in its branch root (bottom-up); none for a one-leaf root. */
  readonly siblings?: readonly Uint8Array[]
  /** A BIP340 key (`signingKey('schnorr', …)`); its x-only key is what the template checks. */
  readonly signer: SigningKey
  readonly mode?: LotusV2SigningMode
}

export interface LotusV2SignedTransaction {
  readonly transaction: LotusV2Transaction
  readonly raw: Uint8Array
  readonly txid: Uint8Array
  readonly txhash: Uint8Array
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * Build and sign a transaction whose every input is a template spend of a
 * one-branch path (`paths[p] = [b]`, the template's leaf proven in
 * `branches[b]`). Outputs are taken as given; the fee is whatever the inputs
 * leave. Signatures never enter the TxID, so all inputs sign one TxID.
 */
export function signLotusV2Transaction(params: {
  readonly chain: LotusV2ChainDescriptor
  readonly inputs: readonly LotusV2TemplateSpend[]
  readonly outputs: readonly LotusV2Output[]
  readonly lock?: LotusV2Lock
}): LotusV2SignedTransaction {
  const { chain } = params
  const unsigned: SpendInput[] = params.inputs.map(spend => {
    const siblings = spend.siblings ?? []
    const root = lotusV2BranchProofRoot(
      chain,
      lotusV2BranchLeaf(chain, spend.template.script),
      siblings,
    )
    const pathIndex = spend.coin.paths.findIndex(
      path =>
        path.length === 1 &&
        equal(spend.coin.branches[path[0] as number] as Uint8Array, root),
    )
    if (pathIndex < 0)
      throw new LotusV2FormatError(
        'the template is not a one-branch path of the coin',
      )
    if (spend.signer.publicKey.length !== 32)
      throw new LotusV2FormatError('the signer is not an x-only BIP340 key')
    return {
      kind: 'spend',
      prevTxid: spend.prevTxid,
      prevIndex: spend.prevIndex,
      sequence: spend.sequence ?? LOTUS_V2_SEQUENCE_FINAL,
      pathIndex,
      witnesses: [{ script: spend.template.script, siblings, arguments: [] }],
    }
  })
  const draft: LotusV2Transaction = {
    lock: params.lock ?? LOTUS_V2_NO_LOCK,
    inputs: unsigned,
    outputs: params.outputs,
  }
  const coins = params.inputs.map(spend => spend.coin)
  const inputs: LotusV2Input[] = unsigned.map((input, i) => {
    const spend = params.inputs[i] as LotusV2TemplateSpend
    const mode = spend.mode ?? 0
    const message = lotusV2SignatureMessage(chain, draft, coins, {
      inputIndex: i,
      witnessIndex: 0,
      mode,
    })
    const operand = lotusV2SignatureOperand(spend.signer.sign(message), mode)
    const witness = {
      script: spend.template.script,
      siblings: spend.siblings ?? [],
      arguments: spend.template.arguments(operand),
    }
    return { ...input, witnesses: [witness] }
  })
  const transaction: LotusV2Transaction = { ...draft, inputs }
  const ids = lotusV2TransactionIdentities(chain, transaction)
  return {
    transaction,
    raw: encodeLotusV2Transaction(chain, transaction),
    txid: ids.txid,
    txhash: ids.txhash,
  }
}

/**
 * Exact signed size of a transaction spending `inputCount` one-branch coins
 * with `template` (no proof siblings) to `outputCount` native one-branch,
 * one-path outputs. Signatures have a fixed length per mode, so the size is
 * known before signing.
 */
export function lotusV2TemplatePaymentSize(
  template: LotusV2SignatureTemplate,
  inputCount: number,
  outputCount: number,
  mode: LotusV2SigningMode = 0,
): number {
  const input = encodeLotusV2Input({
    kind: 'spend',
    prevTxid: new Uint8Array(32),
    prevIndex: 0,
    sequence: LOTUS_V2_SEQUENCE_FINAL,
    pathIndex: 0,
    witnesses: [
      {
        script: template.script,
        siblings: [],
        arguments: template.arguments(
          lotusV2SignatureOperand(new Uint8Array(64), mode),
        ),
      },
    ],
  }).length
  const output = encodeLotusV2Output({
    value: 0n,
    branches: [new Uint8Array(32)],
    paths: [[0]],
  }).length
  return 16 + inputCount * input + outputCount * output
}
