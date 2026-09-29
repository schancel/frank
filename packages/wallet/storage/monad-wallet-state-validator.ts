import {
  Transaction,
  computeAddress,
  getAddress,
  getBytes,
  hexlify,
  sha256,
} from 'ethers'

import type { MonadSubAccountPool } from '../monad-account-pool'
import type { MonadChangePool } from '../monad-change-pool'
import type { MonadChangeKeyring } from '../monad-change-keyring'
import type { MonadHdKeyring } from '../monad-hd-keyring'
import {
  buildMonadStampCalldata,
  computeMonadStampPaymentCommitment,
  decodeMonadStampedMessage,
  assertMonadStampPaymentCount,
} from '../monad-stamp-client'
import { deriveMonadStampChildPublic } from '../monad-stamp-stealth'
import type { StampAttemptJournal } from './stamp-attempt-journal'
import type { StampPaymentJournal } from './stamp-payment-journal'
import { assertSubAccountLifecycleMatrix } from './sub-account-pool-storage'

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  )
}

function normalizedHash(value: string): string {
  return value.toLowerCase().replace(/^0x/, '')
}

function parseSignedTransaction(rawTx: string, label: string): Transaction {
  let transaction: Transaction
  try {
    transaction = Transaction.from(rawTx)
  } catch {
    throw new Error(`Invalid ${label} raw transaction`)
  }
  if (transaction.hash === null || transaction.from === null) {
    throw new Error(`Invalid ${label}: transaction is unsigned`)
  }
  if (!equalBytes(getBytes(transaction.serialized), getBytes(rawTx))) {
    throw new Error(`Invalid ${label}: non-canonical raw transaction`)
  }
  return transaction
}

function assertTransactionCheckpoint(params: {
  rawTx: string
  txHash: string
  valueWei: string
  label: string
  sender?: string
  destination?: string
}): Transaction {
  const transaction = parseSignedTransaction(params.rawTx, params.label)
  if (
    normalizedHash(transaction.hash as string) !== normalizedHash(params.txHash)
  ) {
    throw new Error(`Invalid ${params.label}: transaction hash mismatch`)
  }
  if (transaction.value.toString() !== params.valueWei) {
    throw new Error(`Invalid ${params.label}: transaction value mismatch`)
  }
  if (
    params.sender !== undefined &&
    getAddress(transaction.from as string) !== getAddress(params.sender)
  ) {
    throw new Error(`Invalid ${params.label}: transaction sender mismatch`)
  }
  if (
    params.destination !== undefined &&
    (transaction.to === null ||
      getAddress(transaction.to) !== getAddress(params.destination))
  ) {
    throw new Error(`Invalid ${params.label}: transaction destination mismatch`)
  }
  return transaction
}

/** Network-free semantic boundary for a complete wallet state. It is intentionally shared by
 * initial bundle loading and the retry path, so a row that changes after open cannot be reserved
 * or submitted merely because it passed a weaker startup-only schema check. */
export function validateMonadWalletState(params: {
  pool: MonadSubAccountPool
  changePool: MonadChangePool
  attemptJournal: StampAttemptJournal
  paymentJournal: StampPaymentJournal
  subKeyring: MonadHdKeyring
  changeKeyring: MonadChangeKeyring
  allowMissingAttemptSpend?: boolean
  allowMissingAttemptRows?: boolean
  allowMissingChangeRecovery?: boolean
}): void {
  const recordSnapshot = params.pool.records()
  const checkpointSnapshot = params.pool.terminalCheckpoints()
  const changeSnapshot = params.changePool.records()
  const recoveredChangeSnapshot = params.changePool.recoveredAccounts()
  const records = new Map(
    recordSnapshot.map((record) => [record.index, record])
  )
  const checkpoints = new Map(
    checkpointSnapshot.map((checkpoint) => [checkpoint.index, checkpoint])
  )

  for (const record of recordSnapshot) {
    assertSubAccountLifecycleMatrix(record)
    if (record.fundingAttempt !== undefined) {
      const transaction = parseSignedTransaction(
        record.fundingAttempt.rawTx,
        `sub-account ${record.index} funding attempt`
      )
      if (
        normalizedHash(transaction.hash as string) !==
          normalizedHash(record.fundingAttempt.txHash) ||
        transaction.to === null ||
        getAddress(transaction.to) !== getAddress(record.address)
      ) {
        throw new Error(
          `Invalid sub-account ${record.index} funding attempt transaction`
        )
      }
    }
    if (record.lifecycle?.funding !== undefined) {
      assertTransactionCheckpoint({
        ...record.lifecycle.funding,
        label: `sub-account ${record.index} funding`,
        destination: record.address,
      })
    }
    if (record.lifecycle?.spend !== undefined) {
      assertTransactionCheckpoint({
        ...record.lifecycle.spend,
        label: `sub-account ${record.index} spend`,
        sender: record.address,
      })
    }
  }

  for (const checkpoint of checkpointSnapshot) {
    assertTransactionCheckpoint({
      ...checkpoint.lifecycle.funding,
      label: `checkpoint ${checkpoint.index} funding`,
      destination: checkpoint.address,
    })
    assertTransactionCheckpoint({
      ...checkpoint.lifecycle.spend,
      label: `checkpoint ${checkpoint.index} spend`,
      sender: checkpoint.address,
    })
  }

  const attemptKeys = new Set<string>()
  for (const attempt of params.attemptJournal.getAll()) {
    const attemptHash = normalizedHash(attempt.payloadHashHex)
    if (attemptKeys.has(attemptHash)) {
      throw new Error(`Duplicate stamp attempt ${attempt.payloadHashHex}`)
    }
    attemptKeys.add(attemptHash)
    if (attempt.recipientPublicKeyHex === undefined) {
      throw new Error('Stamp-attempt recipient public key is unresolved')
    }
    const recipientPublicKey = getBytes(attempt.recipientPublicKeyHex)
    if (recipientPublicKey.length !== 33) {
      throw new Error('Invalid stamp-attempt recipient public key')
    }
    const message = decodeMonadStampedMessage(
      Uint8Array.from(attempt.messageBytes)
    )
    assertMonadStampPaymentCount(message.stampPayments.length)
    const payloadHash = getBytes(sha256(message.encryptedPayload))
    if (
      normalizedHash(hexlify(message.payloadHash)) !== attemptHash ||
      !equalBytes(message.payloadHash, payloadHash)
    ) {
      throw new Error('Stamp-attempt payload hash does not match its message')
    }
    if (
      message.stampPayments.length !== attempt.leaseIndices.length ||
      new Set(attempt.leaseIndices).size !== attempt.leaseIndices.length
    ) {
      throw new Error('Stamp-attempt payment/lease cardinality mismatch')
    }
    for (const [offset, payment] of message.stampPayments.entries()) {
      if (payment.childIndex !== offset) {
        throw new Error('Stamp-attempt payment child order mismatch')
      }
      const leaseIndex = attempt.leaseIndices[offset]
      const record = records.get(leaseIndex)
      if (record === undefined && !params.allowMissingAttemptRows) {
        throw new Error(
          `Stamp attempt references missing sub-account ${leaseIndex}`
        )
      }
      const rawTx = hexlify(payment.rawTx)
      const transaction = parseSignedTransaction(
        rawTx,
        `stamp-attempt payment ${offset}`
      )
      const destination = deriveMonadStampChildPublic({
        payloadHash,
        recipientPublicKey,
        paymentIndex: offset,
      }).address
      if (
        getAddress(transaction.from as string) !==
          params.subKeyring.deriveSubAccount(leaseIndex).address ||
        transaction.to === null ||
        getAddress(transaction.to) !== getAddress(destination) ||
        transaction.data.toLowerCase() !==
          buildMonadStampCalldata(
            computeMonadStampPaymentCommitment(payloadHash, offset)
          ).toLowerCase()
      ) {
        throw new Error(`Invalid stamp-attempt payment ${offset} semantics`)
      }
      const spend = record?.lifecycle?.spend
      if (spend === undefined && params.allowMissingAttemptSpend) continue
      if (
        spend === undefined ||
        normalizedHash(spend.txHash) !==
          normalizedHash(transaction.hash as string) ||
        spend.valueWei !== transaction.value.toString() ||
        !equalBytes(getBytes(spend.rawTx), getBytes(rawTx))
      ) {
        throw new Error(
          `Stamp-attempt payment ${offset} does not match its durable spend`
        )
      }
    }
  }

  const pending = params.changePool.pendingIntent()
  if (pending !== undefined) {
    const source = records.get(pending.sourceBurnIndex)
    const highestChangeIndex = [
      ...changeSnapshot,
      ...recoveredChangeSnapshot,
    ].reduce((highest, record) => Math.max(highest, record.index), -1)
    if (
      source === undefined ||
      getAddress(source.address) !== getAddress(pending.sourceBurnAddress) ||
      getAddress(pending.address) !==
        params.changeKeyring.deriveChangeAccount(pending.index).address ||
      pending.index !== params.changePool.nextUnusedIndex() ||
      pending.index <= highestChangeIndex ||
      params.changePool.getRecord(pending.index) !== undefined ||
      params.changePool.getBySourceBurnIndex(pending.sourceBurnIndex) !==
        undefined
    ) {
      throw new Error('Invalid pending change intent cross-reference')
    }
    assertTransactionCheckpoint({
      rawTx: pending.rawTx,
      txHash: pending.txHash,
      valueWei: pending.sweptValueWei,
      label: 'pending change intent',
      sender: pending.sourceBurnAddress,
      destination: pending.address,
    })
  }

  for (const change of changeSnapshot) {
    assertTransactionCheckpoint({
      rawTx: change.rawTx,
      txHash: change.txHash,
      valueWei: change.sweptValueWei,
      label: `change account ${change.index} funding`,
      sender: change.sourceBurnAddress,
      destination: change.address,
    })
    const source =
      records.get(change.sourceBurnIndex) ??
      checkpoints.get(change.sourceBurnIndex)
    const recovery = source?.lifecycle?.recovery
    if (
      source === undefined ||
      getAddress(source.address) !== getAddress(change.sourceBurnAddress)
    ) {
      throw new Error('Invalid finalized change source authority')
    }
    if (recovery === undefined && params.allowMissingChangeRecovery) continue
    if (
      recovery?.kind !== 'change' ||
      recovery.changeIndex !== change.index ||
      normalizedHash(recovery.txHash) !== normalizedHash(change.txHash) ||
      recovery.valueWei !== change.sweptValueWei ||
      getAddress(recovery.address) !== getAddress(change.address)
    ) {
      throw new Error('Invalid finalized change recovery disposition')
    }
  }

  const finalizedChangeIndices = new Set(
    changeSnapshot.map((record) => record.index)
  )
  for (const [offset, recovered] of recoveredChangeSnapshot.entries()) {
    if (
      typeof recovered.index !== 'number' ||
      !Number.isSafeInteger(recovered.index) ||
      recovered.index < 0 ||
      recovered.index !== offset ||
      typeof recovered.address !== 'string' ||
      typeof recovered.nonce !== 'number' ||
      !Number.isSafeInteger(recovered.nonce) ||
      recovered.nonce < 0 ||
      typeof recovered.balanceWei !== 'string' ||
      !/^\d+$/.test(recovered.balanceWei) ||
      (recovered.nonce === 0 && BigInt(recovered.balanceWei) === BigInt(0)) ||
      finalizedChangeIndices.has(recovered.index) ||
      getAddress(recovered.address) !==
        params.changeKeyring.deriveChangeAccount(recovered.index).address
    ) {
      throw new Error(`Invalid recovered change account ${offset}`)
    }
  }
  if (
    recoveredChangeSnapshot.length > 0 &&
    params.changePool.nextUnusedIndex() < recoveredChangeSnapshot.length
  ) {
    throw new Error('Recovered change high-water mark moved backward')
  }

  for (const payment of params.paymentJournal.getAll()) {
    const recipientPublicKey = getBytes(payment.recipientPublicKeyHex)
    if (
      getAddress(computeAddress(hexlify(recipientPublicKey))) !==
      getAddress(payment.envelopeRecipientAddress)
    ) {
      throw new Error('Stamp-payment recipient key does not match its envelope')
    }
    const destination = deriveMonadStampChildPublic({
      payloadHash: getBytes(`0x${payment.payloadHashHex}`),
      recipientPublicKey,
      paymentIndex: payment.childIndex,
    }).address
    const incoming = assertTransactionCheckpoint({
      rawTx: payment.rawTx,
      txHash: payment.txHash,
      valueWei: payment.valueWei,
      label: `stamp-payment ${payment.payloadHashHex}:${payment.childIndex}`,
      destination,
    })
    if (
      getAddress(payment.address) !== getAddress(destination) ||
      incoming.data.toLowerCase() !==
        buildMonadStampCalldata(
          computeMonadStampPaymentCommitment(
            getBytes(`0x${payment.payloadHashHex}`),
            payment.childIndex
          )
        ).toLowerCase()
    ) {
      throw new Error('Invalid stamp-payment recovery authority')
    }
    if (payment.status !== 'discovered') {
      assertTransactionCheckpoint({
        rawTx: payment.sweepRawTx as string,
        txHash: payment.sweepTxHash as string,
        valueWei: payment.sweepValueWei as string,
        label: `stamp-payment ${payment.payloadHashHex}:${payment.childIndex} sweep`,
        sender: payment.address,
        destination: payment.sweepDestinationAddress as string,
      })
    }
    for (const [index, failed] of (payment.failedSweeps ?? []).entries()) {
      assertTransactionCheckpoint({
        rawTx: failed.rawTx,
        txHash: failed.txHash,
        valueWei: failed.valueWei,
        label: `stamp-payment ${payment.payloadHashHex}:${payment.childIndex} failed sweep ${index}`,
        sender: payment.address,
        destination: failed.destinationAddress,
      })
    }
  }
}
