/** Ordinary owned-chain observation proof; no runtime or malicious-signing experiment. */
import assert from 'assert/strict'
import { spawnSync } from 'child_process'
import { openSync, writeFileSync, fsyncSync, closeSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  Contract,
  Interface,
  Transaction,
  JsonRpcProvider,
  type TransactionReceipt,
} from 'ethers'
import artifact from '../../../../contracts/artifacts/StateChannel.json'
import type { ReadyTemplateFixture } from '../owned-template-fixture'
import {
  runNativeConditionalSuccess,
  completeEvmFromObserved,
  validateRecoveryPackage,
  type RecoveryPackage,
  type ExpectedRecovery,
} from './native-conditional-success'

type Rpc = ReadyTemplateFixture['rpc']
interface Anchor {
  hash: string
  height: number
}
interface Header extends Anchor {
  time: number
  mediantime: number
  previousblockhash?: string
  confirmations: number
}
interface NativeBlock extends Anchor {
  tx: Array<{
    txid: string
    hex: string
    vin: Array<{ txid?: string; vout?: number }>
    vout: Array<{ n: number; value: number; scriptPubKey: { hex: string } }>
  }>
}
export interface PublicClaimObservation {
  version: 1
  recovery: RecoveryPackage
  expected: ExpectedRecovery
  fundingAnchor: Anchor
  claimAnchor: Anchor
  claimRaw: string
}
function persistPublic(path: string, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value))
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const directory = openSync(join(path, '..'), 'r')
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
  assert.deepEqual(readFileSync(path), bytes)
}
export function validateClaimObservation(value: PublicClaimObservation): void {
  assert.equal(value.version, 1)
  validateRecoveryPackage(value.recovery, value.expected)
  for (const anchor of [value.fundingAnchor, value.claimAnchor]) {
    assert.match(anchor.hash, /^[0-9a-f]{64}$/)
    assert.ok(Number.isSafeInteger(anchor.height) && anchor.height > 0)
  }
  assert.ok(value.claimAnchor.height > value.fundingAnchor.height)
  assert.match(value.claimRaw, /^(?:[0-9a-f]{2})+$/)
  completeEvmFromObserved(value.recovery, value.expected, value.claimRaw)
}
export function replayPublicObservation(path: string) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', __filename, '--public-replay', path],
    {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as ReturnType<typeof completeEvmFromObserved>
}
async function tip(rpc: Rpc): Promise<Header> {
  return rpc<Header>('getblockheader', [await rpc<string>('getbestblockhash')])
}
async function canonicalHeaders(rpc: Rpc, funding: Anchor): Promise<Header[]> {
  assert.equal(
    await rpc('getblockhash', [funding.height]),
    funding.hash,
    'funding anchor changed',
  )
  const latest = await tip(rpc)
  assert.ok(
    latest.height - funding.height <= 32,
    'bounded settlement observation range',
  )
  const result: Header[] = []
  for (let height = funding.height; height <= latest.height; height++) {
    const header = await rpc<Header>('getblockheader', [
      await rpc('getblockhash', [height]),
    ])
    assert.equal(header.height, height)
    if (result.length)
      assert.equal(header.previousblockhash, result.at(-1)!.hash)
    result.push(header)
  }
  return result
}
export async function projectClaim(rpc: Rpc, value?: PublicClaimObservation) {
  if (!value) return { state: 'unseen', completionKnown: false } as const
  validateClaimObservation(value)
  const headers = await canonicalHeaders(rpc, value.fundingAnchor)
  const canonical = headers.find(
    header => header.height === value.claimAnchor.height,
  )
  const included = canonical?.hash === value.claimAnchor.hash
  const depth = included
    ? headers.at(-1)!.height - value.claimAnchor.height + 1
    : 0
  return {
    state: included && depth >= 2 ? 'canonical' : 'observed/noncanonical',
    completionKnown: true,
    depth,
  } as const
}

/** Disconnect settlement only; the funding anchor is checked before and after every transition. */
export async function exerciseXecSettlementReorg(
  rpc: Rpc,
  value: PublicClaimObservation,
  directory: string,
) {
  validateClaimObservation(value)
  const path = join(directory, 'observed-public-claim.json')
  persistPublic(path, value)
  assert.equal((await projectClaim(rpc, value)).state, 'canonical')
  const before = await tip(rpc)
  await rpc('invalidateblock', [value.claimAnchor.hash])
  const disconnected = await tip(rpc)
  assert.ok(disconnected.height < value.claimAnchor.height)
  assert.equal(
    (await rpc<Header>('getblockheader', [value.claimAnchor.hash]))
      .confirmations,
    -1,
  )
  const projection = await projectClaim(rpc, value)
  assert.equal(projection.state, 'observed/noncanonical')
  const funding = await rpc<{ value: number } | null>('gettxout', [
    value.recovery.binding.fundingTxid,
    value.recovery.binding.vout,
    false,
  ])
  assert.ok(
    funding,
    'canonical funding remains unspent when orphan claim is ignored',
  )
  const mempool = await rpc<string[]>('getrawmempool')
  const publicOnly = replayPublicObservation(path)
  const expectedCompletion = completeEvmFromObserved(
    value.recovery,
    value.expected,
    value.claimRaw,
  )
  assert.deepEqual(publicOnly, expectedCompletion)
  await rpc('setmocktime', [before.time + 1])
  const alternate = await rpc<Anchor>('generateblock', ['raw(6a)', []])
  assert.notEqual(alternate.hash, value.claimAnchor.hash)
  const reincluded = await rpc<Anchor>('generateblock', [
    'raw(6a)',
    [value.claimRaw],
  ])
  await rpc('generateblock', ['raw(6a)', []])
  const block = await rpc<NativeBlock>('getblock', [reincluded.hash, 2])
  const claim = block.tx.find(tx => tx.hex === value.claimRaw)
  assert.ok(claim)
  assert.equal(claim.vin.length, 1)
  assert.equal(claim.vin[0]!.txid, value.recovery.binding.fundingTxid)
  assert.equal(claim.vin[0]!.vout, value.recovery.binding.vout)
  assert.equal(claim.vout.length, 1)
  assert.equal(
    claim.vout[0]!.scriptPubKey.hex,
    value.recovery.binding.recipientScript,
  )
  assert.equal(
    Math.round(claim.vout[0]!.value * 100),
    Number(value.recovery.binding.principalSats),
  )
  assert.equal(
    await rpc('gettxout', [
      value.recovery.binding.fundingTxid,
      value.recovery.binding.vout,
      false,
    ]),
    null,
  )
  const current = {
    ...value,
    claimAnchor: { hash: reincluded.hash, height: block.height },
  }
  const after = await projectClaim(rpc, current)
  assert.equal(after.state, 'canonical')
  assert.ok(after.depth >= 2)
  const headers = await canonicalHeaders(rpc, value.fundingAnchor)
  assert.throws(() => validateClaimObservation({ ...value, claimRaw: '' }))
  const wrong = structuredClone(value)
  wrong.expected.binding.channelId = '0x' + '00'.repeat(32)
  assert.throws(() => validateClaimObservation(wrong))
  return {
    block,
    claim,
    anchor: current.claimAnchor,
    observation: {
      label: 'XEC settlement disconnected and exact claim reincluded',
      fundingAnchor: value.fundingAnchor,
      original: value.claimAnchor,
      before,
      disconnected,
      disconnectedProjection: projection,
      mempoolTransactionIds: mempool,
      canonicalFundingUnspentDespiteHistoricalClaim: true,
      freshPublicProcessCompletion: publicOnly,
      originalSecretOrJointHandlePassed: false,
      reincluded: current.claimAnchor,
      currentProjection: after,
      canonicalHeaders: headers,
      exactOriginalClaimRaw: value.claimRaw,
      missingAndMismatchedBindingsRejected: true,
    },
  }
}

/** Starts with only negotiated/public recovery data, not a claim notification. */
export async function discoverDelayedClaim(
  rpc: Rpc,
  provider: JsonRpcProvider,
  recovery: RecoveryPackage,
  expected: ExpectedRecovery,
  funding: Anchor,
  directory: string,
) {
  validateRecoveryPackage(recovery, expected)
  await rpc('setmocktime', [recovery.binding.refundTimestamp + 1])
  for (
    let i = 0;
    (await tip(rpc)).mediantime <= recovery.binding.refundTimestamp;
    i++
  ) {
    assert.ok(i < 12, 'bounded MTP advance')
    await rpc('generateblock', ['raw(6a)', []])
  }
  const started = await tip(rpc)
  assert.ok(started.mediantime > recovery.binding.refundTimestamp)
  assert.ok(started.time <= recovery.binding.refundFinalBound)
  await provider.send('evm_setNextBlockTimestamp', [started.time])
  await provider.send('evm_mine', [])
  const evmClock = await provider.getBlock('latest')
  assert.ok(evmClock)
  const now = Math.max(started.time, evmClock.timestamp)
  const deadline = recovery.binding.openingTimestamp + recovery.binding.duration
  assert.ok(
    now + recovery.binding.responseMargin + recovery.binding.crossClockMargin <
      deadline,
  )
  const headers = await canonicalHeaders(rpc, funding)
  const matches: Array<{ block: NativeBlock; tx: NativeBlock['tx'][number] }> =
    []
  for (const header of headers.slice(1)) {
    const block = await rpc<NativeBlock>('getblock', [header.hash, 2])
    for (const tx of block.tx)
      if (
        tx.vin.some(
          input =>
            input.txid === recovery.binding.fundingTxid &&
            input.vout === recovery.binding.vout,
        )
      )
        matches.push({ block, tx })
  }
  assert.equal(
    matches.length,
    1,
    'one canonical spend of exact funding outpoint',
  )
  const found = matches[0]!
  const value: PublicClaimObservation = {
    version: 1,
    recovery,
    expected,
    fundingAnchor: funding,
    claimAnchor: { hash: found.block.hash, height: found.block.height },
    claimRaw: found.tx.hex,
  }
  const path = join(directory, 'late-observer-public-claim.json')
  persistPublic(path, value)
  const completion = replayPublicObservation(path)
  assert.equal((await projectClaim(rpc, value)).state, 'canonical')
  return {
    completion,
    observation: {
      label:
        'observer starts after refund maturity and discovers earlier claim',
      receivedClaimNotification: false,
      discoveredVia: 'canonical bounded block scan for exact funding outpoint',
      fundingAnchor: funding,
      discoveredClaim: value.claimAnchor,
      exactClaimRaw: found.tx.hex,
      started,
      evmTimestamp: evmClock.timestamp,
      refundTimestamp: recovery.binding.refundTimestamp,
      refundFinalBound: recovery.binding.refundFinalBound,
      responseMargin: recovery.binding.responseMargin,
      crossClockMargin: recovery.binding.crossClockMargin,
      earliestFallback: deadline,
      remainingWindowSeconds: deadline - now,
      freshPublicProcessCompletion: completion,
      originalSecretOrJointHandlePassed: false,
      canonicalHeaders: headers,
    },
  }
}

interface PublicEvmObservation {
  version: number
  chainIdentifier: string
  channelId: string
  contract: string
  signedRaw: string
  authorization: string
  recovery: RecoveryPackage
  expected: ExpectedRecovery
  claimRaw: string
  originalReceipt: {
    hash: string
    blockHash: string
    blockNumber: number
    feeWei: string
  }
}
function cooperativeCalldata(
  recovery: RecoveryPackage,
  signature: string,
): string {
  const binding = recovery.binding
  return new Interface(artifact.abi).encodeFunctionData(
    'closeCooperative(bytes32,uint256,uint256[2],address,address,bytes,bytes)',
    [
      binding.channelId,
      binding.seq,
      [BigInt(binding.principalWei), 0n],
      binding.payoutA,
      binding.payout1,
      recovery.bSignature,
      signature,
    ],
  )
}
async function observePublicEvm(
  record: PublicEvmObservation,
  endpoint: string,
) {
  const url = new URL(endpoint)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1', 'owned loopback observation only')
  assert.equal(record.version, 1)
  validateRecoveryPackage(record.recovery, record.expected)
  const binding = record.recovery.binding
  assert.equal(record.chainIdentifier, binding.evmChainIdentifier)
  assert.equal(record.contract, binding.contract)
  assert.equal(record.channelId, binding.channelId)
  const transaction = Transaction.from(record.signedRaw)
  assert.equal(transaction.hash, record.originalReceipt.hash)
  assert.equal(transaction.to, record.contract)
  assert.equal(transaction.chainId, BigInt(binding.nativeChainId))
  const signature = completeEvmFromObserved(
    record.recovery,
    record.expected,
    record.claimRaw,
  ).evmSignature
  assert.equal(record.authorization, signature)
  assert.equal(
    transaction.data,
    cooperativeCalldata(record.recovery, signature),
  )
  const provider = new JsonRpcProvider(
    endpoint,
    BigInt(binding.nativeChainId),
    { cacheTimeout: -1, batchMaxCount: 1 },
  )
  try {
    assert.equal(
      BigInt(await provider.send('eth_chainId', [])),
      BigInt(binding.nativeChainId),
    )
    assert.equal(
      (await provider.getBlock(binding.evmCheckpoint.height))?.hash,
      binding.evmCheckpoint.hash,
    )
    const receipt = await provider.getTransactionReceipt(
      record.originalReceipt.hash,
    )
    const block = receipt ? await provider.getBlock(receipt.blockNumber) : null
    const canonical = receipt !== null && block?.hash === receipt.blockHash
    const contract = new Contract(record.contract, artifact.abi, provider)
    return {
      state: canonical ? 'canonical' : 'observed/noncanonical',
      completionKnown: true,
      channelSettled: (
        await contract.getFunction('channels').staticCall(record.channelId)
      ).settled,
      contractBalanceWei: (
        await provider.getBalance(record.contract)
      ).toString(),
      currentReceipt: receipt
        ? {
            hash: receipt.hash,
            blockHash: receipt.blockHash,
            feeWei: receipt.fee.toString(),
          }
        : null,
    }
  } finally {
    provider.destroy()
  }
}
function replayEvmObservation(path: string, endpoint: string) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', __filename, '--evm-observe', path, endpoint],
    {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as Awaited<
    ReturnType<typeof observePublicEvm>
  >
}

export async function exerciseEvmSettlementReorg(input: {
  provider: JsonRpcProvider
  recovery: RecoveryPackage
  expected: ExpectedRecovery
  claimRaw: string
  snapshot: string
  originalReceipt: TransactionReceipt
  signedRaw: string
  directory: string
  opening: { hash: string; height: number }
  relayer: string
  balanceA: bigint
  balanceRelay: bigint
}) {
  const { provider, recovery, originalReceipt, signedRaw } = input
  const binding = recovery.binding
  const completion = completeEvmFromObserved(
    recovery,
    input.expected,
    input.claimRaw,
  )
  const calldata = cooperativeCalldata(recovery, completion.evmSignature)
  const transaction = Transaction.from(signedRaw)
  assert.equal(transaction.hash, originalReceipt.hash)
  assert.equal(transaction.chainId, BigInt(binding.nativeChainId))
  assert.equal(transaction.to, binding.contract)
  assert.equal(transaction.from, input.relayer)
  assert.equal(transaction.data, calldata)
  assert.equal(transaction.value, 0n)
  const oldBlock = await provider.getBlock(originalReceipt.blockNumber)
  assert.equal(oldBlock?.hash, originalReceipt.blockHash)
  const record = {
    version: 1,
    chainIdentifier: binding.evmChainIdentifier,
    channelId: binding.channelId,
    contract: binding.contract,
    signedRaw,
    authorization: completion.evmSignature,
    recovery,
    expected: input.expected,
    claimRaw: input.claimRaw,
    originalReceipt: {
      hash: originalReceipt.hash,
      blockHash: originalReceipt.blockHash,
      blockNumber: originalReceipt.blockNumber,
      feeWei: originalReceipt.fee.toString(),
    },
  }
  const observationFile = join(
    input.directory,
    'observed-public-evm-settlement.json',
  )
  persistPublic(observationFile, record)
  assert.equal(await provider.send('evm_revert', [input.snapshot]), true)
  const restartedObserver = replayEvmObservation(
    observationFile,
    provider._getConnection().url,
  )
  assert.equal(restartedObserver.state, 'observed/noncanonical')
  assert.equal(restartedObserver.currentReceipt, null)
  assert.equal(restartedObserver.completionKnown, true)
  assert.equal(restartedObserver.channelSettled, false)
  assert.equal(restartedObserver.contractBalanceWei, binding.principalWei)
  assert.equal(
    await provider.send('eth_getTransactionReceipt', [originalReceipt.hash]),
    null,
  )
  assert.equal(
    (await provider.getBlock(input.opening.height))?.hash,
    input.opening.hash,
  )
  const contract = new Contract(binding.contract, artifact.abi, provider)
  assert.equal(
    (await contract.getFunction('channels').staticCall(binding.channelId))
      .settled,
    false,
  )
  assert.equal(
    await provider.getBalance(binding.contract),
    BigInt(binding.principalWei),
  )
  assert.equal(await provider.getBalance(binding.payoutA), input.balanceA)
  assert.equal(await provider.getBalance(input.relayer), input.balanceRelay)
  assert.equal(
    await provider.getTransactionCount(input.relayer, 'pending'),
    transaction.nonce,
  )
  const disconnectedTip = await provider.getBlock('latest')
  assert.ok(
    disconnectedTip && disconnectedTip.number < originalReceipt.blockNumber,
  )
  await provider.send('evm_setNextBlockTimestamp', [oldBlock!.timestamp + 1])
  const repeated = await provider.broadcastTransaction(signedRaw)
  assert.equal(repeated.hash, originalReceipt.hash)
  const receipt = await repeated.wait()
  assert.ok(receipt && receipt.status === 1)
  assert.notEqual(receipt.blockHash, originalReceipt.blockHash)
  const block = await provider.getBlock(receipt.blockNumber)
  assert.equal(block?.hash, receipt.blockHash)
  assert.ok(block!.timestamp < binding.openingTimestamp + binding.duration)
  const ancestry: Array<{ hash: string; height: number; timestamp: number }> =
    []
  for (
    let height = input.opening.height;
    height <= receipt.blockNumber;
    height++
  ) {
    const header = await provider.getBlock(height)
    assert.ok(header?.hash)
    if (ancestry.length) assert.equal(header.parentHash, ancestry.at(-1)!.hash)
    ancestry.push({ hash: header.hash, height, timestamp: header.timestamp })
  }
  assert.equal(ancestry[0]!.hash, input.opening.hash)
  assert.equal(
    (await contract.getFunction('channels').staticCall(binding.channelId))
      .settled,
    true,
  )
  assert.equal(
    (await provider.getBalance(binding.payoutA)) - input.balanceA,
    BigInt(binding.principalWei),
  )
  assert.equal(
    (await provider.getBalance(input.relayer)) - input.balanceRelay,
    -receipt.fee,
  )
  const reincludedObserver = replayEvmObservation(
    observationFile,
    provider._getConnection().url,
  )
  assert.equal(reincludedObserver.state, 'canonical')
  assert.equal(reincludedObserver.channelSettled, true)
  assert.equal(reincludedObserver.currentReceipt?.blockHash, receipt.blockHash)
  return {
    receipt,
    timestamp: block!.timestamp,
    observation: {
      label:
        'EVM settlement disconnected and same signed transaction reincluded',
      restartedPublicObserver: restartedObserver,
      reincludedPublicObserver: reincludedObserver,
      ...record,
      disconnected: {
        state: 'observed/noncanonical',
        completionKnown: true,
        receipt: null,
        tip: { hash: disconnectedTip.hash, height: disconnectedTip.number },
      },
      reincluded: {
        hash: receipt.hash,
        blockHash: receipt.blockHash,
        height: receipt.blockNumber,
        feeWei: receipt.fee.toString(),
      },
      canonicalAncestry: ancestry,
      originalNonceRemainedValid: true,
      exactOriginalSignedRawReused: true,
      canonicalPrincipalWei: binding.principalWei,
      canonicalRelayerFeeWei: receipt.fee.toString(),
      orphanedFeeWeiExcludedFromCurrentTotals: originalReceipt.fee.toString(),
    },
  }
}

export async function runSettlementReorgProof(
  options: Parameters<typeof runNativeConditionalSuccess>[0],
) {
  return runNativeConditionalSuccess({
    ...options,
    scenario: 'settlement-reorg',
  })
}
export async function runDelayedObserverProof(
  options: Parameters<typeof runNativeConditionalSuccess>[0],
) {
  return runNativeConditionalSuccess({
    ...options,
    scenario: 'delayed-observer',
  })
}
if (require.main === module) {
  ;(async () => {
    const mode = process.argv[2],
      path = process.argv[3]
    assert.ok(path, 'explicit public observation file required')
    if (mode === '--public-replay') {
      const value = JSON.parse(
        readFileSync(path, 'utf8'),
      ) as PublicClaimObservation
      validateClaimObservation(value)
      process.stdout.write(
        JSON.stringify(
          completeEvmFromObserved(
            value.recovery,
            value.expected,
            value.claimRaw,
          ),
        ),
      )
    } else if (mode === '--evm-observe' && process.argv[4]) {
      const value = JSON.parse(
        readFileSync(path, 'utf8'),
      ) as PublicEvmObservation
      process.stdout.write(
        JSON.stringify(await observePublicEvm(value, process.argv[4])),
      )
    } else throw new Error('explicit public observation mode required')
  })().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
