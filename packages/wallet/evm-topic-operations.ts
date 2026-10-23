/** EVM adapter for the family-neutral Forum operation capability. */
import { getBytes, hexlify, isCallException, Transaction } from 'ethers'
import { topicBurnCalldata } from '@frank/codec'
import type { EvmWalletHandle } from './evm-wallet-handle'
import type { EvmWalletOperationAdmission } from './storage/evm-wallet-bundle'
import type {
  MonadAccountTxSigner,
  MonadTxOverrides,
  SignedMonadTx,
} from './evm-account-tx'
import {
  requireForumWallet,
  reconcileForumOperations,
  submitForumOperation,
  ForumOperationPendingError,
} from './evm-forum-operation'
import { TopicOperationPendingError } from './topic-operations'
import type {
  TopicOperationCapability,
  TopicVoteDirection,
} from './topic-operations'

export const EVM_TOPIC_VOTE_CALLDATA_LENGTH = 38
export const buildCborTopicVoteCalldata = (
  direction: TopicVoteDirection,
  commitment: Uint8Array,
): string => hexlify(topicBurnCalldata(direction, commitment))

/** Quote the legacy gas reserve for external callers that still prepare a standalone burn. */
export async function quoteEvmTopicBurnGasReserve(params: {
  signer: MonadAccountTxSigner
  burnAddress: string
  overrides?: MonadTxOverrides
}): Promise<bigint> {
  const calldata = buildCborTopicVoteCalldata(
    'up',
    new Uint8Array(32).fill(0xff),
  )
  let probe: SignedMonadTx
  try {
    probe = await params.signer.buildAndSignCall(
      params.burnAddress,
      1n,
      calldata,
      params.overrides,
    )
  } catch (err) {
    if (
      params.overrides?.gasLimit === undefined &&
      (isCallException(err) ||
        (err instanceof Error &&
          /missing revert data|CALL_EXCEPTION|insufficient balance/i.test(
            err.message,
          )))
    ) {
      const calldataBytes = getBytes(calldata)
      const fallbackGasLimit =
        21000n + BigInt(calldataBytes.length * 16) + 10000n
      probe = await params.signer.buildAndSignCall(
        params.burnAddress,
        1n,
        calldata,
        { ...params.overrides, gasLimit: fallbackGasLimit },
      )
    } else throw err
  }
  const fee = probe.maxFeePerGas ?? probe.gasPrice
  if (fee === undefined)
    throw new Error('Unable to determine a maximum fee for a topic burn')
  return (probe.gasLimit * fee * 5n) / 4n
}

/** Bind configuration and custody once; generic clients never see addresses, nonces or gas. */
export function createEvmTopicOperations(
  wallet: EvmWalletHandle,
  admission?: EvmWalletOperationAdmission,
): TopicOperationCapability {
  requireForumWallet(wallet)
  const chainIdentifier = wallet.cborNetwork!
  const burnAddress = wallet.forumBurnAddress!
  const identity = wallet.identity
  return {
    chainIdentifier,
    ...(identity
      ? {
          author: {
            account: {
              keyType: 1,
              keyBytes: new Uint8Array(identity.compressedPubKey),
            },
            signDigest: (digest: Uint8Array) =>
              new Uint8Array(identity.signHash(Buffer.from(digest))),
          },
        }
      : {}),
    async submit(request) {
      try {
        const { operation, status } = await submitForumOperation(
          wallet,
          {
            kind: request.kind,
            target: request.target,
            direction: request.direction,
            value: request.amountAtomic,
            burnAddress,
            operationId: request.operationId,
            postFrame: request.postFrame,
          },
          admission,
        )
        return {
          transactionSetHash: operation.transactionSetHash,
          transactionHashes: operation.rawTransactions.map(
            raw => Transaction.from(raw).hash!,
          ),
          status,
        }
      } catch (error) {
        if (error instanceof ForumOperationPendingError)
          throw new TopicOperationPendingError(error.message, error)
        throw error
      }
    },
    reconcile: kind => reconcileForumOperations(wallet, kind, admission),
  }
}
