/** Exact signed Forum authority. Wallet construction is shared with stamps and stealth. */
import axios from 'axios'
import { Transaction, getAddress, getBytes, hexlify, randomBytes } from 'ethers'
import {
  defaultContext,
  validateFrame,
  topicBurnCommitment,
  topicVoteCommitment,
  topicBurnCalldata,
  matchForumOperation,
  encodeTopicPostSubmission,
  encodeTopicVote,
  TYPE_TOPIC_POST_SUBMISSION,
  TYPE_TOPIC_POST,
  TYPE_TOPIC_VOTE_SUBMISSION,
} from '@frank/codec'
import type { ForumOperationStatus, ParsedFrame } from '@frank/codec'
import type { EvmWalletHandle } from './evm-wallet-handle'
import type { MonadWalletOperationAdmission } from './storage/evm-wallet-bundle'
import type {
  OutgoingTopicOperation,
  RetainedTopicOperation,
} from './storage/topic-operation-journal'
import type { EvmCoinList } from './evm-coin-list'
import { nativeMemberSuperseded } from './storage/evm-native-operation-journal'

export type MatchedForumStatus = ForumOperationStatus<ParsedFrame>
export const MAX_FORUM_BURN = (1n << 63n) - 1n
export function assertForumAmount(value: bigint): void {
  if (value < 1n || value > MAX_FORUM_BURN)
    throw new Error('Forum burn must be 1..i64::MAX wei')
}
export function classifyForumOperation(
  operation: OutgoingTopicOperation | RetainedTopicOperation,
): 'canonical' | 'unsupported-retained' {
  return operation.writeFormat === 'forum-cbor'
    ? 'canonical'
    : 'unsupported-retained'
}
const equalHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const bare = (bytes: Uint8Array) => hexlify(bytes).slice(2)
const addressEqual = (a: string | null | undefined, b: string) =>
  !!a && getAddress(a) === getAddress(b)

export function requireForumWallet(wallet: EvmWalletHandle): void {
  if (
    !wallet.walletState ||
    !wallet.topicOperationJournal ||
    wallet.walletState.topicOperationJournal !== wallet.topicOperationJournal ||
    !wallet.cborNetwork ||
    !wallet.forumBurnAddress ||
    !wallet.forumChainId ||
    !wallet.transactionSetPreparer ||
    !wallet.transactionSetLifecycle ||
    !wallet.transactionSetSubmission ||
    !wallet.forumOperationMutation
  )
    throw new Error(
      'Forum operations require coherent durable wallet and shared native preparation with explicit network/chain/burn policy',
    )
  getAddress(wallet.forumBurnAddress)
}

/** Pure authority binding before transport or any chain repair. */
export function bindForumAuthority(
  wallet: EvmWalletHandle,
  operation: OutgoingTopicOperation,
) {
  if (classifyForumOperation(operation) !== 'canonical')
    throw new Error('Unsupported retained Forum operation format')
  if (operation.construction)
    throw new Error('Forum construction is not yet a signed request')
  requireForumWallet(wallet)
  const request = Uint8Array.from(operation.requestBytes)
  const parsed = validateFrame(request, defaultContext())
  if (parsed.kind !== 'parsed')
    throw new Error('Invalid retained Forum request')
  const typed = parsed.typed
  let target: Uint8Array, burns: readonly Uint8Array[]
  if (operation.kind === 'post' && typed?.type === TYPE_TOPIC_POST_SUBMISSION) {
    if (
      typed.postFrame.typed?.type !== TYPE_TOPIC_POST ||
      typed.postFrame.schemaVersion !== 2 ||
      operation.direction !== 'up'
    )
      throw new Error('Invalid canonical Forum post')
    target = topicBurnCommitment(typed.postFrame.frame).hash
    burns = [typed.burnTx]
  } else if (
    operation.kind === 'vote' &&
    typed?.type === TYPE_TOPIC_VOTE_SUBMISSION
  ) {
    target = typed.targetHash
    burns = [typed.burnTx]
  } else throw new Error('Forum journal family mismatch')
  const expectedTarget =
    operation.kind === 'post'
      ? operation.payloadHashHex
      : operation.targetPayloadHashHex
  const commitment = topicVoteCommitment(wallet.cborNetwork!, target)
  const expectedData = hexlify(
    topicBurnCalldata(operation.direction, commitment),
  )
  const journal = wallet.transactionSetPreparer!.getOperation(
    operation.transactionSetOperationId,
  )
  const members = journal?.members.filter(
    member => member.transactionSet?.role === 'payment',
  )
  const transactions = operation.rawTransactions.map(raw =>
    Transaction.from(raw),
  )
  assertForumAmount(BigInt(operation.intendedValueWei))
  assertForumAmount(BigInt(operation.valueWei))
  if (
    !journal ||
    journal.cancelled ||
    journal.binding.chainIdentifier !== wallet.cborNetwork ||
    journal.intendedValueWei !== operation.intendedValueWei ||
    !members ||
    members.length !== transactions.length ||
    typed.network !== wallet.cborNetwork ||
    bare(target) !== expectedTarget ||
    transactions.length !== 1 ||
    transactions.length !== burns.length ||
    transactions.length !== operation.funders.length ||
    transactions.some(
      (transaction, index) =>
        !transaction.isSigned() ||
        !transaction.hash ||
        !addressEqual(transaction.from, operation.funders[index]!) ||
        transaction.chainId !== wallet.forumChainId ||
        !addressEqual(transaction.to, wallet.forumBurnAddress!) ||
        !equalHex(transaction.data, expectedData) ||
        !equalHex(transaction.serialized, hexlify(burns[index]!)) ||
        !equalHex(
          members[index]!.signed?.rawTransaction ?? '',
          transaction.serialized,
        ),
    ) ||
    transactions.reduce((sum, tx) => sum + tx.value, 0n).toString() !==
      operation.valueWei ||
    BigInt(operation.valueWei) < BigInt(operation.intendedValueWei) ||
    !equalHex(transactions[0]!.hash!, operation.transactionSetHash)
  )
    throw new Error('Invalid durable Forum signed authority')
  return { request, target, transactions, journal }
}

/** Released v1 authority belongs to its original lease and scalar signed request. */
export function bindRetainedForumAuthority(
  wallet: EvmWalletHandle,
  operation: RetainedTopicOperation,
) {
  requireForumWallet(wallet)
  if (classifyForumOperation(operation) !== 'canonical')
    throw new Error('Unsupported retained Forum operation')
  if (
    wallet.walletState!.pool !== wallet.pool ||
    wallet.walletState!.leaseManager !== wallet.leaseManager
  )
    throw new Error('Retained Forum custody mismatch')
  const request = Uint8Array.from(operation.requestBytes)
  const parsed = validateFrame(request, defaultContext())
  if (parsed.kind !== 'parsed')
    throw new Error('Invalid retained Forum request')
  const typed = parsed.typed
  let target: Uint8Array, burn: Uint8Array
  if (operation.kind === 'post' && typed?.type === TYPE_TOPIC_POST_SUBMISSION) {
    if (
      typed.postFrame.typed?.type !== TYPE_TOPIC_POST ||
      typed.postFrame.schemaVersion !== 2 ||
      operation.direction !== 'up'
    )
      throw new Error('Invalid retained Forum post')
    target = topicBurnCommitment(typed.postFrame.frame).hash
    burn = typed.burnTx
  } else if (
    operation.kind === 'vote' &&
    typed?.type === TYPE_TOPIC_VOTE_SUBMISSION
  ) {
    target = typed.targetHash
    burn = typed.burnTx
  } else throw new Error('Retained Forum journal family mismatch')
  const transaction = Transaction.from(operation.rawTx)
  const record = wallet.pool.getRecord(operation.leaseIndex)
  const targetHash =
    operation.kind === 'post'
      ? operation.payloadHashHex
      : operation.targetPayloadHashHex
  const expectedData = hexlify(
    topicBurnCalldata(
      operation.direction,
      topicVoteCommitment(wallet.cborNetwork!, target),
    ),
  )
  assertForumAmount(BigInt(operation.valueWei))
  // Current lease hydration can retire an old in-use row. Retirement alone proves nothing;
  // recovery still requires the original signed authority and exact successful chain evidence.
  if (
    typed.network !== wallet.cborNetwork ||
    bare(target) !== targetHash ||
    !transaction.isSigned() ||
    !transaction.hash ||
    !equalHex(transaction.hash, operation.txHash) ||
    !addressEqual(transaction.from, operation.senderAddress) ||
    !record ||
    !addressEqual(record.address, operation.senderAddress) ||
    (record.status !== 'in-use' &&
      record.status !== 'spent' &&
      record.status !== 'retired') ||
    transaction.chainId !== wallet.forumChainId ||
    !addressEqual(transaction.to, wallet.forumBurnAddress!) ||
    transaction.value.toString() !== operation.valueWei ||
    !equalHex(transaction.data, expectedData) ||
    !equalHex(hexlify(burn), operation.rawTx) ||
    !equalHex(transaction.serialized, operation.rawTx)
  )
    throw new Error('Invalid retained Forum signed authority')
  const spend = record.lifecycle?.spend
  if (
    spend &&
    (!equalHex(spend.rawTx, operation.rawTx) ||
      !equalHex(spend.txHash, operation.txHash) ||
      spend.valueWei !== operation.valueWei)
  )
    throw new Error('Retained Forum operation differs from lease spend')
  return { request, target, transactions: [transaction], record }
}

/** Composition supplies the wallet's existing inventory; recovery never opens another store. */
export async function observeRetainedForumSpend(
  wallet: EvmWalletHandle,
  coins: EvmCoinList,
  rawTx: string,
  spendSpacingBlocks = 0,
): Promise<void> {
  const operation = wallet.topicOperationJournal
    ?.getRetainedLegacy?.()
    .find(row => row.writeFormat === 'forum-cbor' && equalHex(row.rawTx, rawTx))
  if (!operation) throw new Error('Unknown retained Forum signed authority')
  const bound = bindRetainedForumAuthority(wallet, operation)
  const tx = bound.transactions[0]!,
    account = tx.from!.toLowerCase()
  if ((await wallet.provider.getNetwork()).chainId !== wallet.forumChainId)
    throw new Error('Forum provider chain mismatch')
  const [receipt, observed, head] = await Promise.all([
    wallet.provider.getTransactionReceipt(tx.hash!),
    wallet.provider.getTransaction(tx.hash!),
    wallet.provider.getBlock('latest'),
  ])
  if (
    !receipt ||
    receipt.status !== 1 ||
    !observed ||
    Transaction.from(observed).serialized !== tx.serialized ||
    !equalHex(receipt.hash, tx.hash!) ||
    !addressEqual(receipt.from, account) ||
    !addressEqual(receipt.to, wallet.forumBurnAddress!) ||
    observed.blockHash !== receipt.blockHash ||
    observed.blockNumber !== receipt.blockNumber ||
    observed.index !== receipt.index ||
    !head?.hash ||
    head.number < receipt.blockNumber
  )
    throw new ForumOperationPendingError(
      'Retained Forum native inclusion is not established',
    )
  const [balance, nonce, checkpoint, included] = await Promise.all([
    wallet.provider.getBalance(account, head.number),
    wallet.provider.getTransactionCount(account, head.number),
    wallet.provider.getBlock(head.number),
    wallet.provider.getBlock(receipt.blockNumber),
  ])
  if (
    checkpoint?.hash !== head.hash ||
    included?.hash !== receipt.blockHash ||
    nonce <= tx.nonce
  )
    throw new ForumOperationPendingError(
      'Retained Forum account observation is not canonical',
    )
  const reference = `retained-forum:${tx.hash!}`
  await coins.projectTransactionSetAccount(account, reference, async writer => {
    const original = coins.get(account, tx.nonce)
    if (original?.spendingTx && !equalHex(original.spendingTx, rawTx))
      throw new Error(
        'Retained Forum source conflicts with shared signed authority',
      )
    if (original?.state !== 'spent') {
      await coins.restoreHeld(reference, {
        account,
        nonce: tx.nonce,
        privateKey:
          original?.privateKey ??
          wallet.pool.privateKeyOf(operation.leaseIndex),
        origin: original?.origin ?? 'deterministic',
        rawTx,
      })
      await writer.recordMined(
        { account, nonce: tx.nonce },
        { block: receipt.blockNumber },
      )
    }
    const latest = coins.latestOf(account)
    if (latest && latest.nonce > nonce)
      throw new ForumOperationPendingError(
        'Retained Forum account observation is stale',
      )
    await writer.put({
      account,
      nonce,
      valueWei: balance,
      privateKey:
        original?.privateKey ?? wallet.pool.privateKeyOf(operation.leaseIndex),
      origin: original?.origin ?? 'deterministic',
      ...(original?.changeIndex === undefined
        ? {}
        : { changeIndex: original.changeIndex }),
      lastSpentInBlock: head.number,
      ...(spendSpacingBlocks > 0
        ? { spendableFromBlock: head.number + spendSpacingBlocks }
        : {}),
    })
    return true
  })
  coins.completeTransactionSetProjection(account, reference)
}

const retainedRecovery = new WeakMap<
  EvmWalletHandle,
  Map<string, Promise<void>>
>()
function reconcileRetainedForumOperation(
  wallet: EvmWalletHandle,
  operation: RetainedTopicOperation,
): Promise<void> {
  let pending = retainedRecovery.get(wallet)
  if (!pending) {
    pending = new Map()
    retainedRecovery.set(wallet, pending)
  }
  const existing = pending.get(operation.txHash)
  if (existing) return existing
  const run = (async () => {
    if (
      !wallet.observeRetainedForumSpend ||
      !wallet.topicOperationJournal!.deleteRetained
    )
      throw new Error('Retained Forum observation capability unavailable')
    const bound = bindRetainedForumAuthority(wallet, operation)
    if ((await wallet.provider.getNetwork()).chainId !== wallet.forumChainId)
      throw new Error('Forum provider chain mismatch')
    if (!bound.record.lifecycle?.spend)
      await wallet.forumOperationMutation!(async () => {
        bindRetainedForumAuthority(wallet, operation)
        wallet.pool.recordSpendTransaction(operation.leaseIndex, {
          rawTx: operation.rawTx,
          txHash: operation.txHash,
          valueWei: operation.valueWei,
        })
        await wallet.pool.flush()
      })
    try {
      await exchange(wallet, operation, 'post')
    } catch {
      await exchange(wallet, operation, 'put')
    }
    await wallet.observeRetainedForumSpend(operation.rawTx)
    await wallet.forumOperationMutation!(async () => {
      bindRetainedForumAuthority(wallet, operation)
      wallet.pool.setStatus(operation.leaseIndex, 'spent')
      await wallet.pool.flush()
      await wallet.topicOperationJournal!.deleteRetained!(operation)
    })
  })().finally(() => pending!.delete(operation.txHash))
  pending.set(operation.txHash, run)
  return run
}

export class ForumOperationPendingError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
  }
}

/** A relay response is diagnostic only; it never authorizes another payment. */
class ForumRelayResponseError extends Error {
  constructor(
    readonly status: number,
    readonly cause: unknown,
    readonly code?: string,
    readonly detail?: string,
  ) {
    super(
      `Forum relay HTTP ${status}${code ? ` (${code})` : ''}${
        detail ? `: ${detail}` : ''
      }. Original operation retained; receipt verification may still be pending.`,
    )
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function forumRelayError(cause: unknown): unknown {
  const response = record(record(cause)?.response)
  const status = response?.status
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 400 ||
    status > 599
  )
    return cause
  const fallback = new ForumRelayResponseError(status, cause)
  const media = record(response?.headers)?.['content-type']
  if (
    typeof media !== 'string' ||
    media.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    return fallback
  const data = response?.data
  // Axios browser responses use ArrayBuffer; Node Buffer is a Uint8Array view.
  // Respect a view's offset/length and bound bytes before decoding or parsing.
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data instanceof Uint8Array
      ? data
      : undefined
  if (!bytes || bytes.byteLength > 4096) return fallback
  try {
    const body = record(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    )
    const code = body?.error
    const detail = body?.detail
    if (
      typeof code !== 'string' ||
      !/^[a-z][a-z0-9_]{0,79}$/.test(code) ||
      typeof detail !== 'string' ||
      detail.length > 1024
    )
      return fallback
    const safeDetail = detail
      .replace(/https?:\/\/[^\s]+/gi, '[URL redacted]')
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
      .trim()
      .slice(0, 1024)
    return new ForumRelayResponseError(status, cause, code, safeDetail)
  } catch {
    return fallback
  }
}

async function exchange(
  wallet: EvmWalletHandle,
  operation: OutgoingTopicOperation | RetainedTopicOperation,
  method: 'put' | 'post',
): Promise<MatchedForumStatus> {
  const bound =
    operation.version === 1
      ? bindRetainedForumAuthority(wallet, operation)
      : bindForumAuthority(wallet, operation)
  if ((await wallet.provider.getNetwork()).chainId !== wallet.forumChainId)
    throw new Error('Forum provider chain mismatch')
  const response = await axios({
    method,
    url: `${wallet.relayBaseUrl.replace(/\/+$/, '')}/message/monad/topics${
      method === 'post' ? '/status' : operation.kind === 'vote' ? '/vote' : ''
    }`,
    data: bound.request,
    headers: {
      'Content-Type': 'application/cbor',
      Accept: 'application/cbor',
    },
    responseType: 'arraybuffer',
    maxContentLength: 4 * 1024 * 1024,
    maxBodyLength: 4 * 1024 * 1024,
  }).catch((cause: unknown) => {
    throw forumRelayError(cause)
  })
  const bytes = new Uint8Array(response.data)
  if (
    bytes.length > 4 * 1024 * 1024 ||
    String(response.headers?.['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase() !== 'application/cbor'
  )
    throw new Error('Invalid Forum status media or size')
  const status = matchForumOperation(bytes, {
    network: wallet.cborNetwork!,
    submittedFrame: bound.request,
    targetHash: bound.target,
    transactionHash: getBytes(bound.transactions[0]!.hash!),
    sender: getBytes(bound.transactions[0]!.from!),
    direction: operation.direction === 'up' ? 1 : 0,
    value: BigInt(operation.valueWei),
  })
  if (status.state !== 2)
    throw new ForumOperationPendingError('Forum operation remains unconfirmed')
  let lastBlock = -1n,
    lastIndex = -1n
  for (const transaction of bound.transactions) {
    const [receipt, observed] = await Promise.all([
      wallet.provider.getTransactionReceipt(transaction.hash!),
      wallet.provider.getTransaction(transaction.hash!),
    ])
    if (
      !receipt ||
      receipt.status !== 1 ||
      !equalHex(receipt.hash, transaction.hash!) ||
      !addressEqual(receipt.from, transaction.from!) ||
      !addressEqual(receipt.to, wallet.forumBurnAddress!) ||
      !observed ||
      !equalHex(observed.hash, transaction.hash!) ||
      !addressEqual(observed.from, transaction.from!) ||
      !addressEqual(observed.to, wallet.forumBurnAddress!) ||
      observed.chainId !== wallet.forumChainId ||
      observed.value !== transaction.value ||
      !equalHex(observed.data, transaction.data) ||
      observed.blockNumber !== receipt.blockNumber ||
      observed.index !== receipt.index
    )
      throw new ForumOperationPendingError(
        'Forum status lacks every matching successful transaction observation',
      )
    if (
      operation.version === 1 &&
      (Transaction.from(observed).serialized !== transaction.serialized ||
        (
          await wallet.provider.getBlock(receipt.blockNumber)
        )?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase())
    )
      throw new ForumOperationPendingError(
        'Retained Forum receipt lacks exact canonical signed transaction evidence',
      )
    const block = BigInt(receipt.blockNumber),
      index = BigInt(receipt.index)
    if (block > lastBlock || (block === lastBlock && index > lastIndex)) {
      lastBlock = block
      lastIndex = index
    }
  }
  if (lastBlock !== status.block || lastIndex !== status.transactionIndex)
    throw new ForumOperationPendingError(
      'Forum status has a different transaction-set inclusion watermark',
    )
  return status
}

/** A relay can broadcast every byte it receives, so funding must settle before handoff. */
async function prepareForumHandoff(
  wallet: EvmWalletHandle,
  operation: OutgoingTopicOperation,
): Promise<void> {
  try {
    await wallet.transactionSetSubmission!.sendTransaction(
      wallet.transactionSetPreparer!.getTransactionSet(
        operation.transactionSetOperationId,
      ),
    )
    if (
      !wallet.transactionSetLifecycle!.canSubmitPayments(
        operation.transactionSetOperationId,
      )
    )
      throw new ForumOperationPendingError(
        'Forum funding is pending the selected network confirmation delay',
      )
  } catch (error) {
    if (error instanceof ForumOperationPendingError) throw error
    throw new ForumOperationPendingError(
      'Forum funding retained pending reconciliation',
      error,
    )
  }
}

async function settle(
  wallet: EvmWalletHandle,
  operation: OutgoingTopicOperation,
): Promise<void> {
  await wallet.transactionSetSubmission!.sendTransaction(
    wallet.transactionSetPreparer!.getTransactionSet(
      operation.transactionSetOperationId,
    ),
  )
  const journal = wallet.transactionSetPreparer!.getOperation(
    operation.transactionSetOperationId,
  )!
  if (
    journal.members.every(
      member =>
        member.observation.state === 'included-success' ||
        member.observation.state === 'included-revert' ||
        nativeMemberSuperseded(member),
    )
  )
    await wallet.forumOperationMutation!(() =>
      wallet.topicOperationJournal!.delete(operation),
    )
}

export async function reconcileForumOperations(
  wallet: EvmWalletHandle,
  kind: 'post' | 'vote',
  admission?: MonadWalletOperationAdmission,
): Promise<void> {
  requireForumWallet(wallet)
  await wallet.refreshTransactionSetInventory?.()
  return wallet.walletState!.runLifetime(async () => {
    const results = await Promise.allSettled([
      ...(wallet.topicOperationJournal!.getRetainedLegacy?.() ?? [])
        .filter(
          operation =>
            operation.kind === kind &&
            classifyForumOperation(operation) === 'canonical',
        )
        .map(operation => reconcileRetainedForumOperation(wallet, operation)),
      ...wallet
        .topicOperationJournal!.getAll()
        .filter(retained => retained.kind === kind)
        .map(async retained => {
          const operation = await finishForumConstruction(wallet, retained)
          bindForumAuthority(wallet, operation)
          await prepareForumHandoff(wallet, operation)
          try {
            await exchange(wallet, operation, 'post')
          } catch {
            await exchange(wallet, operation, 'put')
          }
          await settle(wallet, operation)
        }),
    ])
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  })
}

interface ForumSubmissionParams {
  kind: 'post' | 'vote'
  target: Uint8Array
  direction: 'up' | 'down'
  burnAddress: string
  value: bigint
  operationId?: string
  postFrame?: Uint8Array
}

async function finishForumConstruction(
  wallet: EvmWalletHandle,
  retained: OutgoingTopicOperation,
): Promise<OutgoingTopicOperation> {
  const intent = retained.construction
  if (!intent) return retained
  if (!addressEqual(intent.burnAddress, wallet.forumBurnAddress!))
    throw new Error('Retained Forum burn policy mismatch')
  const target = getBytes(
    '0x' +
      (retained.kind === 'post'
        ? retained.payloadHashHex
        : retained.targetPayloadHashHex),
  )
  const commitment = topicVoteCommitment(wallet.cborNetwork!, target)
  const calldata = hexlify(topicBurnCalldata(retained.direction, commitment))
  const prepared =
    await wallet.transactionSetPreparer!.constructLegacyTransactionSet({
      operationId: retained.transactionSetOperationId,
      amountWei: BigInt(retained.intendedValueWei),
      kdf: () => intent.burnAddress,
      calldata,
    })
  if (prepared.bundle.length !== 1)
    throw new Error('Forum requires exactly one burn transaction')
  const raw = getBytes(prepared.bundle[0]!.rawTransaction)
  const { construction: _construction, ...kept } = retained
  const operation: OutgoingTopicOperation = {
    ...kept,
    requestBytes: Array.from(
      retained.kind === 'post'
        ? encodeTopicPostSubmission(getBytes('0x' + intent.postFrameHex!), raw)
        : encodeTopicVote(wallet.cborNetwork!, target, raw),
    ),
    funders: prepared.bundle.map(tx => tx.sourceAccount),
    rawTransactions: prepared.bundle.map(tx => tx.rawTransaction),
    transactionSetHash: prepared.bundle[0]!.txHash,
    valueWei: prepared.bundle
      .reduce((sum, tx) => sum + tx.valueWei, 0n)
      .toString(),
  }
  bindForumAuthority(wallet, operation)
  await wallet.forumOperationMutation!(() =>
    wallet.topicOperationJournal!.put(operation),
  )
  return operation
}

async function submitForumOperationAdmitted(
  wallet: EvmWalletHandle,
  params: ForumSubmissionParams,
): Promise<{ operation: OutgoingTopicOperation; status: MatchedForumStatus }> {
  requireForumWallet(wallet)
  assertForumAmount(params.value)
  if (!addressEqual(params.burnAddress, wallet.forumBurnAddress!))
    throw new Error('Forum burn policy mismatch')
  if (params.kind === 'post' && !params.postFrame)
    throw new Error('Forum post requires its complete public frame')
  // Persist the complete public payload and intended burn before the wallet reserves or signs.
  const intent = {
    version: 2 as const,
    kind: params.kind,
    writeFormat: 'forum-cbor' as const,
    requestBytes: [],
    transactionSetOperationId:
      params.operationId ?? `forum-${hexlify(randomBytes(16)).slice(2)}`,
    construction: {
      burnAddress: params.burnAddress,
      ...(params.postFrame ? { postFrameHex: bare(params.postFrame) } : {}),
    },
    funders: [],
    rawTransactions: [],
    transactionSetHash: '',
    intendedValueWei: params.value.toString(),
    valueWei: params.value.toString(),
    direction: params.direction,
    ...(params.kind === 'post'
      ? { payloadHashHex: bare(params.target) }
      : { targetPayloadHashHex: bare(params.target) }),
  } as OutgoingTopicOperation
  const prior =
    params.operationId === undefined
      ? undefined
      : wallet
          .topicOperationJournal!.getAll()
          .find(row => row.transactionSetOperationId === params.operationId)
  if (prior) {
    const target =
      prior.kind === 'post' ? prior.payloadHashHex : prior.targetPayloadHashHex
    if (
      prior.kind !== params.kind ||
      prior.direction !== params.direction ||
      prior.intendedValueWei !== params.value.toString() ||
      target !== bare(params.target)
    )
      throw new Error(
        'Forum operation identity conflicts with its original intent',
      )
  }
  // Once persistence is attempted, even a failed acknowledgement may leave an accepted
  // intent. Construction failures must retain the caller's duplicate barrier: recovery
  // can still fund and submit this original operation when funds become available.
  try {
    if (!prior)
      await wallet.forumOperationMutation!(() =>
        wallet.topicOperationJournal!.put(intent),
      )
    const operation = await finishForumConstruction(wallet, prior ?? intent)
    // Every signed byte and its original public payload are durable before external handoff.
    await prepareForumHandoff(wallet, operation)
    const status = await exchange(wallet, operation, 'put')
    await settle(wallet, operation)
    return { operation, status }
  } catch (error) {
    throw new ForumOperationPendingError(
      `Forum operation retained pending: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    )
  }
}

export async function submitForumOperation(
  wallet: EvmWalletHandle,
  params: ForumSubmissionParams,
  admission?: MonadWalletOperationAdmission,
): Promise<{ operation: OutgoingTopicOperation; status: MatchedForumStatus }> {
  requireForumWallet(wallet)
  await wallet.refreshTransactionSetInventory?.()
  return wallet.walletState!.runLifetime(() =>
    submitForumOperationAdmitted(wallet, params),
  )
}
