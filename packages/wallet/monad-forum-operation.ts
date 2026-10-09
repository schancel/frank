/** Exact signed Forum authority. Codec matching compares claims; this module checks chain facts. */
import axios from 'axios'
import { Transaction, getAddress, getBytes, hexlify } from 'ethers'
import {
  defaultContext,
  validateFrame,
  topicBurnCommitment,
  topicVoteCommitment,
  topicBurnCalldata,
  matchForumOperation,
} from '@frank/codec'
import type { ForumOperationStatus, ParsedFrame } from '@frank/codec'
import type { EvmWalletHandle } from "./evm-wallet-handle";
import type { MonadWalletOperationAdmission } from './storage/monad-wallet-bundle'
import type { OutgoingTopicOperation } from './storage/topic-operation-journal'
import {
  acquireLeaseWhenAvailable,
  BurnNotSentError,
} from './monad-account-lease'
import type {
  AcquireLeaseWhenAvailableOptions,
  AccountLeaseHandle,
} from './monad-account-lease'
import type { MonadTxOverrides } from './monad-account-tx'
import type { MonadAddressInventory } from './monad-address-inventory'

export type MatchedForumStatus = ForumOperationStatus<ParsedFrame>
export const MAX_FORUM_BURN = (1n << 63n) - 1n
export function assertForumAmount(value: bigint): void {
  if (value < 1n || value > MAX_FORUM_BURN)
    throw new Error('Forum burn must be 1..i64::MAX wei')
}
export function classifyForumOperation(
  operation: OutgoingTopicOperation,
): 'canonical' | 'unsupported-retained' {
  return operation.writeFormat === 'forum-cbor'
    ? 'canonical'
    : 'unsupported-retained'
}
const equalHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const bare = (b: Uint8Array) => hexlify(b).slice(2)
const addressEqual = (a: string | null | undefined, b: string) =>
  !!a && getAddress(a) === getAddress(b)

export function requireForumWallet(wallet: EvmWalletHandle): void {
  if (
    !wallet.walletState ||
    !wallet.topicOperationJournal ||
    wallet.walletState.topicOperationJournal !== wallet.topicOperationJournal ||
    wallet.walletState.pool !== wallet.pool ||
    wallet.walletState.leaseManager !== wallet.leaseManager ||
    !wallet.cborNetwork ||
    !wallet.forumBurnAddress ||
    !wallet.forumChainId
  ) {
    throw new Error(
      'Forum operations require coherent durable wallet and explicit network/chain/burn policy',
    )
  }
  getAddress(wallet.forumBurnAddress)
}

/** Must be called before any transport or spend checkpoint repair. */
export function bindForumAuthority(
  wallet: EvmWalletHandle,
  operation: OutgoingTopicOperation,
) {
  if (classifyForumOperation(operation) !== 'canonical')
    throw new Error('Unsupported retained Forum operation')
  requireForumWallet(wallet)
  const request = Uint8Array.from(operation.requestBytes)
  const parsed = validateFrame(request, defaultContext())
  if (parsed.kind !== 'parsed')
    throw new Error('Invalid retained Forum request')
  const typed = parsed.typed
  let target: Uint8Array
  let burn: Uint8Array
  if (operation.kind === 'post' && typed?.type === 10) {
    if (
      typed.postFrame.typed?.type !== 9 ||
      typed.postFrame.schemaVersion !== 2 ||
      operation.direction !== 'up'
    )
      throw new Error('Invalid canonical Forum post')
    target = topicBurnCommitment(typed.postFrame.frame).hash
    burn = typed.burnTx
  } else if (operation.kind === 'vote' && typed?.type === 11) {
    target = typed.targetHash
    burn = typed.burnTx
  } else throw new Error('Forum journal family mismatch')
  const transaction = Transaction.from(operation.rawTx)
  const record = wallet.pool.getRecord(operation.leaseIndex)
  const hash =
    operation.kind === 'post'
      ? operation.payloadHashHex
      : operation.targetPayloadHashHex
  assertForumAmount(BigInt(operation.valueWei))
  const expectedData = hexlify(
    topicBurnCalldata(
      operation.direction,
      topicVoteCommitment(wallet.cborNetwork!, target),
    ),
  )
  if (
    typed.network !== wallet.cborNetwork ||
    bare(target) !== hash ||
    !transaction.isSigned() ||
    !transaction.hash ||
    !equalHex(transaction.hash, operation.txHash) ||
    !addressEqual(transaction.from, operation.senderAddress) ||
    !record ||
    !addressEqual(record.address, operation.senderAddress) ||
    transaction.chainId !== wallet.forumChainId ||
    !addressEqual(transaction.to, wallet.forumBurnAddress!) ||
    transaction.value.toString() !== operation.valueWei ||
    !equalHex(transaction.data, expectedData) ||
    !equalHex(hexlify(burn), operation.rawTx) ||
    !equalHex(transaction.serialized, operation.rawTx)
  ) {
    throw new Error('Invalid durable Forum signed authority')
  }
  const spend = record.lifecycle?.spend
  if (
    spend &&
    (!equalHex(spend.rawTx, operation.rawTx) ||
      !equalHex(spend.txHash, operation.txHash) ||
      spend.valueWei !== operation.valueWei)
  )
    throw new Error('Forum operation differs from retained lease spend')
  if (record.status !== 'in-use' && record.status !== 'spent')
    throw new Error('Forum operation lease is not recoverable')
  return { request, target, transaction, record }
}

export class ForumOperationPendingError extends Error {}

async function exchange(
  wallet: EvmWalletHandle,
  operation: OutgoingTopicOperation,
  method: 'put' | 'post',
): Promise<MatchedForumStatus> {
  const bound = bindForumAuthority(wallet, operation)
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
      'Accept': 'application/cbor',
    },
    responseType: 'arraybuffer',
    maxContentLength: 4 * 1024 * 1024,
    maxBodyLength: 4 * 1024 * 1024,
  })
  const bytes = new Uint8Array(response.data)
  if (
    bytes.length > 4 * 1024 * 1024 ||
    String(response.headers?.['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase() !== 'application/cbor'
  )
    throw new Error('Invalid Forum status media or size')
  const status = matchForumOperation(bytes, {
    network: wallet.cborNetwork!,
    submittedFrame: bound.request,
    targetHash: bound.target,
    transactionHash: getBytes(operation.txHash),
    sender: getBytes(operation.senderAddress),
    direction: operation.direction === 'up' ? 1 : 0,
    value: BigInt(operation.valueWei),
  })
  if (status.state !== 2)
    throw new ForumOperationPendingError('Forum operation remains unconfirmed')
  // Successful exact receipt observation is the existing confirmation policy; no depth is inferred.
  const receipt = await wallet.provider.getTransactionReceipt(operation.txHash)
  const observed = await wallet.provider.getTransaction(operation.txHash)
  if (
    !receipt ||
    receipt.status !== 1 ||
    !equalHex(receipt.hash, operation.txHash) ||
    !addressEqual(receipt.from, operation.senderAddress) ||
    !addressEqual(receipt.to, wallet.forumBurnAddress!) ||
    BigInt(receipt.blockNumber) !== status.block ||
    BigInt(receipt.index) !== status.transactionIndex ||
    !observed ||
    !equalHex(observed.hash, operation.txHash) ||
    !addressEqual(observed.from, operation.senderAddress) ||
    !addressEqual(observed.to, wallet.forumBurnAddress!) ||
    observed.chainId !== wallet.forumChainId ||
    observed.value !== bound.transaction.value ||
    !equalHex(observed.data, bound.transaction.data) ||
    observed.blockNumber === null ||
    BigInt(observed.blockNumber) !== status.block ||
    BigInt(observed.index) !== status.transactionIndex
  ) {
    throw new ForumOperationPendingError(
      'Forum status lacks matching successful transaction observation',
    )
  }
  return status
}

async function settle(
  wallet: EvmWalletHandle,
  operation: OutgoingTopicOperation,
  admission?: MonadWalletOperationAdmission,
  handle?: AccountLeaseHandle,
) {
  const bound = bindForumAuthority(wallet, operation)
  const inventory = wallet.inventory ?? wallet.walletState?.inventory
  if (bound.record.status === 'in-use') {
    if (handle) wallet.leaseManager.releaseLease(handle, 'confirmed')
    else wallet.pool.setStatus(operation.leaseIndex, 'spent')
    await wallet.leaseManager.flush()
  }
  inventory?.recordSpend(operation.senderAddress, {
    txHash: operation.txHash,
    valueWei: BigInt(operation.valueWei),
  })
  await wallet.topicOperationJournal!.delete(operation)
  if (admission) await wallet.walletState!.compactTerminalAccounts(8, admission)
}

export async function reconcileForumOperations(
  wallet: EvmWalletHandle,
  kind: 'post' | 'vote',
  admission?: MonadWalletOperationAdmission,
): Promise<void> {
  requireForumWallet(wallet)
  return wallet.walletState!.runOperation(async admitted => {
    for (const operation of wallet.topicOperationJournal!.getAll()) {
      // Historical authority is retained, including terminal rows, before decoding or effects.
      if (
        classifyForumOperation(operation) !== 'canonical' ||
        operation.kind !== kind
      )
        continue
      const bound = bindForumAuthority(wallet, operation)
      if (!bound.record.lifecycle?.spend) {
        wallet.pool.recordSpendTransaction(operation.leaseIndex, {
          rawTx: operation.rawTx,
          txHash: operation.txHash,
          valueWei: operation.valueWei,
        })
        await wallet.pool.flush()
        const inventory = wallet.inventory ?? wallet.walletState?.inventory
        inventory?.recordSpend(operation.senderAddress, {
          txHash: operation.txHash,
          valueWei: BigInt(operation.valueWei),
        })
      }
      // Status is read-only. If unresolved, SAME-byte replay may broadcast; never sign again.
      try {
        await exchange(wallet, operation, 'post')
      } catch {
        await exchange(wallet, operation, 'put')
      }
      await settle(wallet, operation, admitted)
    }
  }, admission)
}

interface ForumSubmissionParams {
  kind: 'post' | 'vote'
  target: Uint8Array
  direction: 'up' | 'down'
  burnAddress: string
  value: bigint
  overrides?: MonadTxOverrides
  leaseIndex?: number
  waitForLease?: AcquireLeaseWhenAvailableOptions
  encode: (rawTx: Uint8Array) => Uint8Array
}

async function submitForumOperationAdmitted(
  wallet: EvmWalletHandle,
  params: ForumSubmissionParams,
  admission?: MonadWalletOperationAdmission,
): Promise<{ operation: OutgoingTopicOperation; status: MatchedForumStatus }> {
  requireForumWallet(wallet)
  assertForumAmount(params.value)
  if (!addressEqual(params.burnAddress, wallet.forumBurnAddress!))
    throw new Error('Forum burn policy mismatch')
  if ((await wallet.provider.getNetwork()).chainId !== wallet.forumChainId)
    throw new Error('Forum provider chain mismatch')
  const handle =
    params.leaseIndex !== undefined
      ? wallet.leaseManager.acquireForIndex(params.leaseIndex)
      : params.waitForLease
      ? await acquireLeaseWhenAvailable(
          wallet.leaseManager,
          params.waitForLease,
        )
      : wallet.leaseManager.acquireLease()
  await wallet.leaseManager.flush()
  const inventory = wallet.inventory ?? wallet.walletState?.inventory
  let operation: OutgoingTopicOperation
  try {
    const signer = inventory
      ? inventory.getSigner(
          { branch: 'spend', index: handle.index },
          {
            provider: wallet.provider,
            httpClient: wallet.httpClient,
          },
        )
      : wallet.pool.getSigner(handle.index, {
          provider: wallet.provider,
          httpClient: wallet.httpClient,
        })
    const signed = await signer.buildAndSignCall(
      params.burnAddress,
      params.value,
      hexlify(
        topicBurnCalldata(
          params.direction,
          topicVoteCommitment(wallet.cborNetwork!, params.target),
        ),
      ),
      params.overrides,
    )
    if (signed.value !== params.value)
      throw new Error('Signer returned a different Forum burn value')
    operation = {
      version: 1,
      kind: params.kind,
      writeFormat: 'forum-cbor',
      requestBytes: Array.from(params.encode(getBytes(signed.rawTx))),
      leaseIndex: handle.index,
      senderAddress: signed.from,
      rawTx: signed.rawTx,
      txHash: signed.txHash,
      valueWei: signed.value.toString(),
      direction: params.direction,
      ...(params.kind === 'post'
        ? { payloadHashHex: bare(params.target) }
        : { targetPayloadHashHex: bare(params.target) }),
    } as OutgoingTopicOperation
    bindForumAuthority(wallet, operation)
  } catch (error) {
    wallet.leaseManager.releaseLease(handle, 'unused')
    await wallet.leaseManager.flush()
    throw new BurnNotSentError(
      error instanceof Error ? error.message : String(error),
      error,
    )
  }
  // Once journaled, every failure is uncertainty. Keep exact authority and the occupied lease.
  await wallet.topicOperationJournal!.put(operation)
  wallet.pool.recordSpendTransaction(handle.index, {
    rawTx: operation.rawTx,
    txHash: operation.txHash,
    valueWei: operation.valueWei,
  })
  await wallet.pool.flush()
  inventory?.recordSpend(operation.senderAddress, {
    txHash: operation.txHash,
    valueWei: BigInt(operation.valueWei),
  })
  let status: MatchedForumStatus
  try {
    status = await exchange(wallet, operation, 'put')
  } catch (error) {
    throw new ForumOperationPendingError(
      `Forum operation retained pending: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  await settle(wallet, operation, admission, handle)
  return { operation, status }
}

/** All mutations use the same wallet admission, including direct helper callers. */
export async function submitForumOperation(
  wallet: EvmWalletHandle,
  params: ForumSubmissionParams,
  admission?: MonadWalletOperationAdmission,
): Promise<{ operation: OutgoingTopicOperation; status: MatchedForumStatus }> {
  requireForumWallet(wallet)
  return wallet.walletState!.runOperation(
    admitted => submitForumOperationAdmitted(wallet, params, admitted),
    admission,
  )
}
